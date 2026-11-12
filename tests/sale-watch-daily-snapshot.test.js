'use strict';

// Sale Watch daily feed snapshot: the route answers from main-process memory
// with the database closed; boot serves the last snapshot file before any
// producer run; a failed rebuild keeps the old snapshot and marks the
// daily-snapshot freshness check; in-memory tapes/paging/search equal the
// database-backed readDaily on the fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let Database = null;
let sqliteSkip = false;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch (error) { sqliteSkip = `better-sqlite3 unavailable: ${error.message.split('\n')[0]}`; }

const recon = require('../server/sale-watch-reconstruction');
const search = require('../server/sale-watch-search');
const store = require('../server/sale-watch-assessments');
const ins = require('../server/sale-watch-insights');
const snap = require('../server/sale-watch-daily-snapshot');
const freshness = require('../server/sale-watch-freshness');

const NOW = new Date('2026-10-28T12:00:00Z');
const TO = '2026-10-28';
const SELLERS = [
  { ns: ['ns1.dan.com', 'ns2.dan.com'], venue: 'Dan.com' },
  { ns: ['ns1.domaincontrol.com', 'ns2.domaincontrol.com'], venue: 'GoDaddy parking' },
];
const SITE = { active: true, parked: false, placeholder: false, status: 200 };
const dayMinus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

function insert(db, domain, day, seller, discovery = {}, extra = {}) {
  const ev = { domain, tier: 'suspected', reportDate: day, venue: seller.venue, sellerNameservers: seller.ns, buyerNameservers: ['ns1.host.example'],
    discovery: { movement: { day, prevDay: day, previousNameservers: seller.ns, currentNameservers: ['ns1.host.example'], source: 'daily-zone-delegation-diff' }, structurallyMoved: true, departureDate: day, priorSiteEvidence: { status: 'parked' }, ...discovery }, ...extra };
  db.prepare(`INSERT INTO sale_watch_candidates (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 1, ?, ?)`).run(domain, day, day, day, day, JSON.stringify(ev), `${day}T06:00:00Z`);
}

function fixture() {
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  for (let d = 0; d < 16; d += 1) {
    const day = dayMinus(TO, d);
    SELLERS.forEach((seller, s) => {
      for (let i = 0; i < 6; i += 1) {
        const tag = `${String.fromCharCode(97 + d)}${String.fromCharCode(97 + s)}${String.fromCharCode(97 + i)}`;
        insert(db, `built${tag}.com`, day, seller, { buyerUse: 1, homepage: { ...SITE, title: `Built${tag} team`, finalUrl: `https://built${tag}.com/` } }, { classification: 'likely-sale', buyerTitle: `Built${tag}` });
        insert(db, `reg${tag}.com`, day, seller, { transferEvidence: { registrarChanged: true, observedAt: `${day}T05:00:00Z` } });
      }
    });
  }
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  store.storeAssessmentsSync(db, { now: NOW });
  ins.ensureInsightSchema(db);
  return db;
}

