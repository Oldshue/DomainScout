'use strict';

// Production-shaped regressions for the 2026-11-07 outage: the first wave ran
// on the HTTP thread with the main sale_watch.db handle, a synchronous stage
// sat in disk wait and /api/health stopped answering. Waves now run in a
// supervised child process with their own handle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');

const recon = require('../server/sale-watch-reconstruction');
const store = require('../server/sale-watch-assessments');
const { superviseWave } = require('../server/sale-watch-wave-supervisor');
const { VERSION } = require('../server/sale-watch-evidence');

const HOOK = path.join(__dirname, 'fixtures', 'sale-watch-wave-hooks.js');
const ENV = { ...process.env, DOMAINSCOUT_SALE_WATCH_WAVE_TEST_HOOKS: '1' };
const NOW = '2026-11-07T12:00:00.000Z';
const quiet = { log() {}, warn() {} };

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-wave-sup-'));
  const dbPath = path.join(dir, 'sale_watch.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 30000');
  recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  return { dbPath, db };
}

// Max observed event-loop lag (ms) on THIS (main) thread while fn runs.
async function maxLagDuring(fn) {
  let max = 0;
  let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last - 10); last = now; }, 10);
  try { return { value: await fn(), lag: () => max }; } finally { clearInterval(timer); }
}

test('the event loop stays under 100 ms while an off-main wave runs a large backlog and a synchronously slow stage', async () => {
  const { dbPath, db } = tmpDb();
  // Timers fire 100-200 ms late on a loaded host with nothing blocking; the
  // scenario's 1.5 s synchronous stage fails this limit if it reaches this thread.
  const lagLimit = 400;
  const { value: summary, lag } = await maxLagDuring(() => superviseWave({
    dbPath, env: ENV, log: quiet, testHook: HOOK, heartbeatMs: 100, hangMs: 30000,
    options: { testScenario: 'backlog', backlogRows: 20000, now: NOW, skipTransferScreen: true, skipPostProbeAssess: true },
  }));
  assert.ok(lag() < lagLimit, `main-thread lag ${lag()}ms (limit ${lagLimit}ms)`);
  assert.equal(summary.ran, undefined, JSON.stringify(summary).slice(0, 400));
  assert.deepEqual(summary.stageErrors, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sale_watch_candidates WHERE domain LIKE 'backlog%'").get().n, 20000, 'the child wrote through its own handle');
  const run = db.prepare('SELECT finished_at, reason FROM sale_watch_wave_runs ORDER BY id DESC LIMIT 1').get();
  assert.ok(run.finished_at);
  assert.equal(run.reason, null);
  db.close();
});

test('a hung wave is terminated by the supervisor and recorded while HTTP keeps answering', async () => {
  const { dbPath, db } = tmpDb();
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  const wave = superviseWave({ dbPath, env: ENV, log: quiet, testHook: HOOK, heartbeatMs: 100, hangMs: 1500, recordTimeoutMs: 20000,
    options: { testScenario: 'hang', now: NOW, skipTransferScreen: true, skipPostProbeAssess: true } });
  let answered = 0;
  let settled = false;
  wave.finally(() => { settled = true; });
  const started = Date.now();
  while (!settled && Date.now() - started < 30000) {
    const t0 = Date.now();
    const body = await (await fetch(url)).text();
    assert.equal(body, 'ok');
    assert.ok(Date.now() - t0 < 1000, 'health answered promptly');
    answered += 1;
    await new Promise(r => setTimeout(r, 100));
  }
  const result = await wave;
  server.close();
  assert.equal(result.reason, 'terminated', JSON.stringify(result));
  assert.ok(answered >= 5, `HTTP answered ${answered} times during the hang`);
  assert.ok(result.recorded >= 1, 'termination recorded');
  const run = db.prepare('SELECT finished_at, reason, summary_json FROM sale_watch_wave_runs ORDER BY id DESC LIMIT 1').get();
  assert.ok(run.finished_at);
  assert.equal(run.reason, 'abandoned');
  assert.match(run.summary_json, /WAVE_TERMINATED/);
  assert.equal(recon.waveHealth(db).healthy, false);
  db.close();
});

test('a writer that hits database is locked backs off, retries and completes', async () => {
  const { dbPath, db: holder } = tmpDb();
  const writer = new Database(dbPath);
  writer.pragma('busy_timeout = 0');
  holder.prepare('BEGIN IMMEDIATE').run();
  setTimeout(() => holder.prepare('COMMIT').run(), 300);
  const stats = {};
  await recon.withLockRetry('ingest.movement', () => writer.prepare("INSERT INTO sale_watch_wave_runs(started_at, stage) VALUES('x','ingest')").run(), { backoffMs: 100, retries: 8, stats });
  assert.ok(stats.lockRetries >= 1, 'retried at least once');
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM sale_watch_wave_runs WHERE started_at='x'").get().n, 1);
  writer.close();
  holder.close();
});

test('movement intake that hits a lock is retried inside the wave, not skipped', async () => {
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  let calls = 0;
  const summary = await recon.runProbeWave(db, {
    now: NOW, skipRdapSweep: true, skipTransferScreen: true, skipPostProbeAssess: true, lockRetry: { backoffMs: 5 },
    ingestDiscoveryCandidates: () => ({ queued: 0, scanned: 0 }),
    ingestMovementCandidates: () => { calls += 1; if (calls === 1) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); return { queued: 3 }; },
    markAdoptionKits: () => ({ members: 0 }),
  });
  assert.equal(calls, 2);
  assert.equal(summary.ingest.movement.queued, 3);
  assert.equal(summary.lockRetries, 1);
  assert.ok(!summary.stageErrors.some(e => e.stage === 'ingest.movement'));
  db.close();
});

