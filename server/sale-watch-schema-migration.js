'use strict';

// Main-thread supervisor for the boot-time sale_watch.db schema migration.
//
// 2026-11-07 outage: ensureReconstructionSchema -> ensureAssessmentSchema
// (ALTER, UPDATE, partial CREATE INDEX on a 21 GB database, inside an
// IMMEDIATE transaction) ran synchronously before app.listen, so the server
// sat for over 5 minutes without answering /api/health. The migration now runs
// in the existing Sale Watch child process (server/sale-watch-wave-child.js,
// job type 'migrate') started AFTER listen. This thread opens no sale_watch.db
// handle until the child reports the schema committed; until then every
// feature that needs it reports itself as pending (SaleWatchMigrationPendingError,
// migrationState()) instead of blocking.
//
// Restart safety: the child's statements are idempotent and the assessment
// part is one transaction, so a migration interrupted by a restart rolls back
// and is re-run from the start on the next boot. A failed attempt is retried
// with bounded backoff.

const path = require('node:path');
const child_process = require('node:child_process');

const CHILD_FILE = path.join(__dirname, 'sale-watch-wave-child.js');
const DEFAULT_MAX_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 60 * 1000;
const MAX_RETRY_MS = 30 * 60 * 1000;

function freshState() {
  return { status: 'idle', pid: null, startedAt: null, finishedAt: null, lastMessageAt: null, attempts: 0, durationMs: null, error: null, nextRetryAt: null };
}

let state = freshState();
let active = null;
let retryTimer = null;
let waiters = [];

class SaleWatchMigrationPendingError extends Error {
  constructor(snapshot) {
    super(`Sale Watch schema migration is ${snapshot.status}; this feature is pending until it completes`);
    this.code = 'SALE_WATCH_MIGRATION_PENDING';
    this.migration = snapshot;
  }
}

function migrationState() {
  return { ...state, ready: state.status === 'ready', running: state.status === 'running', healthy: state.status === 'running' || state.status === 'ready' };
}

function isMigrationReady() { return state.status === 'ready'; }

/** Throws SaleWatchMigrationPendingError unless the schema migration has committed. */
function assertMigrationReady() {
  if (state.status !== 'ready') throw new SaleWatchMigrationPendingError(migrationState());
}

/** Resolves once the migration is ready (never rejects; retries continue in the background). */
function whenMigrationReady() {
  if (state.status === 'ready') return Promise.resolve(migrationState());
  return new Promise(resolve => waiters.push(resolve));
}

function defaultFork(file, env) {
  return child_process.fork(file, [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'json' });
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Starts (or joins) the off-main migration. Resolves with migrationState()
 * when this attempt ends; never rejects. Safe to call repeatedly.
 */
function startSchemaMigration(opts = {}) {
  if (state.status === 'ready') return Promise.resolve(migrationState());
  if (active) return active;
  const {
    dbPath, fork = defaultFork, env = process.env, childFile = CHILD_FILE, testHook = null, busyTimeoutMs = 30000,
    log = console, now = Date.now,
  } = opts;
  const maxMs = positive(opts.maxMs, positive(parseInt(env.DOMAINSCOUT_SALE_WATCH_MIGRATION_MAX_MS, 10), DEFAULT_MAX_MS));
  const retryBaseMs = positive(opts.retryBaseMs, DEFAULT_RETRY_BASE_MS);
  if (!dbPath) return Promise.resolve({ ...migrationState(), error: 'startSchemaMigration: dbPath required' });
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  state = { ...state, status: 'running', pid: null, startedAt: new Date(now()).toISOString(), finishedAt: null, lastMessageAt: null, attempts: state.attempts + 1, durationMs: null, error: null, nextRetryAt: null };
  const t0 = now();
  active = new Promise(resolve => {
    let child;
    let migrated = false;
    let failure = null;
    let ceiling = null;
    const finish = exit => {
      if (ceiling) clearTimeout(ceiling);
      active = null;
      state.finishedAt = new Date(now()).toISOString();
      state.durationMs = now() - t0;
      if (migrated) {
        state.status = 'ready';
        log.log?.(`[SaleWatchMigration] schema ready after ${state.durationMs}ms (attempt ${state.attempts})`);
        const w = waiters; waiters = [];
        for (const fn of w) { try { fn(migrationState()); } catch (_) { /* advisory */ } }
      } else {
        state.status = 'failed';
        state.error = failure || `migration child exited (${JSON.stringify(exit)})`;
        const delay = Math.min(MAX_RETRY_MS, retryBaseMs * 2 ** Math.min(10, state.attempts - 1));
        state.nextRetryAt = new Date(now() + delay).toISOString();
        log.warn?.(`[SaleWatchMigration] attempt ${state.attempts} failed: ${state.error}; retrying in ${Math.round(delay / 1000)}s`);
        retryTimer = setTimeout(() => { retryTimer = null; void startSchemaMigration(opts); }, delay);
        retryTimer.unref?.();
      }
      resolve(migrationState());
    };
    try { child = fork(childFile, env); } catch (error) { failure = `spawn failed: ${error.message}`; finish(null); return; }
    state.pid = child.pid || null;
    ceiling = setTimeout(() => {
      failure = `migration exceeded ${maxMs}ms`;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, maxMs);
    ceiling.unref?.();
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      state.lastMessageAt = new Date(now()).toISOString();
      if (message.type === 'migrated') migrated = true;
      else if (message.type === 'error') failure = String(message.error || 'migration failed');
    });
    child.once('error', error => { if (!failure) failure = error.message; });
    child.once('exit', (code, signal) => finish({ code, signal }));
    try { child.send({ type: 'migrate', dbPath, busyTimeoutMs, ...(testHook ? { testHook } : {}) }); }
    catch (error) { failure = `send failed: ${error.message}`; try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } }
  });
  return active;
}

function _resetForTests() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null; active = null; waiters = []; state = freshState();
}

module.exports = {
  CHILD_FILE, SaleWatchMigrationPendingError, migrationState, isMigrationReady, assertMigrationReady,
  whenMigrationReady, startSchemaMigration, _resetForTests,
};