function fakeApp() {
  const routes = {};
  return { routes, get(p, fn) { routes[p] = fn; } };
}
async function call(app, query) {
  const res = { code: 200, headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await app.routes['/api/sale-watch/daily']({ query }, res);
  return res;
}
const strip = page => JSON.parse(JSON.stringify({ days: page.days, window: page.window || null, next: !!page.pagination.nextCursor, diagnostics: page.diagnostics }));
const silent = { warn() {} };

test('route answers from the in-memory snapshot with the database handle closed', { skip: sqliteSkip }, async () => {
  const db = fixture();
  const built = ins.buildDailySnapshot(db, { now: NOW });
  db.close();
  assert.throws(() => db.prepare('SELECT 1'), 'database is closed');
  const s = snap.createDailySnapshotStore({ build: async () => { throw new Error('database must not be touched'); }, log: silent });
  s._state.snapshot = built;
  const app = fakeApp();
  ins.registerSaleWatchInsightRoutes(app, { dailySnapshot: s, insightDailyLoader: () => { throw new Error('db loader must not run'); } });
  const res = await call(app, { tape: 'aftermarket' });
  assert.equal(res.code, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.generatedAt, built.generatedAt);
  assert.ok(res.body.days.length > 0);
  assert.ok(res.body.days.every(d => d.rows.every(r => r.derived.tape === 'aftermarket')));
  assert.equal(res.body.window.names, built.rows.length);
});

test('boot with an existing snapshot file serves before any producer run; first deploy answers 503 pending and starts the producer', { skip: sqliteSkip }, async () => {
  const db = fixture();
  const built = ins.buildDailySnapshot(db, { now: NOW });
  db.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-snap-'));
  const file = path.join(dir, snap.SNAPSHOT_FILE);
  await snap.writeSnapshotFile(file, built);
  assert.deepEqual(fs.readdirSync(dir), [snap.SNAPSHOT_FILE], 'atomic write leaves no temp file');
  let builds = 0;
  const s = snap.createDailySnapshotStore({ file, build: async () => { builds += 1; return new Promise(() => {}); }, log: silent });
  assert.ok(s.loadFromFile());
  const app = fakeApp();
  ins.registerSaleWatchInsightRoutes(app, { dailySnapshot: s });
  const res = await call(app, {});
  assert.equal(res.code, 200);
  assert.equal(builds, 0, 'served before any producer run');
  assert.equal(res.body.generatedAt, built.generatedAt);
  assert.equal(res.body.ledgerVersion, built.ledgerVersion);

  const empty = snap.createDailySnapshotStore({ file: path.join(dir, 'none.json'), build: async () => { builds += 1; return new Promise(() => {}); }, log: silent });
  assert.equal(empty.loadFromFile(), null);
  const app2 = fakeApp();
  ins.registerSaleWatchInsightRoutes(app2, { dailySnapshot: empty });
  const res2 = await call(app2, {});
  assert.equal(res2.code, 503);
  assert.equal(res2.body.status, 'pending');
  assert.equal(res2.body.producer, 'started');
  assert.equal(builds, 1, 'producer started immediately');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('producer failure keeps the previous snapshot, retries with backoff and marks the daily-snapshot freshness check', async () => {
  let clock = Date.parse('2026-10-28T12:00:00Z');
  const timers = [];
  const old = { schema: ins.SNAPSHOT_SCHEMA, status: 'ready', generatedAt: new Date(clock).toISOString(), ledgerVersion: 'v1', from: '2026-10-15', to: TO, rows: [], truncated: false, readErrors: [] };
  const s = snap.createDailySnapshotStore({ build: async () => { throw new Error('db-read-worker-timeout'); }, now: () => clock, setTimer: (fn, ms) => { timers.push(ms); return { unref() {} }; }, clearTimer() {}, log: silent });
  s._state.snapshot = old;
  const r = await s.refresh('test');
  assert.equal(r.ok, false);
  assert.equal(s.current(), old, 'previous snapshot kept');
  assert.deepEqual(timers, [snap.BACKOFF_MS[0]]);
  await s.refresh('test');
  assert.deepEqual(timers, [snap.BACKOFF_MS[0], snap.BACKOFF_MS[1]], 'backoff grows');
  assert.equal(s.freshnessCheck().status, 'degraded');
  clock += snap.STALE_MS + 60000;
  const check = s.freshnessCheck();
  assert.equal(check.name, 'daily-snapshot');
  assert.equal(check.status, 'stale');
  const result = freshness.evaluateFreshness({}, { now: new Date(clock).toISOString(), extraChecks: [check] });
  assert.ok(result.checks.some(c => c.name === 'daily-snapshot' && c.status === 'stale'));
  assert.equal(result.verdict, 'stale');
  const ok = snap.createDailySnapshotStore({ build: async () => ({ ...old, generatedAt: new Date(clock).toISOString(), ledgerVersion: 'v2' }), now: () => clock, setTimer: () => ({}), clearTimer() {}, log: silent });
  assert.equal((await ok.refresh('test')).ok, true);
  assert.equal(ok.freshnessCheck().status, 'ok');
});

test('in-memory tapes, paging and name search equal the database-backed readDaily on the fixture', { skip: sqliteSkip }, () => {
  const db = fixture();
  const built = ins.buildDailySnapshot(db, { now: NOW });
  const from = built.from;
  for (const tape of ['all', 'aftermarket', 'builder']) {
    for (const q of ['', 'builtaa', 'reg']) {
      let dbCursor = null; let memCursor = null;
      for (let n = 0; n < 50; n += 1) {
        ins._clearWindowCache();
        const a = ins.readDaily(db, { from, to: TO, tape, q, cursor: dbCursor, now: NOW });
        const b = ins.serveDailyFromSnapshot(built, { from, to: TO, tape, q, cursor: memCursor });
        assert.deepEqual(strip(b), strip(a), `tape=${tape} q=${q} page=${n}`);
        dbCursor = a.pagination.nextCursor; memCursor = b.pagination.nextCursor;
        assert.equal(memCursor, dbCursor);
        if (!dbCursor) break;
      }
    }
  }
  db.close();
});


test('a build that throws synchronously does not wedge the producer: the next refresh runs and succeeds', async () => {
  const { createDailySnapshotStore } = require('../server/sale-watch-daily-snapshot');
  let calls = 0;
  const good = { schema: require('../server/sale-watch-insights').SNAPSHOT_SCHEMA, status: 'ready', generatedAt: new Date().toISOString(), ledgerVersion: 'v', from: '2026-10-30', to: '2026-11-12', rows: [] };
  const timers = [];
  const store = createDailySnapshotStore({
    file: null,
    build: () => { calls += 1; if (calls === 1) throw new Error('Sale Watch schema migration is running'); return Promise.resolve(good); },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimer: () => {}, log: { warn() {} },
  });
  const first = await store.refresh('first-request');
  assert.equal(first.ok, false);
  assert.equal(store._state.running, null, 'running must be cleared after a synchronous throw');
  assert.equal(timers.length, 1, 'a retry is scheduled');
  timers[0].fn();
  await store._state.running;
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(store._state.failures, 0);
});
