'use strict';

// Production-shaped regressions for 2026-11-07 (21 GB sale_watch.db, ~1.3 M
// candidates): wave 1162 was killed with "no heartbeat for 604616ms in stage
// searchIndex" while selectDueCandidates blocked the wave child's event loop
// on a cold page cache, and the assess-signal reassessment ran json_extract
// over the whole 30-day window (7 rows/s) with an in-memory cursor that every
// restart lost. All on file-backed databases.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const recon = require('../server/sale-watch-reconstruction');
const store = require('../server/sale-watch-assessments');
const keys = require('../server/sale-watch-candidate-keys');
const { superviseWave } = require('../server/sale-watch-wave-supervisor');
const { VERSION } = require('../server/sale-watch-evidence');

const HOOK = path.join(__dirname, 'fixtures', 'sale-watch-wave-hooks.js');
const ENV = { ...process.env, DOMAINSCOUT_SALE_WATCH_WAVE_TEST_HOOKS: '1' };
const NOW = '2026-11-07T12:00:00.000Z';
const quiet = { log() {}, warn() {} };

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-selection-'));
  return path.join(dir, 'sale_watch.db');
}

function open(dbPath) {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 30000');
  recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  return db;
}

function insert(db, domain, { day = '2026-11-05', state = 'exited', next = '2026-11-06T00:00:00.000Z', probeCount = 0, priority = -90, stream = 'zone-seller-departure', discovery = {}, extra = {} } = {}) {
  const evidence = { domain, sellerNameservers: ['ns1.sedoparking.com'], buyerNameservers: ['ns1.host.example'], discovery: { departureDate: day, ...discovery }, ...extra };
  db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, probe_priority, evidence_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(domain, day, day, stream, day, state, next, probeCount, priority, JSON.stringify(evidence), `${day}T00:00:00Z`);
}

// Records EXPLAIN QUERY PLAN for every SELECT prepared on `db` while active.
function capturePlans(db) {
  const plans = [];
  const orig = db.prepare.bind(db);
  db.prepare = sql => {
    const st = orig(sql);
    if (/^\s*(WITH|SELECT)/i.test(sql)) {
      for (const m of ['all', 'get']) {
        const call = st[m].bind(st);
        st[m] = (...args) => {
          try { plans.push({ sql, detail: orig(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail) }); } catch (_) { /* plan is advisory */ }
          return call(...args);
        };
      }
    }
    return st;
  };
  return { plans, restore: () => { delete db.prepare; } };
}

const scansCandidates = detail => detail.some(d => /^SCAN (sale_watch_candidates|c)\b/.test(d));

function setKeysComplete(db, complete) {
  db.prepare(`UPDATE sale_watch_meta SET value = json_set(value, '$.complete', json(?)) WHERE key = 'candidate_keys'`).run(complete ? 'true' : 'false');
}

function assessedDomains(db) {
  return db.prepare('SELECT domain FROM sale_watch_assessments WHERE version = ? AND dirty = 0 ORDER BY domain').all(VERSION).map(r => r.domain);
}

