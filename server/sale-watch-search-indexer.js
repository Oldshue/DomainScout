'use strict';

// Main-thread controller for the off-main Sale Watch search indexer
// (server/sale-watch-index-worker.js).
//
// The HTTP thread never indexes: it only starts the worker, receives its
// progress messages and logs them. One indexer runs per process (a
// process-level lock keyed by nothing but this module): a request that arrives
// while a pass is running is coalesced into ONE follow-up pass, which runs
// after the current one so rows written meanwhile are still picked up. A
// worker that dies (crash, exit without 'done', or an 'error' message) is
// restarted with bounded backoff.
//
// An in-memory handle (':memory:', tests only) cannot be opened by a second
// connection, so for those the same pass runs on the caller's handle instead.
// Every file-backed production handle goes through the worker.

const path = require('path');

const WORKER_FILE = path.join(__dirname, 'sale-watch-index-worker.js');
const DEFAULT_RESTARTS = 5;
const DEFAULT_RESTART_DELAY_MS = 2000;

const state = {
  active: null, // { promise, pass, startedAt, threadId, progress, attempts }
  queue: [], // follow-up jobs, at most one per database: { dbPath, db, pass, options, config, waiters: [] }
  lastResult: null,
  lastError: null,
  passes: 0,
  restarts: 0,
};

function fileBacked(db) {
  const name = db && typeof db.name === 'string' ? db.name : '';
  return Boolean(name) && name !== ':memory:' && !db.memory;
}

function defaultCreateWorker(workerData) {
  const { Worker } = require('worker_threads');
  return new Worker(WORKER_FILE, { workerData });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * One bulk pass on a WRITABLE handle. It drains every stage's whole backlog
 * (no per-wave cap), in this order, because the stored ledger is what the
 * user is waiting on:
 *   1. stored ledger assessments for the current window (30 days, newest
 *      departure day first; ensureStoredAssessments windowOnly);
 *   2. search documents (ensureSearchIndex: missing rows, then the stale
 *      SEARCH_VERSION rebuild);
 *   3. the probe-priority backlog, only rows due within 7 days, scored from
 *      the stored search documents (drainProbeBacklog);
 *   4. the remaining stored assessments: seeding, dirty rows, VERSION rebuild
 *      in place and clock-boundary refreshes.
 * All writes are small transactions separated by the shared pause
 * (sale-watch-yield). Each stage reports rows/s in result.stages and through
 * onProgress. options.probeBacklog === false or options.assessments === false
 * skip a stage. The worker thread runs this in production; in-memory test
 * handles run it on the caller's thread.
 */
async function runBulkPass(db, options = {}, { onProgress = null, onBatch = null } = {}) {
  const search = require('./sale-watch-search');
  const now = () => (options.now ? new Date(options.now) : new Date());
  const stages = [];
  const timed = async (stage, fn) => {
    const started = Date.now();
    let value;
    try {
      value = await fn();
    } catch (error) {
      value = { error: String(error && error.message || error) };
    }
    const ms = Date.now() - started;
    const rows = Number(value && (value.examined ?? value.indexed)) || 0;
    const stat = { stage, rows, ms, rowsPerSec: ms > 0 ? Math.round(rows * 1000 / ms) : rows };
    stages.push(stat);
    if (onProgress) {
      try { onProgress({ phase: `${stage} done`, indexed: rows, examined: rows, ms, rowsPerSec: stat.rowsPerSec, done: true }); } catch (_) { /* advisory */ }
    }
    return value;
  };
  let windowResult = null;
  if (options.assessments !== false) {
    windowResult = await timed('assess-window', () => require('./sale-watch-assessments').ensureStoredAssessments(db, { now: now(), onProgress, onBatch, windowOnly: true }));
  }
  const result = await timed('search', () => search.ensureSearchIndex(db, { ...options, onProgress, onBatch }));
  if (windowResult) result.assessmentsWindow = windowResult;
  if (options.probeBacklog !== false) {
    result.probeBacklog = await timed('probe-priority', () => require('./sale-watch-reconstruction').drainProbeBacklog(db, { onProgress, onBatch, now: options.now || null }));
  }
  // VERSION rescoring runs only on passes that request it (ensureAssessmentVersion's
  // boot rebuild), never on per-wave catch-up passes.
  if (options.assessmentVersion === true) {
    try {
      result.assessmentVersion = require('./sale-watch-reconstruction').applyAssessmentVersion(db, { batch: 200, now: options.now ? new Date(options.now) : new Date() });
    } catch (error) {
      result.assessmentVersion = { error: String(error && error.message || error) };
    }
  }
  if (options.assessments !== false) {
    result.assessments = await timed('assessments', () => require('./sale-watch-assessments').ensureStoredAssessments(db, { now: now(), onProgress, onBatch }));
  }
  result.stages = stages;
  return result;
}

function plainOptions(options = {}) {
  const out = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (typeof value === 'function' || value === undefined) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

// One worker attempt: resolves with the pass result, rejects if the worker
// reports an error or exits before reporting 'done'.
function runWorkerOnce({ dbPath, pass, options, busyTimeoutMs, createWorker, log, onProgress }) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = createWorker({ dbPath, pass, options, busyTimeoutMs });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let done = null;
    let exitGrace = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    if (state.active) state.active.threadId = worker.threadId;
    worker.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'started') {
        // The worker's view of the index at pass start: the main thread
        // answers coverage from this snapshot instead of reading
        // sale_watch_meta while the worker is writing.
        if (state.active) {
          state.active.storedVersion = message.storedVersion == null ? null : String(message.storedVersion);
          if (message.threadId) state.active.threadId = message.threadId;
        }
      } else if (message.type === 'progress') {
        if (state.active) state.active.progress = message.progress;
        try { onProgress(message.progress); } catch (_) { /* logging never fails indexing */ }
      } else if (message.type === 'done') {
        // Hold the process-level lock until the thread has actually exited
        // (its connection closed), so two indexer workers never overlap.
        done = { result: message.result };
        exitGrace = setTimeout(() => { try { worker.terminate(); } catch (_) { /* ignore */ } }, 5000);
        if (exitGrace && typeof exitGrace.unref === 'function') exitGrace.unref();
      } else if (message.type === 'error') {
        settle(reject, new Error(message.error || 'search-indexer-error'));
      }
    });
    worker.on('error', error => { if (!done) settle(reject, error instanceof Error ? error : new Error(String(error))); });
    worker.on('exit', code => {
      if (exitGrace) clearTimeout(exitGrace);
      if (done) settle(resolve, done.result);
      else settle(reject, new Error(`search-indexer-worker-exit code=${code}`));
    });
    void log;
  });
}

