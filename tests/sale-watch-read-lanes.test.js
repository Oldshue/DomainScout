'use strict';

// Production-shaped regressions for 2026-11-07: right after boot the Probably
// sold page took 4-30 s over HTTP and /api/sale-watch/freshness answered 503
// db-read-worker-timeout every time, because sale-watch.page, the ~18 s
// full-history census (sale-watch.coverage), sale-watch.candidates and the
// freshness contract shared one read lane. Real db-read workers on a
// file-backed sale_watch.db; timing limits come from the idle-control helper.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');

const recon = require('../server/sale-watch-reconstruction');
const keys = require('../server/sale-watch-candidate-keys');
const fresh = require('../server/sale-watch-freshness');
const { createDbReadPool } = require('../server/db-read-pool');
const { startLagControl } = require('./fixtures/loop-lag-control-client');

const repo = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(repo, 'server', 'index.js'), 'utf8');

function openFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-lanes-'));
  const file = path.join(dir, 'sale_watch.db');
  const db = new Database(file);
  db.pragma('busy_timeout = 30000');
  recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  const ins = db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, probe_priority, evidence_json, updated_at)
    VALUES (?, '2026-11-01', '2026-11-02', 'zone-seller-departure', '2026-11-02', 'exited', '2026-11-08T00:00:00.000Z', 0, 1, ?, '2026-11-02T00:00:00Z')`);
  db.transaction(() => { for (let i = 0; i < 2000; i += 1) ins.run(`n${String(i).padStart(5, '0')}.com`, JSON.stringify({ discovery: { movement: { previousClass: i % 40 ? 'parking' : 'seller' } } })); })();
  return { db, dir, file };
}

function markBackfillIncomplete(db) {
  db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES('candidate_keys', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify({ version: keys.KEY_VERSION, rid: 14000, maxRid: 1300000, complete: false, rowsPerSec: 40 }));
}

// The same lane names and per-lane limits server/index.js wires into the pool.
function realPool(file) {
  const created = [];
  const pool = createDbReadPool({
    laneFor: (_sql, hint) => hint,
    laneLimits: { 'sale-watch': 8, 'sale-watch-freshness': 4, 'sale-watch-heavy': 6 },
    createWorker: () => { const w = new Worker(path.join(repo, 'server', 'db-read-worker.js'), { workerData: { dbPath: file } }); created.push(w); return w; },
  });
  return { pool, close: () => Promise.all(created.map(w => w.terminate().catch(() => null))) };
}

// A census-sized read: several seconds of uncancellable work on one worker.
const SLOW_CENSUS = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 40000000) SELECT COUNT(*) AS n FROM c';

test('server/index.js routes the census and candidate tape to the heavy lane and freshness to its own lane', () => {
  assert.match(server, /dbReadQuery\(null,query,20000,'sale-watch','sale-watch\.page'\)/);
  assert.match(server, /dbReadQuery\(null,\{\},20000,'sale-watch-heavy','sale-watch\.coverage'\)/);
  assert.match(server, /dbReadQuery\(null,query,20000,'sale-watch-heavy','sale-watch\.candidates'\)/);
  assert.match(server, /'sale-watch-freshness', 'sale-watch\.freshness'\)/);
  assert.doesNotMatch(server, /'sale-watch',\s*'sale-watch\.(coverage|candidates|freshness)'/);
  assert.match(server, /laneLimits:\s*\{[^}]*'sale-watch-heavy'/);
});

test('with a slow census running on the heavy lane, the page and freshness answer promptly', async () => {
  const { db, dir, file } = openFixture();
  db.close();
  const { pool, close } = realPool(file);
  try {
    // Warm each lane's worker (opening the database is not what is measured).
    await pool.query('SELECT 1 AS ok', {}, 20000, 'sale-watch');
    await pool.query(null, { dataDir: dir }, 20000, 'sale-watch-freshness', 'sale-watch.freshness');
    const control = startLagControl();
    let censusDone = 0;
    const census = pool.query(SLOW_CENSUS, {}, 120000, 'sale-watch-heavy').then(rows => { censusDone = Date.now(); return rows; });
    await new Promise(r => setTimeout(r, 200)); // the census is executing
    const t0 = Date.now();
    const page = await pool.query("SELECT domain FROM sale_watch_candidates WHERE exit_observed_day >= '2026-11-01' ORDER BY exit_observed_day DESC, domain LIMIT 50", {}, 20000, 'sale-watch');
    const pageMs = Date.now() - t0;
    const t1 = Date.now();
    const parts = await pool.query(null, { dataDir: dir }, 20000, 'sale-watch-freshness', 'sale-watch.freshness');
    const freshMs = Date.now() - t1;
    const limit = await control.limit();
    assert.equal(page.length, 50);
    assert.ok(parts && parts.now, 'freshness parts were read');
    assert.equal(censusDone, 0, 'the census was still running while the page and freshness answered');
    assert.ok(pageMs < 1000 + limit, `page ${pageMs} ms (limit ${1000 + limit})`);
    assert.ok(freshMs < 2000 + limit, `freshness ${freshMs} ms (limit ${2000 + limit})`);
    assert.equal((await census)[0].n, 40000000);
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a full heavy lane rejects busy at once without touching the interactive lanes', async () => {
  const pool = createDbReadPool({
    laneFor: (_s, h) => h,
    laneLimits: { 'sale-watch-heavy': 2, 'sale-watch': 8 },
    createWorker: () => { const { EventEmitter } = require('node:events'); const w = new EventEmitter(); w.postMessage = m => { if (!String(m.sql).startsWith('hang')) setImmediate(() => w.emit('message', { id: m.id, ok: true, rows: [] })); }; w.terminate = async () => 0; return w; },
  });
  pool.query('hang:1', {}, 60000, 'sale-watch-heavy').catch(() => null);
  pool.query('hang:2', {}, 60000, 'sale-watch-heavy').catch(() => null);
  await assert.rejects(pool.query('hang:3', {}, 60000, 'sale-watch-heavy'), err => err.code === 'DB_READ_LANE_BUSY' && err.lane === 'sale-watch-heavy');
  assert.deepEqual(await pool.query('ok', {}, 1000, 'sale-watch'), []);
  assert.equal(pool.laneDepths()['sale-watch-heavy'], 2);
});

test('freshness during an incomplete candidate-keys backfill reports the part pending, without a timeout', async () => {
  const { db, dir, file } = openFixture();
  markBackfillIncomplete(db);
  db.close();
  const { pool, close } = realPool(file);
  try {
    const t0 = Date.now();
    const parts = await pool.query(null, { dataDir: dir, now: '2026-11-07T10:00:00.000Z' }, 20000, 'sale-watch-freshness', 'sale-watch.freshness');
    const ms = Date.now() - t0;
    assert.ok(ms < 20000, `answered in ${ms} ms`);
    assert.equal(parts.sellerBacklog.ready, false);
    assert.equal(parts.sellerBacklog.progress.rid, 14000);
    const result = fresh.evaluateFreshness(parts, { now: parts.now });
    const check = result.checks.find(c => c.name === 'seller-backlog');
    assert.equal(check.status, 'pending', JSON.stringify(check));
    assert.ok(result.pending.includes('seller-backlog'));
    assert.ok(!result.reasons.some(r => r.startsWith('seller-backlog')), 'a pending part is not a failing reason');
    // Pending alone never raises the verdict.
    const only = fresh.evaluateFreshness({ now: parts.now, sellerBacklog: parts.sellerBacklog }, { now: parts.now }).checks.find(c => c.name === 'seller-backlog');
    assert.equal(only.status, 'pending');
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function freshnessRoute(loader) {
  const { registerSaleWatchRoutes } = require('../server/sale-watch');
  const routes = new Map();
  registerSaleWatchRoutes({ get(p, h) { routes.set(p, h); }, post() {} }, { reconstructionLoader: async () => [], freshnessLoader: loader });
  const out = { status: 200, body: null };
  const res = { set() {}, status(s) { out.status = s; return this; }, json(b) { out.body = b; } };
  return { call: async () => { out.status = 200; await routes.get('/api/sale-watch/freshness')({ query: {} }, res); return { ...out }; } };
}

test('a 20 s read-worker timeout or a busy lane never produces a stale verdict', async () => {
  const watchdog = require('../bin/sale-watch-watchdog');
  for (const error of [new Error('db-read-worker-timeout'), Object.assign(new Error('Analysis is busy; retry shortly'), { code: 'DB_READ_LANE_BUSY' }), new Error('db-read-worker-retired')]) {
    const route = await freshnessRoute(async () => { throw error; });
    const r = await route.call();
    assert.equal(r.status, 200, error.message);
    assert.notEqual(r.body.verdict, 'stale', error.message);
    assert.equal(r.body.schema, fresh.SCHEMA);
    assert.ok(r.body.pending.includes('freshness-read'));
    assert.equal(watchdog.readPending({ body: r.body }), true, 'the watchdog neither requests a wave nor restarts');
    assert.equal(watchdog.restartReason({ kind: 'answered', verdict: r.body.verdict, body: r.body }, { restarts: [] }, Date.now()), null);
  }
  // After a real verdict, a timeout serves it marked refreshing (the watchdog may act on it).
  let fail = false;
  const healthyParts = { now: new Date().toISOString(), wave: null };
  const route = await freshnessRoute(async () => { if (fail) throw new Error('db-read-worker-timeout'); return healthyParts; });
  const first = await route.call();
  fail = true;
  const second = await route.call();
  assert.equal(second.body.verdict, first.body.verdict);
  assert.equal(second.body.refreshing, true);
  assert.equal(second.body.verdictFromReads, true);
  // A genuine store failure still answers 503 stale.
  const broken = await freshnessRoute(async () => { throw new Error('no such table: sale_watch_wave_runs'); });
  const b = await broken.call();
  assert.equal(b.status, 503);
  assert.equal(b.body.verdict, 'stale');
});
