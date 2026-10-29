'use strict';

// Sale Watch search indexing runs off the HTTP thread, one indexer at a time,
// and a SEARCH_VERSION bump rebuilds in place (old documents stay searchable
// until each row is overwritten, with the version recorded per row).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { Worker, threadId: mainThreadId } = require('node:worker_threads');
const Database = require('better-sqlite3');

const { ensureReconstructionSchema, configureSaleWatchDb } = require('../server/sale-watch-reconstruction');
const { readSaleWatchCandidates } = require('../server/sale-watch-candidates');
const search = require('../server/sale-watch-search');
const indexer = require('../server/sale-watch-search-indexer');

const NOW = new Date('2026-10-28T12:00:00Z');
const DAY = '2026-10-27';
const SELLER = ['ns1.dan.com', 'ns2.dan.com'];
const quiet = { log() {}, warn() {} };

function evidence(domain) {
  return {
    domain,
    tier: 'suspected',
    reportDate: DAY,
    sellerNameservers: SELLER,
    buyerNameservers: ['ns1.host.example'],
    discovery: {
      movement: { day: DAY, prevDay: DAY, previousNameservers: SELLER, currentNameservers: ['ns1.host.example'], source: 'daily-zone-delegation-diff' },
      structurallyMoved: true,
      departureDate: DAY,
      homepage: { active: true, parked: false, placeholder: false, status: 200, title: `${domain} home`, description: 'Model serving and inference APIs for teams', textSample: 'Welcome to our site where we build things' },
    },
  };
}

