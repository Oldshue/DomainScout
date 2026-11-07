'use strict';

// Production-shaped regression for 2026-11-07: the candidate-keys backfill
// reported rid 14000 six minutes after starting on ~1.3 M rows, and the wave's
// ingest.discovery lost 5 of 6 "database is locked" retries meanwhile. Here a
// file-backed sale_watch.db with large evidence rows is backfilled while a
// writer on its own thread and connection (shaped like wave intake) commits
// small transactions. The backfill must sustain >= 1,000 rows/s (well under an
// hour for 1.3 M rows), the writer must keep completing between batches and
// never exhaust its busy timeout, and every candidate must end with a key row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');

const keys = require('../server/sale-watch-candidate-keys');
const { buildCandidatesDb } = require('./fixtures/candidate-keys-bench');

const ROWS = 8000;
const PAD_BYTES = 16000;

const WRITER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.bsq);
const db = new Database(workerData.file);
db.pragma('busy_timeout = ' + workerData.busyTimeoutMs);
const ins = db.prepare("INSERT INTO sale_watch_candidates(domain, last_stream, exit_observed_day, state, next_probe_at, probe_count, probe_priority, evidence_json) VALUES(?, 'zone-seller-departure', '2026-11-07', 'exited', '2026-11-08T00:00:00.000Z', 0, 1, ?)");
const tx = db.transaction(i => ins.run('intake-writer-' + i + '.com', JSON.stringify({ classification: 'moved', discovery: { movement: { previousClass: 'seller' } } })));
let stop = false; let i = 0; let writes = 0; let errors = []; let maxWaitMs = 0;
parentPort.on('message', m => { if (m === 'stop') stop = true; });
function step() {
  if (stop) { db.close(); parentPort.postMessage({ writes, errors, maxWaitMs }); return; }
  const t = Date.now();
  try { tx(i++); writes += 1; } catch (e) { errors.push(String(e.message)); }
  maxWaitMs = Math.max(maxWaitMs, Date.now() - t);
  setTimeout(step, 15);
}
parentPort.postMessage('ready');
step();
`;

test('candidate-keys backfill sustains >= 1,000 rows/s on large evidence rows while a concurrent writer gets through', async () => {
  const { db, file, root } = buildCandidatesDb({ rows: ROWS, padBytes: PAD_BYTES });
  db.close();
  const handle = new Database(file);
  handle.pragma('busy_timeout = 15000');
  handle.pragma('journal_mode = WAL');
  // Cold-ish cache, like the first pass after a restart on a 21 GB file.
  handle.pragma('cache_size = -2000');
  keys.ensureCandidateKeysSchema(handle);
  const writer = new Worker(WRITER_SRC, { eval: true, workerData: { file, bsq: require.resolve('better-sqlite3'), busyTimeoutMs: 5000 } });
  await new Promise((resolve, reject) => { writer.once('message', resolve); writer.once('error', reject); });
  let result;
  let writerResult;
  try {
    // pauseMs > 0 exercises the off-main pacing (the indexer worker's default).
    result = await keys.backfillCandidateKeys(handle, { pauseMs: 10 });
  } finally {
    writerResult = await new Promise((resolve, reject) => { writer.once('message', resolve); writer.once('error', reject); writer.postMessage('stop'); });
    await writer.terminate();
  }
  try {
    assert.equal(result.complete, true, JSON.stringify(result));
    // Rows the concurrent writer committed before the backfill read MAX(rowid) are in its range too.
    assert.ok(result.examined >= ROWS && result.examined <= ROWS + writerResult.writes, `examined ${result.examined} of ${ROWS} + ${writerResult.writes} written`);
    assert.ok(result.chunks > 1, `backfill ran in several batches (${result.chunks})`);
    assert.ok(result.rowsPerSec >= 1000, `backfill rate ${result.rowsPerSec} rows/s (${result.ms} ms for ${ROWS} rows)`);
    assert.deepEqual(writerResult.errors, [], 'the concurrent writer never exhausted its busy timeout');
    assert.ok(writerResult.writes >= Math.max(2, result.chunks - 1), `writer completed ${writerResult.writes} transactions across ${result.chunks} batches`);
    // Generous: a writer waits at most a batch write, never the whole pass.
    assert.ok(writerResult.maxWaitMs < Math.max(3000, result.ms / 2), `writer max wait ${writerResult.maxWaitMs} ms vs pass ${result.ms} ms`);
    const meta = keys.candidateKeysProgress(handle);
    assert.equal(meta.complete, true);
    assert.ok(Number(meta.rowsPerSec) >= 1000, `rate persisted for health: ${meta.rowsPerSec}`);
    const cands = handle.prepare("SELECT COUNT(*) AS n FROM sale_watch_candidates WHERE domain IS NOT NULL AND domain <> ''").get().n;
    const keyed = handle.prepare(`SELECT COUNT(*) AS n FROM ${keys.TABLE}`).get().n;
    assert.equal(keyed, cands, 'every pre-existing and concurrently written candidate has a key row');
    // Concurrent writes went through the triggers and were not overwritten.
    const w = handle.prepare(`SELECT seller_dep FROM ${keys.TABLE} WHERE domain = 'intake-writer-0.com'`).get();
    assert.equal(w && w.seller_dep, 1);
  } finally {
    handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('backfill resumes from its persisted position after an interrupted pass', async () => {
  const { db, file, root } = buildCandidatesDb({ rows: 1500, padBytes: 4000 });
  db.close();
  const handle = new Database(file);
  try {
    const first = await keys.backfillCandidateKeys(handle, { chunk: 200, maxChunks: 2, pauseMs: 0 });
    assert.equal(first.complete, false);
    assert.equal(keys.candidateKeysReady(handle), false);
    const second = await keys.backfillCandidateKeys(handle, { chunk: 200, pauseMs: 0 });
    assert.equal(second.complete, true);
    assert.equal(second.resumedFrom, first.rid);
    assert.equal(first.examined + second.examined, 1500);
    assert.equal(keys.candidateKeysReady(handle), true);
    assert.equal(handle.prepare(`SELECT COUNT(*) AS n FROM ${keys.TABLE}`).get().n, 1500);
  } finally {
    handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
