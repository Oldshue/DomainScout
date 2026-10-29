'use strict';

// Shared cooperative pause between Sale Watch bulk-write transactions.
//
// The off-main indexer worker drains its whole backlog continuously; between
// two small write transactions it waits `pauseMs` so the main writer (probe
// waves, ingest) always gets the WAL write lock within a few hundred ms. On
// the caller's thread (tests, in-memory handles) the pause is 0 and this is a
// plain setImmediate yield.
let pauseMs = 0;

function setTransactionPause(ms) {
  pauseMs = Math.max(0, Math.floor(Number(ms)) || 0);
  return pauseMs;
}

function transactionPause() {
  return pauseMs;
}

function yieldBetweenTransactions() {
  return pauseMs > 0
    ? new Promise(resolve => setTimeout(resolve, pauseMs))
    : new Promise(resolve => setImmediate(resolve));
}

module.exports = { setTransactionPause, transactionPause, yieldBetweenTransactions };
