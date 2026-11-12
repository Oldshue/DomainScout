'use strict';

// applyAssessmentVersion (the boot rescoring to a new adjudicator VERSION):
// bounded rowid-range reads, IMMEDIATE writes that wait out a busy writer, a
// saved position that a restart resumes, and the version recorded at the end.
// 2026-11-12: one whole-window read plus DEFERRED writes failed with
// "database is locked" on every boot and never recorded the version.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const recon = require('../server/sale-watch-reconstruction');
const { VERSION } = require('../server/sale-watch-evidence');

const NOW = new Date('2026-10-28T12:00:00Z');
const DAY = '2026-10-27';

function seed(db, count) {
  recon.ensureReconstructionSchema(db);
  const insert = db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 1, ?, ?)`);
  for (let i = 0; i < count; i += 1) {
    const domain = `name${String(i).padStart(3, '0')}.com`;
    const evidence = {
      domain, tier: 'suspected', reportDate: DAY, sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['ns1.host.example'],
      assessment: { version: 'sale-evidence-v0' },
      discovery: { movement: { day: DAY, prevDay: DAY, previousNameservers: ['ns1.dan.com'], currentNameservers: ['ns1.host.example'], source: 'daily-zone-delegation-diff' }, structurallyMoved: true, departureDate: DAY },
    };
    insert.run(domain, DAY, DAY, DAY, DAY, JSON.stringify(evidence), `${DAY}T06:00:00Z`);
  }
}
const versions = db => db.prepare("SELECT rowid AS rid, json_extract(evidence_json, '$.assessment.version') AS v FROM sale_watch_candidates ORDER BY rowid").all();
const meta = (db, key) => { const r = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(key); return r ? r.value : null; };

test('rescoring walks bounded rowid ranges, records the version and clears its position', () => {
  const db = new Database(':memory:');
  seed(db, 25);
  const pages = [];
  const direct = recon.reassessStoredEvidence(db, { sinceDays: 30, batch: 10, now: NOW, onPage: rid => pages.push(rid) });
  assert.equal(direct.rewritten, 25);
  assert.deepEqual(pages, [10, 20, 25]);
  assert.ok(versions(db).every(r => r.v === VERSION));

  const again = new Database(':memory:');
  seed(again, 25);
  const result = recon.applyAssessmentVersion(again, { batch: 10, now: NOW });
  assert.equal(result.ran, true);
  assert.equal(result.rewritten, 25);
  assert.equal(result.resumedFrom, null);
  assert.equal(meta(again, 'assessment_version'), VERSION);
  assert.equal(meta(again, 'assessment_version_cursor'), null);
  assert.deepEqual(recon.applyAssessmentVersion(again, { batch: 10, now: NOW }), { ran: false, version: VERSION });
});

test('a rescoring cut short resumes from its saved position instead of starting over', () => {
  const db = new Database(':memory:');
  seed(db, 25);
  db.exec('CREATE TABLE IF NOT EXISTS sale_watch_meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO sale_watch_meta(key,value) VALUES(?, ?)').run('assessment_version_cursor', JSON.stringify({ version: VERSION, rid: 10 }));
  const result = recon.applyAssessmentVersion(db, { batch: 10, now: NOW });
  assert.equal(result.resumedFrom, 10);
  assert.equal(result.rewritten, 15);
  const after = versions(db);
  assert.ok(after.filter(r => r.rid <= 10).every(r => r.v === 'sale-evidence-v0'), 'rows before the saved position are not read again');
  assert.ok(after.filter(r => r.rid > 10).every(r => r.v === VERSION));
  assert.equal(meta(db, 'assessment_version'), VERSION);
  // A position saved under another VERSION is ignored.
  const other = new Database(':memory:');
  seed(other, 12);
  other.exec('CREATE TABLE IF NOT EXISTS sale_watch_meta (key TEXT PRIMARY KEY, value TEXT)');
  other.prepare('INSERT INTO sale_watch_meta(key,value) VALUES(?, ?)').run('assessment_version_cursor', JSON.stringify({ version: 'older', rid: 10 }));
  assert.equal(recon.applyAssessmentVersion(other, { batch: 10, now: NOW }).rewritten, 12);
});

test('a writer holding the lock delays the rescoring instead of failing it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-version-resume-'));
  const dbPath = path.join(dir, 'sale_watch.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 0');
  seed(db, 12);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Another connection takes the write lock, signals, and commits 700 ms later.
  const holder = new Worker(`
    const { parentPort, workerData } = require('worker_threads');
    const Database = require(workerData.sqlite);
    const other = new Database(workerData.dbPath);
    other.exec('BEGIN IMMEDIATE');
    other.prepare("UPDATE sale_watch_candidates SET last_price = 1 WHERE domain = 'name000.com'").run();
    parentPort.postMessage('locked');
    setTimeout(() => { other.exec('COMMIT'); other.close(); parentPort.postMessage('released'); }, 700);
  `, { eval: true, workerData: { dbPath, sqlite: require.resolve('better-sqlite3') } });
  await new Promise((resolve, reject) => { holder.once('message', resolve); holder.once('error', reject); });
  const result = recon.applyAssessmentVersion(db, { batch: 5, now: NOW });
  assert.equal(result.rewritten, 12);
  assert.ok(result.busyRetries > 0, 'it waited for the writer');
  assert.equal(meta(db, 'assessment_version'), VERSION);
  await holder.terminate();
});

test('a time budget stops the rescoring mid-way; later indexer passes carry it on until the version is recorded', async () => {
  const { runBulkPass } = require('../server/sale-watch-search-indexer');
  const search = require('../server/sale-watch-search');
  const db = new Database(':memory:');
  seed(db, 30);
  search.ensureSearchSchema(db);
  // Budget already spent before the first page: nothing is read, the position is saved.
  const sliced = recon.reassessStoredEvidence(db, { sinceDays: 30, batch: 10, now: NOW, afterRid: 10, budgetMs: 0.000001 });
  assert.equal(sliced.complete, false);
  assert.equal(sliced.nextRid, 10);
  assert.equal(recon.assessmentVersionPending(db), false, 'nothing started yet');

  // A pass that did not request it does not start a rescoring.
  await runBulkPass(db, { now: NOW.toISOString(), search: false, probeBacklog: false });
  assert.equal(meta(db, 'assessment_version'), null);
  assert.ok(versions(db).every(r => r.v === 'sale-evidence-v0'));

  // A started rescoring (saved position) is carried on by an ordinary pass.
  db.prepare('INSERT INTO sale_watch_meta(key,value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('assessment_version_cursor', JSON.stringify({ version: VERSION, rid: 10 }));
  assert.equal(recon.assessmentVersionPending(db), true);
  const pass = await runBulkPass(db, { now: NOW.toISOString(), search: false, probeBacklog: false });
  assert.equal(pass.assessmentVersion.complete, true);
  assert.equal(pass.assessmentVersion.resumedFrom, 10);
  assert.equal(meta(db, 'assessment_version'), VERSION);
  assert.equal(recon.assessmentVersionPending(db), false);
  // The same pass re-assessed the rows the slice dirtied.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_watch_assessments WHERE dirty = 1').get().n, 0);
});
