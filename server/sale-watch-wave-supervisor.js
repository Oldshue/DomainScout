'use strict';

// Main-thread supervisor for off-main Sale Watch probe waves
// (server/sale-watch-wave-child.js).
//
// The HTTP thread does NO synchronous wave I/O: it forks the child (which
// opens its own sale_watch.db handle), receives heartbeat/stage/done messages
// and keeps an in-memory snapshot for health. A child whose event loop stops
// heartbeating for hangMs (a synchronous SQLite call or fs.readSync stuck in
// disk wait), or that runs past maxMs, is SIGKILLed. The termination is then
// recorded in sale_watch_wave_runs by a second short-lived child, so even
// that write never runs on this thread. One wave runs per process.

const path = require('node:path');
const child_process = require('node:child_process');

const CHILD_FILE = path.join(__dirname, 'sale-watch-wave-child.js');
const DEFAULT_HEARTBEAT_MS = 5000;
const DEFAULT_HANG_MS = 10 * 60 * 1000;
const DEFAULT_MAX_MS = 55 * 60 * 1000;
const DEFAULT_RECORD_TIMEOUT_MS = 2 * 60 * 1000;

const state = {
  active: null, // { pid, startedAt, lastHeartbeatAt, stage, runId, wal, promise }
  lastResult: null,
  lastTermination: null,
  waves: 0,
  terminations: 0,
};

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envMs(name, fallback) {
  return positive(parseInt(process.env[name], 10), fallback);
}

function plain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'function' ? undefined : v)));
}

function defaultFork(file, env) {
  return child_process.fork(file, [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'json' });
}

// Hands a wave's index/assess request to the process-wide indexer controller.
// Only the path is passed: the controller spawns its worker thread with its own
// connection, so this thread opens no database handle.
function defaultRequestIndexPass(dbPath, req) {
  return require('./sale-watch-search-indexer').requestSearchIndexPass({ name: dbPath, memory: false }, req);
}

// Runs one child job; resolves with { messages, exit } and never rejects.
function runChild(job, { fork = defaultFork, env = process.env, onMessage = null, onSpawn = null } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = fork(CHILD_FILE, env); } catch (error) { resolve({ spawnError: error.message, exit: null }); return; }
    if (onSpawn) onSpawn(child);
    child.on('message', message => { if (onMessage) { try { onMessage(message, child); } catch (_) { /* advisory */ } } });
    child.once('error', error => { if (onMessage) { try { onMessage({ type: 'error', error: error.message }, child); } catch (_) { /* advisory */ } } });
    child.once('exit', (code, signal) => resolve({ exit: { code, signal } }));
    try { child.send(job); } catch (error) { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } }
  });
}

/** Records a terminated wave from a fresh child. Bounded; never rejects. */
async function recordTermination(job, { fork, env, timeoutMs = DEFAULT_RECORD_TIMEOUT_MS, log = console } = {}) {
  let recorded = null;
  let timer = null;
  const result = await runChild({ ...job, type: 'record-abandoned' }, {
    fork, env,
    onSpawn: child => { timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } }, timeoutMs); if (timer.unref) timer.unref(); },
    onMessage: message => { if (message && message.type === 'recorded') recorded = Number(message.changes) || 0; },
  });
  if (timer) clearTimeout(timer);
  if (recorded == null) log.warn(`[SaleWatchWave] could not record terminated wave (${JSON.stringify(result.exit || result.spawnError)})`);
  return recorded;
}

/**
 * Runs one probe wave off the main thread. Resolves (never rejects) with the
 * wave summary, { ran:false, reason:'overlap' }, or
 * { ran:false, reason:'terminated'|'error', ... }.
 */