async function runPass(job, config) {
  const { log, restarts, restartDelayMs, createWorker, busyTimeoutMs } = config;
  const label = `[SaleWatchSearch] indexer ${job.pass}`;
  const onProgress = progress => {
    const ms = Number(progress.ms) || 0;
    const rate = Number.isFinite(Number(progress.rowsPerSec)) ? Number(progress.rowsPerSec) : (ms > 0 ? Math.round((Number(progress.examined) || 0) * 1000 / ms) : 0);
    log.log(`${label} progress: ${progress.indexed} indexed, ${progress.examined} examined${progress.phase ? ` (${progress.phase})` : ''}, ${ms}ms, ${rate} rows/s`);
  };
  const started = Date.now();
  if (!job.dbPath) {
    // In-memory handle (tests): same pass, caller's handle.
    if (state.active) state.active.storedVersion = require('./sale-watch-search').storedSearchVersion(job.db);
    const result = await runBulkPass(job.db, job.options, { onProgress });
    log.log(`${label} done in ${Date.now() - started}ms (in-process): ${JSON.stringify(result)}`);
    return { ...result, worker: false };
  }
  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (state.active) state.active.attempts = attempt;
    try {
      const result = await runWorkerOnce({ dbPath: job.dbPath, pass: job.pass, options: plainOptions(job.options), busyTimeoutMs, createWorker, log, onProgress });
      log.log(`${label} done in ${Date.now() - started}ms: ${JSON.stringify(result)}`);
      return { ...result, worker: true, attempts: attempt };
    } catch (error) {
      if (attempt > restarts) {
        log.warn(`${label} failed after ${attempt} attempts: ${error.message}`);
        throw error;
      }
      state.restarts += 1;
      log.warn(`${label} worker died (${error.message}); restarting (${attempt}/${restarts})`);
      await delay(restartDelayMs * attempt);
    }
  }
}

