'use strict';

// Off-main domains.db boot maintenance (2026-11-07 boot audit).
//
// server/db.js used to create dozens of indexes on the 33 GB domains table,
// run whole-table UPDATE/DELETE backfills, the drop_event_daily_counts
// GROUP BY backfill, the FTS rebuild/catch-up and PRAGMA optimize on the HTTP
// server's main thread before listen. The server now requires db.js with
// DOMAINSCOUT_DEFER_DB_MAINTENANCE=1 (cheap metadata schema only), and after
// listen forks this file. The file requires db.js with deferral off, so the
// same idempotent statements run here, in their own process and connection.
// A restart mid-maintenance re-runs it safely: every statement is IF NOT
// EXISTS or guarded, and the dedc setup is one IMMEDIATE transaction.
//
// Used as a module, this file exports the main-thread supervisor
// startDbMaintenance() / dbMaintenanceState().

const path = require('node:path');
const child_process = require('node:child_process');

const CHILD_FILE = __filename;

function runChild() {
  const env = process.env;
  delete env.DOMAINSCOUT_DEFER_DB_MAINTENANCE;
  delete env.DOMAINSCOUT_SKIP_DB_MAINTENANCE;
  const t0 = Date.now();
  let ok = false;
  try {
    const db = require('./db');
    try { db.close(); } catch (_) { /* advisory */ }
    ok = true;
    if (process.send) process.send({ type: 'maintained', durationMs: Date.now() - t0 });
  } catch (error) {
    if (process.send) process.send({ type: 'error', error: String((error && error.message) || error) });
  }
  const exit = () => process.exit(ok ? 0 : 1);
  if (process.connected && process.disconnect) { setImmediate(() => { try { process.disconnect(); } catch (_) { /* ignore */ } exit(); }); } else exit();
}

let state = { status: 'idle', pid: null, startedAt: null, finishedAt: null, durationMs: null, error: null };
let active = null;

function dbMaintenanceState() { return { ...state }; }

function defaultFork(file, env) {
  return child_process.fork(file, ['--run'], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'json' });
}

/** Starts the off-main domains.db maintenance once; resolves with the final state, never rejects. */
function startDbMaintenance(opts = {}) {
  if (active) return active;
  if (state.status === 'done') return Promise.resolve(dbMaintenanceState());
  const { fork = defaultFork, env = process.env, childFile = CHILD_FILE, log = console } = opts;
  state = { status: 'running', pid: null, startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, error: null };
  const t0 = Date.now();
  active = new Promise(resolve => {
    let done = false;
    let failure = null;
    const finish = exit => {
      active = null;
      state.finishedAt = new Date().toISOString();
      state.durationMs = Date.now() - t0;
      if (done) { state.status = 'done'; log.log?.(`[DBMaintenance] domains.db maintenance finished off-main in ${state.durationMs}ms`); }
      else { state.status = 'failed'; state.error = failure || `maintenance child exited (${JSON.stringify(exit)})`; log.warn?.(`[DBMaintenance] failed: ${state.error}; it re-runs on the next boot`); }
      resolve(dbMaintenanceState());
    };
    let child;
    try { child = fork(childFile, { ...env, DOMAINSCOUT_DEFER_DB_MAINTENANCE: '0' }); } catch (error) { failure = `spawn failed: ${error.message}`; finish(null); return; }
    state.pid = child.pid || null;
    child.on('message', m => {
      if (m && m.type === 'maintained') done = true;
      else if (m && m.type === 'error') failure = String(m.error || 'maintenance failed');
    });
    child.once('error', error => { if (!failure) failure = error.message; });
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
  return active;
}

function _resetForTests() { active = null; state = { status: 'idle', pid: null, startedAt: null, finishedAt: null, durationMs: null, error: null }; }

if (require.main === module && process.argv.includes('--run')) runChild();

module.exports = { CHILD_FILE, startDbMaintenance, dbMaintenanceState, _resetForTests };