test('the -wal file shrinks after an off-main wave on a file-backed database, and health reports its size', async () => {
  const { dbPath, db } = tmpDb();
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE IF NOT EXISTS filler(x)');
  const ins = db.prepare('INSERT INTO filler VALUES (?)');
  db.transaction(() => { for (let i = 0; i < 40000; i += 1) ins.run('y'.repeat(300)); })();
  const before = recon.walFileBytes(db);
  assert.ok(before > 8 * 1024 * 1024, `wal grew to ${before}`);
  const summary = await superviseWave({ dbPath, env: ENV, log: quiet, testHook: HOOK, heartbeatMs: 100, hangMs: 30000,
    options: { testScenario: 'quick', now: NOW, skipRdapSweep: true, skipTransferScreen: true, skipPostProbeAssess: true } });
  assert.ok(Array.isArray(summary.walCheckpoints) && summary.walCheckpoints.length > 0, 'checkpointed between stages');
  assert.ok(summary.wal && summary.wal.mode === 'TRUNCATE');
  const after = recon.walFileBytes(db);
  assert.ok(after < 1024 * 1024, `wal shrank from ${before} to ${after}`);
  const health = recon.waveHealth(db);
  assert.equal(health.walBytes, after);
  assert.equal(health.walOverLimit, false);
  db.close();
});

test('high-signal window rows are reassessed before newer unconfirmed rows', async () => {
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  const ins = db.prepare(`INSERT INTO sale_watch_candidates (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 1, ?, ?)`);
  const row = (domain, day, discovery, extra = {}) => ins.run(domain, day, day, day, day,
    JSON.stringify({ domain, sellerNameservers: ['ns1.sedoparking.com'], buyerNameservers: ['ns1.host.example'], discovery: { departureDate: day, ...discovery }, ...extra }), `${day}T00:00:00Z`);
  for (let i = 0; i < 30; i += 1) row(`plain${i}.com`, '2026-11-06', {});
  row('buyer-use.com', '2026-10-20', { buyerUse: true });
  row('transfer.com', '2026-10-21', { rdap: { transferAt: '2026-10-21T00:00:00Z' } });
  row('prior-likely.com', '2026-10-22', {}, { classification: 'likely-sale' });
  const result = await store.ensureStoredAssessments(db, { now: new Date(NOW), windowOnly: true, limit: 3, batch: 10, log: null });
  const assessed = db.prepare('SELECT domain FROM sale_watch_assessments WHERE version = ? AND dirty = 0 ORDER BY domain').all(VERSION).map(r => r.domain);
  assert.deepEqual(assessed, ['buyer-use.com', 'prior-likely.com', 'transfer.com'], JSON.stringify(result.phases));
  assert.equal(result.phases[0].phase, 'assess-signal');
  const rest = await store.ensureStoredAssessments(db, { now: new Date(NOW), windowOnly: true, log: null });
  assert.equal(rest.windowComplete, true, 'the remaining rows follow');
  db.close();
});

test('wave writers commit in small transactions so other writers get the lock between commits', async () => {
  const { dbPath, db } = tmpDb();
  const other = new Database(dbPath);
  other.pragma('busy_timeout = 0');
  db.exec('CREATE TABLE IF NOT EXISTS chunked(x)');
  const ins = db.prepare('INSERT INTO chunked VALUES (?)');
  const items = Array.from({ length: 2600 }, (_, i) => i);
  let interleaved = 0;
  const pending = recon.chunkedWriteAsync(db, items, i => ins.run(i));
  // Between chunks the async writer yields; a second connection can commit.
  for (let k = 0; k < 3; k += 1) {
    await new Promise(r => setImmediate(r));
    try { other.prepare("INSERT INTO sale_watch_wave_runs(started_at, stage) VALUES('between','x')").run(); interleaved += 1; } catch (_) { /* lock held */ }
  }
  const chunks = await pending;
  assert.equal(chunks, Math.ceil(2600 / recon.WAVE_WRITE_CHUNK));
  assert.ok(chunks > 1);
  assert.ok(interleaved >= 1, 'another writer committed between wave chunks');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunked').get().n, 2600);
  other.close();
  db.close();
});