function superviseWave({
  dbPath, options = {}, busyTimeoutMs = 30000, heartbeatMs, hangMs, maxMs, fork = defaultFork, env = process.env,
  log = console, testHook = null, recordTimeoutMs, requestIndexPass = defaultRequestIndexPass,
} = {}) {
  if (state.active) return Promise.resolve({ ran: false, reason: 'overlap', pid: state.active.pid, stage: state.active.stage });
  if (!dbPath) return Promise.resolve({ ran: false, reason: 'error', error: 'superviseWave: dbPath required' });
  const beatMs = positive(heartbeatMs, envMs('DOMAINSCOUT_SALE_WATCH_WAVE_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS));
  const hang = positive(hangMs, envMs('DOMAINSCOUT_SALE_WATCH_WAVE_HANG_MS', DEFAULT_HANG_MS));
  const ceiling = positive(maxMs, envMs('DOMAINSCOUT_SALE_WATCH_WAVE_MAX_MS', DEFAULT_MAX_MS));
  const active = { pid: null, startedAt: Date.now(), lastHeartbeatAt: Date.now(), stage: 'starting', runId: null, wal: null, promise: null };
  state.active = active;
  state.waves += 1;
  active.promise = (async () => {
    let summary = null;
    let failure = null;
    let killed = null;
    let watchdog = null;
    const job = { type: 'run', dbPath, busyTimeoutMs, heartbeatMs: beatMs, options: plain(options), ...(testHook ? { testHook } : {}) };
    const result = await runChild(job, {
      fork, env,
      onSpawn: child => {
        active.pid = child.pid || null;
        watchdog = setInterval(() => {
          if (killed) return;
          const now = Date.now();
          if (now - active.lastHeartbeatAt > hang) killed = `no heartbeat for ${now - active.lastHeartbeatAt}ms in stage ${active.stage}`;
          else if (now - active.startedAt > ceiling) killed = `wave exceeded ${ceiling}ms in stage ${active.stage}`;
          if (killed) {
            log.warn(`[SaleWatchWave] terminating wave pid ${active.pid}: ${killed}`);
            try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
          }
        }, Math.max(10, Math.min(beatMs, Math.floor(hang / 4))));
        if (watchdog.unref) watchdog.unref();
      },
      onMessage: message => {
        if (!message || typeof message !== 'object') return;
        active.lastHeartbeatAt = Date.now();
        if (message.type === 'run') active.runId = message.runId;
        else if (message.type === 'stage') { active.stage = message.stage; if (message.wal) active.wal = message.wal; }
        else if (message.type === 'index-request') {
          try { requestIndexPass(dbPath, { pass: message.pass || 'wave', options: message.options || {} }); }
          catch (error) { log.warn(`[SaleWatchWave] index request failed: ${error.message}`); }
        }
        else if (message.type === 'done') summary = message.summary;
        else if (message.type === 'error') failure = message.error;
      },
    });
    if (watchdog) clearInterval(watchdog);
    if (summary && !killed) return summary;
    const reason = killed ? 'terminated' : 'error';
    const detail = killed || failure || `wave child exited (${JSON.stringify(result.exit || result.spawnError)})`;
    const recorded = await recordTermination({ dbPath, busyTimeoutMs, runId: active.runId, stage: active.stage, startedAt: new Date(active.startedAt).toISOString(), reason: 'abandoned', detail },
      { fork, env, log, timeoutMs: positive(recordTimeoutMs, DEFAULT_RECORD_TIMEOUT_MS) });
    if (killed) {
      state.terminations += 1;
      state.lastTermination = { at: new Date().toISOString(), runId: active.runId, stage: active.stage, detail, recorded };
    }
    log.warn(`[SaleWatchWave] wave ${reason}: ${detail}`);
    return { ran: false, reason, error: detail, runId: active.runId, stage: active.stage, recorded, stageErrors: [{ stage: active.stage, error: detail, code: killed ? 'WAVE_TERMINATED' : 'WAVE_CHILD_FAILED' }] };
  })().then(value => { state.lastResult = { at: new Date().toISOString(), reason: value && value.reason || null }; return value; })
    .finally(() => { if (state.active === active) state.active = null; });
  return active.promise;
}

/** In-memory supervisor snapshot (no database access). */
function waveSupervisorState() {
  const a = state.active;
  return {
    running: Boolean(a),
    pid: a ? a.pid : null,
    startedAt: a ? new Date(a.startedAt).toISOString() : null,
    lastHeartbeatAt: a ? new Date(a.lastHeartbeatAt).toISOString() : null,
    stage: a ? a.stage : null,
    runId: a ? a.runId : null,
    wal: a ? a.wal : null,
    waves: state.waves,
    terminations: state.terminations,
    lastTermination: state.lastTermination,
    lastResult: state.lastResult,
  };
}

module.exports = { CHILD_FILE, superviseWave, waveSupervisorState, recordTermination, DEFAULT_HANG_MS, DEFAULT_HEARTBEAT_MS };