function sameTarget(a, b) {
  return a.dbPath ? a.dbPath === b.dbPath : a.db === b.db;
}

function launch(job) {
  const config = job.config;
  state.passes += 1;
  const active = { pass: job.pass, dbPath: job.dbPath, startedAt: new Date().toISOString(), threadId: null, progress: null, storedVersion: null, attempts: 0, promise: null };
  state.active = active;
  active.promise = runPass(job, config)
    .then(result => { state.lastResult = result; state.lastError = null; return result; })
    .catch(error => { state.lastError = error.message; return { error: error.message }; })
    .finally(() => {
      if (state.active === active) state.active = null;
      const next = state.queue.shift();
      if (next) launch(next);
    });
  for (const waiter of job.waiters || []) active.promise.then(waiter);
  return active.promise;
}

/**
 * Requests a bulk indexing pass over `db`'s database. Returns immediately:
 * { started, running, queued, inProcess, promise } where promise resolves with
 * the pass result (or { error }), never rejecting. Exactly one pass runs at a
 * time per process; requests made while one runs coalesce into a single
 * follow-up per database. inProcess is true only for in-memory handles.
 */
function requestSearchIndexPass(db, {
  pass = 'catch-up', options = {}, log = console, restarts = DEFAULT_RESTARTS, restartDelayMs = DEFAULT_RESTART_DELAY_MS,
  createWorker = defaultCreateWorker, busyTimeoutMs = 15000,
} = {}) {
  const config = { log, restarts, restartDelayMs, createWorker, busyTimeoutMs };
  const job = { db, dbPath: fileBacked(db) ? db.name : null, pass, options: { ...options }, config, waiters: [] };
  const inProcess = !job.dbPath;
  if (state.active) {
    let resolveWaiter;
    const promise = new Promise(resolve => { resolveWaiter = resolve; });
    const queued = state.queue.find(entry => sameTarget(entry, job));
    if (queued) {
      // Widen the queued pass: an unbounded request beats a capped one.
      if (!Number.isFinite(Number(options.limit))) delete queued.options.limit;
      if (options.destinationDays !== false) delete queued.options.destinationDays;
      if (pass === 'rebuild') queued.pass = 'rebuild';
      if (options.assessmentVersion === true) queued.options.assessmentVersion = true;
      queued.waiters.push(resolveWaiter);
    } else {
      job.waiters.push(resolveWaiter);
      state.queue.push(job);
    }
    return { started: false, running: true, queued: true, inProcess, promise };
  }
  const promise = launch(job);
  return { started: true, running: true, queued: false, inProcess, promise };
}

/**
 * Whether a pass is running in this process, and its last progress: an
 * in-memory snapshot fed by worker messages. Main-thread readers (coverage,
 * status routes) use this while a pass runs instead of sale_watch_meta, so
 * they never touch the rows the worker is writing.
 */
function searchIndexerState() {
  const active = state.active;
  return {
    running: Boolean(active),
    pass: active ? active.pass : null,
    dbPath: active ? active.dbPath : null,
    startedAt: active ? active.startedAt : null,
    threadId: active ? active.threadId : null,
    progress: active ? active.progress : null,
    storedVersion: active ? active.storedVersion : null,
    queued: state.queue.length > 0,
    passes: state.passes,
    restarts: state.restarts,
    lastError: state.lastError,
  };
}

/** The running pass's promise (resolves to its result), or null. */
function currentSearchIndexPass() {
  return state.active ? state.active.promise : null;
}

/** Resolves once no pass is running or queued (tests and shutdown). */
async function searchIndexerIdle() {
  while (state.active) await state.active.promise;
}

module.exports = {
  WORKER_FILE,
  runBulkPass,
  requestSearchIndexPass,
  searchIndexerState,
  currentSearchIndexPass,
  searchIndexerIdle,
};
