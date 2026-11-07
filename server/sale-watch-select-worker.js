'use strict';

// Off-loop candidate reads for the Sale Watch wave child.
//
// 2026-11-07 (wave 1162): selectDueCandidates ran synchronously on the wave
// child's own connection. On a cold page cache it blocked the child's event
// loop for over 10 minutes, so no heartbeat reached the supervisor and the
// wave was killed. Selection is now indexed (sale-watch-candidate-keys), and
// every wave-child read over sale_watch_candidates that may still be slow
// (due selection, the wave-size backlog count, first-probe health, the
// adoption-kit window pass, and the legacy unindexed queries used until the
// key backfill completes) runs here, in a worker thread with its OWN
// connection, so the child's heartbeat timer keeps firing throughout.
//
// Protocol (worker -> parent): { type: 'done', value } | { type: 'error', error }

const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const WORKER_FILE = __filename;
// Named jobs: reconstruction functions called as fn(db, args).
const JOBS = Object.freeze(['selectDueCandidates', 'computeWaveSize', 'firstProbeHealth', 'markAdoptionKits']);

/**
 * Runs reconstruction[job](db, args) on a fresh connection to dbPath in a
 * worker thread. Resolves with the job's (structured-cloneable) value; rejects
 * on a worker error or an exit before 'done'. `createWorker` is injectable.
 */
function runOffThread(dbPath, job, args = {}, { busyTimeoutMs = 30000, testDelayMs = 0, createWorker = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!JOBS.includes(job)) { reject(new Error(`unknown off-thread job ${job}`)); return; }
    let settled = false;
    const data = { dbPath, job, args: args || {}, busyTimeoutMs, testDelayMs };
    let worker;
    try {
      worker = createWorker ? createWorker(data) : new Worker(WORKER_FILE, { workerData: data });
    } catch (error) {
      reject(error);
      return;
    }
    worker.on('message', message => {
      if (settled || !message) return;
      if (message.type === 'done') { settled = true; resolve(message.value); }
      else if (message.type === 'error') { settled = true; reject(new Error(message.error)); }
    });
    worker.on('error', error => { if (!settled) { settled = true; reject(error); } });
    worker.on('exit', code => { if (!settled) { settled = true; reject(new Error(`${job} worker exited (${code}) before finishing`)); } });
  });
}

/** Due selection off-thread (rows). Kept for callers of the original API. */
function selectDueOffThread(dbPath, { now = null, limit = null, busyTimeoutMs = 30000, testDelayMs = 0 } = {}, { createWorker = null } = {}) {
  const args = {};
  if (now != null) args.now = String(now);
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) args.limit = Math.floor(Number(limit));
  return runOffThread(dbPath, 'selectDueCandidates', args, { busyTimeoutMs, testDelayMs, createWorker }).then(rows => rows || []);
}

async function runWorker() {
  const Database = require('better-sqlite3');
  const recon = require('./sale-watch-reconstruction');
  const data = workerData || {};
  const db = new Database(data.dbPath);
  try {
    db.pragma(`busy_timeout = ${Number(data.busyTimeoutMs) > 0 ? Math.floor(Number(data.busyTimeoutMs)) : 30000}`);
    // Test-only: a synthetic slow job (blocks THIS thread only).
    if (Number(data.testDelayMs) > 0 && process.env.DOMAINSCOUT_SALE_WATCH_WAVE_TEST_HOOKS === '1') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(data.testDelayMs));
    }
    if (!JOBS.includes(data.job)) throw new Error(`unknown off-thread job ${data.job}`);
    const value = await recon[data.job](db, data.args || {});
    parentPort.postMessage({ type: 'done', value });
  } catch (error) {
    parentPort.postMessage({ type: 'error', error: String((error && error.message) || error) });
  } finally {
    try { db.close(); } catch (_) { /* ignore */ }
  }
}

if (!isMainThread && workerData && workerData.dbPath && parentPort) void runWorker();

module.exports = { runOffThread, selectDueOffThread, JOBS, WORKER_FILE: path.resolve(WORKER_FILE) };