function dayPlus(day, n) {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('due selection and its wave counts walk the partial due index and never scan sale_watch_candidates', () => {
  const db = open(tmpDbPath());
  for (let i = 0; i < 300; i += 1) {
    insert(db, `due${i}.com`, {
      day: dayPlus('2026-10-20', i % 18), priority: i % 9 === 0 ? -45 : -90 + (i % 7), probeCount: i % 4 === 0 ? 2 : 0,
      stream: i % 5 === 0 ? 'historical-departure' : 'zone-seller-departure',
      discovery: i % 9 === 0 ? { kit: { key: `kit${i % 3}` } } : {},
      extra: i % 11 === 0 ? { classification: 'likely-sale' } : {},
    });
  }
  for (let i = 0; i < 200; i += 1) insert(db, `ruled${i}.com`, { state: 'ruled-out' });
  for (let i = 0; i < 50; i += 1) insert(db, `later${i}.com`, { next: '2026-12-30T00:00:00.000Z' });
  for (let i = 0; i < 30; i += 1) insert(db, `low${i}.xyz`);
  db.exec('ANALYZE');
  assert.equal(keys.candidateKeysReady(db), true);

  const cap = capturePlans(db);
  const due = recon.selectDueCandidates(db, { now: NOW, limit: 120 });
  const backlog = recon.computeEligibleBacklog(db, { now: NOW });
  const health = recon.firstProbeHealth(db, { now: NOW });
  cap.restore();
  assert.equal(due.length, 120);
  assert.ok(due.every(r => typeof r.evidence_json === 'string'), 'full candidate rows are returned');
  const keyPlans = cap.plans.filter(p => /sale_watch_candidate_keys/.test(p.sql));
  assert.ok(keyPlans.length >= 3, `key-table queries ran: ${keyPlans.length}`);
  for (const p of keyPlans) assert.ok(p.detail.some(d => d.includes('USING INDEX idx_sale_watch_candidate_keys_due')), p.detail.join(' | '));
  for (const p of cap.plans) assert.ok(!scansCandidates(p.detail), `${p.sql.slice(0, 120)} => ${p.detail.join(' | ')}`);
  assert.ok(cap.plans.every(p => !/json_extract|sale_watch_kit_key/.test(p.sql)), 'no evidence JSON extraction in due selection');

  // Same rows, order and counts as the legacy (unindexed) queries.
  setKeysComplete(db, false);
  const legacy = recon.selectDueCandidates(db, { now: NOW, limit: 120 }).map(r => r.domain);
  const legacyBacklog = recon.computeEligibleBacklog(db, { now: NOW });
  const legacyHealth = recon.firstProbeHealth(db, { now: NOW });
  setKeysComplete(db, true);
  assert.deepEqual(due.map(r => r.domain), legacy);
  assert.equal(backlog, legacyBacklog);
  assert.deepEqual(health, legacyHealth);
  db.close();
});

test('high-signal reassessment walks the partial signal index without json_extract or a candidates scan', async () => {
  const db = open(tmpDbPath());
  for (let i = 0; i < 60; i += 1) insert(db, `plain${i}.com`, { day: dayPlus('2026-10-15', i % 20), probeCount: 1 });
  const signal = [];
  for (let i = 0; i < 8; i += 1) { insert(db, `buyer${i}.com`, { day: dayPlus('2026-10-12', i), probeCount: 1, discovery: { buyerUse: true } }); signal.push(`buyer${i}.com`); }
  for (let i = 0; i < 4; i += 1) { insert(db, `transfer${i}.com`, { day: dayPlus('2026-10-20', i), probeCount: 1, discovery: { rdap: { transferAt: '2026-10-21T00:00:00Z' } } }); signal.push(`transfer${i}.com`); }
  insert(db, 'old-signal.com', { day: '2026-08-01', probeCount: 1, discovery: { buyerUse: true } });
  db.exec('ANALYZE');
  assert.equal(keys.candidateKeysReady(db), true);
  const cap = capturePlans(db);
  await store.ensureStoredAssessments(db, { now: new Date(NOW), windowOnly: true, limit: signal.length, batch: 5, log: null });
  cap.restore();
  const sig = cap.plans.filter(p => /idx_sale_watch_candidate_keys_signal/.test(p.sql));
  assert.ok(sig.length >= 1, 'the signal phase used the key table');
  for (const p of sig) {
    assert.ok(p.detail.some(d => d.includes('USING INDEX idx_sale_watch_candidate_keys_signal')), p.detail.join(' | '));
    assert.ok(!scansCandidates(p.detail), p.detail.join(' | '));
    assert.ok(!/json_extract|json_valid/.test(p.sql), 'no evidence JSON parsing in the signal selection');
  }
  assert.deepEqual(assessedDomains(db), signal.slice().sort(), 'exactly the in-window high-signal rows were assessed first');
  db.close();
});

test('a restarted reassessment resumes the signal phase where it stopped', async () => {
  const dbPath = tmpDbPath();
  let db = open(dbPath);
  const names = [];
  for (let i = 0; i < 28; i += 1) { const d = `sig${String(i).padStart(2, '0')}.com`; insert(db, d, { day: dayPlus('2026-10-10', i), probeCount: 1, discovery: { buyerUse: true } }); names.push(d); }
  const newestFirst = names.slice().reverse();
  await store.ensureStoredAssessments(db, { now: new Date(NOW), windowOnly: true, limit: 10, batch: 5, log: null });
  assert.deepEqual(assessedDomains(db), newestFirst.slice(0, 10).sort());
  const saved = store.signalCursor(db);
  assert.ok(saved, 'position persisted');
  assert.equal(saved.day, dayPlus('2026-10-10', 18), 'cursor at the last assessed row');
  db.close();

  // Restart: a fresh connection; a newer high-signal row arrived meanwhile.
  db = open(dbPath);
  insert(db, 'arrived-later.com', { day: '2026-11-07', probeCount: 1, discovery: { buyerUse: true } });
  await store.ensureStoredAssessments(db, { now: new Date(NOW), windowOnly: true, limit: 5, batch: 5, log: null });
  assert.deepEqual(assessedDomains(db), newestFirst.slice(0, 15).sort(), 'continued below the saved position, not from the top');
  assert.equal(store.signalCursor(db).day, dayPlus('2026-10-10', 13));

  const rest = await store.ensureStoredAssessments(db, { now: new Date(NOW), windowOnly: true, log: null });
  assert.equal(rest.windowComplete, true);
  assert.ok(assessedDomains(db).includes('arrived-later.com'), 'rows above the resume point are picked up after it drains');
  assert.equal(store.signalCursor(db), null, 'cursor cleared once the phase drains');
  db.close();
});

test('heartbeats keep arriving while a slow due selection runs, so the wave is not killed', async () => {
  const dbPath = tmpDbPath();
  const db = open(dbPath);
  insert(db, 'slow-select.com');
  // Selection takes 3 s; the supervisor kills after 1.5 s without a heartbeat.
  const summary = await superviseWave({ dbPath, env: ENV, log: quiet, testHook: HOOK, heartbeatMs: 100, hangMs: 1500,
    options: { testScenario: 'quick', testSelectDelayMs: 3000, now: NOW, skipMovementImport: true, skipRdapSweep: true, skipTransferScreen: true, skipPostProbeAssess: true } });
  assert.notEqual(summary.reason, 'terminated', JSON.stringify(summary).slice(0, 400));
  assert.deepEqual(summary.stageErrors, []);
  assert.equal(summary.probed, 1, 'the slowly selected row was probed');
  const run = db.prepare('SELECT finished_at, reason FROM sale_watch_wave_runs ORDER BY id DESC LIMIT 1').get();
  assert.ok(run.finished_at);
  assert.equal(run.reason, null);
  db.close();
});

test('a wave killed during due selection records stage selectDue, not searchIndex', async () => {
  const dbPath = tmpDbPath();
  const db = open(dbPath);
  insert(db, 'hung-select.com');
  const result = await superviseWave({ dbPath, env: ENV, log: quiet, testHook: HOOK, heartbeatMs: 100, hangMs: 1500, recordTimeoutMs: 20000,
    options: { testScenario: 'select-hang', now: NOW, skipMovementImport: true, skipRdapSweep: true, skipTransferScreen: true, skipPostProbeAssess: true } });
  assert.equal(result.reason, 'terminated', JSON.stringify(result));
  assert.equal(result.stage, 'selectDue');
  assert.match(result.error, /in stage selectDue/);
  const run = db.prepare('SELECT stage, finished_at, reason, summary_json FROM sale_watch_wave_runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(run.stage, 'selectDue');
  assert.equal(run.reason, 'abandoned');
  const stageErrors = JSON.parse(run.summary_json).stageErrors;
  assert.equal(stageErrors[0].stage, 'selectDue');
  assert.equal(stageErrors[0].code, 'WAVE_TERMINATED');
  db.close();
});

test('heartbeats keep arriving while a slow wave-size backlog count runs off-thread', async () => {
  const dbPath = tmpDbPath();
  const db = open(dbPath);
  insert(db, 'slow-size.com');
  const summary = await superviseWave({ dbPath, env: ENV, log: quiet, testHook: HOOK, heartbeatMs: 100, hangMs: 1500,
    options: { testScenario: 'quick', testWaveSizeDelayMs: 3000, now: NOW, skipMovementImport: true, skipRdapSweep: true, skipTransferScreen: true, skipPostProbeAssess: true } });
  assert.notEqual(summary.reason, 'terminated', JSON.stringify(summary).slice(0, 400));
  assert.deepEqual(summary.stageErrors, []);
  assert.equal(summary.probed, 1);
  assert.equal(typeof summary.firstProbeHealth.overdue, 'number', 'off-thread first-probe health returned a count');
  db.close();
});

test('a wave killed during the wave-size count records stage waveSize', async () => {
  const dbPath = tmpDbPath();
  const db = open(dbPath);
  insert(db, 'hung-size.com');
  const result = await superviseWave({ dbPath, env: ENV, log: quiet, testHook: HOOK, heartbeatMs: 100, hangMs: 1500, recordTimeoutMs: 20000,
    options: { testScenario: 'wavesize-hang', now: NOW, skipMovementImport: true, skipRdapSweep: true, skipTransferScreen: true, skipPostProbeAssess: true } });
  assert.equal(result.reason, 'terminated', JSON.stringify(result));
  assert.equal(result.stage, 'waveSize');
  const run = db.prepare('SELECT stage, reason, summary_json FROM sale_watch_wave_runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(run.stage, 'waveSize');
  assert.equal(run.reason, 'abandoned');
  assert.equal(JSON.parse(run.summary_json).stageErrors[0].stage, 'waveSize');
  db.close();
});

test('each assess-signal batch reaches the page as soon as it commits, before the window drains', async () => {
  const dbPath = tmpDbPath();
  const db = open(dbPath);
  for (let i = 0; i < 3; i += 1) insert(db, `old${i}.com`, { day: dayPlus('2026-10-01', i), state: 'probing', probeCount: 1, discovery: { buyerUse: true } });
  await store.ensureStoredAssessments(db, { now: new Date(NOW), log: null });
  assert.equal(store.storedAssessmentsReady(db), true, 'stored page path is serving');
  const fresh = [];
  for (let i = 0; i < 12; i += 1) { const d = `new${String(i).padStart(2, '0')}.com`; insert(db, d, { day: dayPlus('2026-10-20', i), state: 'probing', probeCount: 1, discovery: { buyerUse: true } }); fresh.push(d); }
  const reader = new Database(dbPath, { readonly: true });
  const before = recon.readReconstructionPage(reader, { view: 'all', days: 30, limit: 50, now: NOW });
  assert.equal(before.source, 'stored');
  assert.deepEqual(before.entries.map(e => e.domain).filter(d => d.startsWith('new')), []);
  // One batch of five, then stop (as if the process restarted mid-phase).
  await store.ensureStoredAssessments(db, { now: new Date(NOW), windowOnly: true, limit: 5, batch: 5, log: null });
  assert.ok(store.signalCursor(db), 'phase not drained yet');
  const after = recon.readReconstructionPage(reader, { view: 'all', days: 30, limit: 50, now: NOW });
  assert.deepEqual(after.entries.map(e => e.domain).filter(d => d.startsWith('new')), fresh.slice().reverse().slice(0, 5),
    'the newest five written rows are on the page from another connection');
  reader.close();
  db.close();
});

test('boot reassessment (ensureAssessmentVersion) does no candidate scan on the main-process handle; the worker rescores', async () => {
  const dbPath = tmpDbPath();
  const db = open(dbPath);
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 5; i += 1) insert(db, `boot${i}.com`, { day: today, state: 'probing', probeCount: 1, extra: { assessment: { version: 'old' } } });
  db.prepare("DELETE FROM sale_watch_meta WHERE key = 'assessment_version'").run();
  const prepared = [];
  const orig = db.prepare.bind(db);
  db.prepare = sql => { prepared.push(sql); return orig(sql); };
  const result = recon.ensureAssessmentVersion(db);
  delete db.prepare;
  assert.equal(result.deferred, 'index-worker', JSON.stringify(result));
  assert.equal(result.search.worker, true, 'rescoring runs in the indexer worker thread');
  assert.ok(prepared.every(sql => !/sale_watch_candidates|json_extract/i.test(sql)), `main-thread SQL: ${prepared.join(' | ')}`);
  const pass = await require('../server/sale-watch-search').searchIndexRebuild(db);
  assert.equal(pass.assessmentVersion.ran, true, JSON.stringify(pass.assessmentVersion));
  assert.equal(db.prepare("SELECT value FROM sale_watch_meta WHERE key = 'assessment_version'").get().value, VERSION);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sale_watch_candidates WHERE json_extract(evidence_json, '$.assessment.version') = 'old'").get().n, 0);
  db.close();
});
