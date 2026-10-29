'use strict';

// Off-main Sale Watch search indexer.
//
// Every bulk search-index pass (boot / SEARCH_VERSION bump rebuild, post-ingest
// and per-wave catch-up, destination-day census rebuild) runs here, never on
// the HTTP thread: JSON parse + label segmentation + theme tagging cost ~1 ms
// per row, so even cooperative 1000-row batches held the main event loop for
// ~1 s each. This worker owns its own WRITABLE better-sqlite3 connection to the
// same WAL database, with a busy_timeout, and writes small (<= ~200-row)
// transactions so the main writer is never blocked behind it for long.
//
// Same spawn pattern as server/db-read-worker.js (workerData.dbPath, one
// connection per worker); the controller in server/sale-watch-search-indexer.js
// starts it, enforces one indexer per process and restarts it if it dies.
//
// Protocol (worker -> parent):
//   { type: 'progress', progress }   periodic progress
//   { type: 'done', result }         pass finished
//   { type: 'error', error }         pass failed
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const search = require('./sale-watch-search');
const { runBulkPass } = require('./sale-watch-search-indexer');

const HEARTBEAT_MS = 5000;

async function main() {
  const data = workerData || {};
  const db = new Database(data.dbPath);
  try {
    try { db.pragma(`busy_timeout = ${Number(data.busyTimeoutMs) > 0 ? Math.floor(Number(data.busyTimeoutMs)) : 15000}`); } catch (_) { /* non-fatal */ }
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    } catch (_) { /* keep the file's journal mode */ }
    const options = data.options || {};
    const startedAt = new Date().toISOString();
    let lastBeat = 0;
    let progress = { indexed: 0, examined: 0 };
    const beat = (handle, state = 'running', extra = {}) => {
      try {
        search.writeIndexerStatus(handle, {
          state, startedAt, heartbeatAt: new Date().toISOString(), pass: data.pass || 'bulk', threadId: require('worker_threads').threadId, ...progress, ...extra,
        });
      } catch (_) { /* status is advisory */ }
    };
    search.ensureSearchSchema(db);
    beat(db);
    // Search documents, then the probe-priority backlog, then stored ledger
    // assessments: all on this thread and connection, in small transactions.
    const result = await runBulkPass(db, options, {
      onProgress: p => {
        progress = { indexed: p.indexed, examined: p.examined };
        parentPort.postMessage({ type: 'progress', progress: p });
      },
      // Runs inside each batch transaction: a throttled heartbeat row.
      onBatch: handle => {
        const now = Date.now();
        if (now - lastBeat >= HEARTBEAT_MS) { lastBeat = now; beat(handle); }
      },
    });
    beat(db, 'idle', { finishedAt: new Date().toISOString(), indexed: result.indexed, restamped: result.restamped, examined: result.examined });
    parentPort.postMessage({ type: 'done', result });
  } finally {
    try { db.close(); } catch (_) { /* ignore */ }
  }
}

main().catch(error => {
  parentPort.postMessage({ type: 'error', error: String((error && error.message) || error) });
});