function insertRows(db, names) {
  const add = db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 1, ?, ?)`);
  db.transaction(() => { for (const name of names) add.run(name, DAY, DAY, DAY, DAY, JSON.stringify(evidence(name)), `${DAY}T00:00:00Z`); })();
}

function fileDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-indexer-'));
  const db = new Database(path.join(dir, 'sale_watch.db'));
  db.pragma('busy_timeout = 15000');
  configureSaleWatchDb(db);
  ensureReconstructionSchema(db);
  return db;
}

const unindexed = db => db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates WHERE search_text IS NULL').get().n;
const byVersion = db => Object.fromEntries(db.prepare(`SELECT COALESCE(search_version, 'null') AS v, COUNT(*) AS n FROM ${search.DOCS_TABLE} GROUP BY 1`).all().map(r => [r.v, r.n]));

test('bulk indexing runs in a worker thread: the main event loop keeps turning (setInterval drift)', async t => {
  const db = fileDb();
  const N = 6000;
  insertRows(db, Array.from({ length: N }, (_, i) => `${i % 5 === 0 ? 'inference' : 'quiet'}name${i}.com`));
  // Fixture setup above is outside the measured interval; measurement covers
  // only the indexing pass (request -> promise settled).
  const PERIOD = 20;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  let last = Date.now();
  let maxGap = 0;
  let ticks = 0;
  let sawRunning = false;
  let measuring = true;
  const timer = setInterval(() => {
    if (!measuring) return;
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks += 1;
    if (indexer.searchIndexerState().running) sawRunning = true;
  }, PERIOD);
  delay.enable();
  last = Date.now();
  const measuredStarted = Date.now();
  const request = indexer.requestSearchIndexPass(db, { pass: 'rebuild', log: quiet });
  assert.equal(request.started, true);
  assert.equal(request.inProcess, false, 'a file-backed handle is indexed by the worker');
  // While the worker runs, the main connection still serves reads and the
  // coverage reports it. This synchronous read is the test's own work, not
  // the indexer's, so it is excluded from the drift measurement.
  const during = readSaleWatchCandidates(db, { now: NOW, days: 7 });
  last = Date.now();
  assert.equal(during.coverage.searchIndex.running, true);
  const result = await request.promise;
  measuring = false;
  clearInterval(timer);
  delay.disable();
  const delayMaxMs = Math.round(delay.max / 1e6);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.worker, true);
  assert.equal(result.indexed, N);
  assert.ok(result.pages >= N / 200, `writes are <=200-row transactions (${result.pages} pages)`);
  assert.equal(result.versionRecorded, true);
  assert.ok(sawRunning, 'the main loop observed the indexer running');
  assert.ok(ticks >= 5, `interval ticked ${ticks} times`);
  assert.ok(maxGap < 250, `main event loop stalled ${maxGap}ms while indexing (monitorEventLoopDelay max ${delayMaxMs}ms)`);
  t.diagnostic(JSON.stringify({ durationMs: Date.now() - measuredStarted, maxGapMs: maxGap, monitorMaxMs: delayMaxMs, ticks, stages: result.stages }));
  assert.equal(unindexed(db), 0);
  assert.deepEqual(byVersion(db), { [search.SEARCH_VERSION]: N });
  const after = readSaleWatchCandidates(db, { now: NOW, days: 7 });
  assert.equal(after.coverage.searchIndex.running, false);
  assert.equal(after.coverage.searchIndex.indexedCurrent, N);
  assert.equal(after.coverage.searchIndex.missing, 0);
  db.close();
});

test('version bump rebuilds in place: old documents stay searchable until replaced; per-row versions add up', async () => {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  const names = Array.from({ length: 10 }, (_, i) => `${i < 4 ? 'inference' : 'harbor'}shop${i}.com`);
  insertRows(db, names);
  await search.indexAllMissingSearchDocuments(db);
  db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES('search_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(search.SEARCH_VERSION);
  // Simulate documents written by the previous SEARCH_VERSION, with a marker only the old documents carry.
  db.prepare(`UPDATE ${search.DOCS_TABLE} SET search_version = 'sale-watch-search/v3', site = site || ' legacymarker'`).run();
  db.prepare("UPDATE sale_watch_meta SET value = 'sale-watch-search/v3' WHERE key = 'search_version'").run();
  const legacy = () => search.searchCandidates(db, 'legacymarker').matches.size;
  const inference = () => [...search.searchCandidates(db, 'inference').matches.keys()].filter(d => d.startsWith('inference')).length;
  assert.equal(legacy(), 10);
  const coverage = () => readSaleWatchCandidates(db, { now: NOW, days: 7 }).coverage.searchIndex;
  assert.deepEqual([coverage().indexedCurrent, coverage().indexedStale, coverage().missing], [0, 10, 0]);

  const partial = await search.ensureSearchIndex(db, { limit: 4, destinationDays: false });
  assert.equal(partial.rebuilt, true);
  assert.equal(partial.restamped, 4);
  assert.equal(partial.versionRecorded, false, 'version is recorded only once every row is current');
  assert.equal(unindexed(db), 0, 'nothing was cleared up front');
  assert.equal(legacy(), 6, 'unreplaced rows still serve their old document');
  assert.equal(inference(), 4, 'name search keeps working during the rebuild');
  assert.deepEqual(byVersion(db), { [search.SEARCH_VERSION]: 4, 'sale-watch-search/v3': 6 });
  const mid = coverage();
  assert.equal(mid.version, search.SEARCH_VERSION);
  assert.deepEqual([mid.indexedCurrent, mid.indexedStale, mid.missing, mid.complete], [4, 6, 0, false]);

  const full = await search.ensureSearchIndex(db, { destinationDays: false });
  assert.equal(full.restamped, 6);
  assert.equal(full.versionRecorded, true);
  assert.equal(search.storedSearchVersion(db), search.SEARCH_VERSION);
  assert.equal(legacy(), 0);
  assert.equal(inference(), 4);
  assert.deepEqual(byVersion(db), { [search.SEARCH_VERSION]: 10 });
  const done = coverage();
  assert.deepEqual([done.indexedCurrent, done.indexedStale, done.missing, done.complete], [10, 0, 0, true]);
  // A current index does no stale work.
  const again = await search.ensureSearchIndex(db, { destinationDays: false });
  assert.equal(again.rebuilt, false);
  assert.equal(again.restamped, 0);
});

test('orphan documents are purged by the pass, not by clearing up front', async () => {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  insertRows(db, ['keepme.com', 'goner.com']);
  await search.indexAllMissingSearchDocuments(db);
  db.prepare("DELETE FROM sale_watch_candidates WHERE domain = 'goner.com'").run();
  const result = await search.ensureSearchIndex(db, { destinationDays: false });
  assert.equal(result.purged, 1);
  assert.deepEqual(db.prepare(`SELECT domain FROM ${search.DOCS_TABLE}`).all().map(r => r.domain), ['keepme.com']);
});

test('one indexer at a time: concurrent requests coalesce into one follow-up pass', async () => {
  await indexer.searchIndexerIdle();
  const db = fileDb();
  insertRows(db, Array.from({ length: 1500 }, (_, i) => `solo${i}.com`));
  let live = 0;
  let maxLive = 0;
  let spawned = 0;
  const createWorker = workerData => {
    spawned += 1;
    const worker = new Worker(indexer.WORKER_FILE, { workerData });
    live += 1;
    maxLive = Math.max(maxLive, live);
    worker.once('exit', () => { live -= 1; });
    return worker;
  };
  const before = indexer.searchIndexerState().passes;
  const first = indexer.requestSearchIndexPass(db, { pass: 'rebuild', log: quiet, createWorker });
  const second = indexer.requestSearchIndexPass(db, { pass: 'wave', options: { limit: 10 }, log: quiet, createWorker });
  const third = indexer.requestSearchIndexPass(db, { pass: 'post-ingest', log: quiet, createWorker });
  assert.equal(first.started, true);
  assert.deepEqual([second.started, second.queued, third.started, third.queued], [false, true, false, true]);
  assert.equal(indexer.searchIndexerState().queued, true);
  const results = await Promise.all([first.promise, second.promise, third.promise]);
  await indexer.searchIndexerIdle();
  assert.ok(results.every(r => !r.error), JSON.stringify(results));
  assert.equal(results[0].indexed, 1500);
  assert.equal(indexer.searchIndexerState().passes - before, 2, 'the two queued requests ran as one follow-up pass');
  assert.equal(spawned, 2);
  assert.equal(maxLive, 1, 'never two indexer workers at once');
  assert.equal(unindexed(db), 0);
  db.close();
});

test('a dead indexer worker is restarted and the pass completes', async () => {
  await indexer.searchIndexerIdle();
  const db = fileDb();
  insertRows(db, ['phoenix1.com', 'phoenix2.com', 'phoenix3.com']);
  const warnings = [];
  let calls = 0;
  const createWorker = workerData => {
    calls += 1;
    if (calls === 1) {
      const dying = new EventEmitter();
      dying.threadId = -1;
      setImmediate(() => dying.emit('exit', 1));
      return dying;
    }
    return new Worker(indexer.WORKER_FILE, { workerData });
  };
  const restartsBefore = indexer.searchIndexerState().restarts;
  const request = indexer.requestSearchIndexPass(db, { pass: 'rebuild', log: { log() {}, warn: m => warnings.push(m) }, createWorker, restartDelayMs: 1 });
  const result = await request.promise;
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.attempts, 2);
  assert.equal(indexer.searchIndexerState().restarts - restartsBefore, 1);
  assert.ok(warnings.some(m => /worker died/.test(m)), warnings.join('\n'));
  assert.equal(unindexed(db), 0);
  db.close();
});

test('the indexer worker writes on its own thread and connection', async () => {
  await indexer.searchIndexerIdle();
  const db = fileDb();
  insertRows(db, ['thread1.com']);
  const request = indexer.requestSearchIndexPass(db, { pass: 'catch-up', log: quiet });
  const threadId = await new Promise(resolve => {
    const poll = () => { const id = indexer.searchIndexerState().threadId; if (id) resolve(id); else setImmediate(poll); };
    poll();
  });
  assert.notEqual(threadId, mainThreadId);
  const result = await request.promise;
  assert.equal(result.worker, true);
  const status = search.searchIndexerStatus(db);
  assert.equal(status.state, 'idle');
  assert.equal(status.running, false);
  assert.equal(status.threadId, threadId);
  db.close();
});
