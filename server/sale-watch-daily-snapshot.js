'use strict';

// Sale Watch daily feed snapshot (2026-11-12 production failure: the 14-day
// window was computed from the database inside the request and a cold boot
// answered 503 for three minutes). The complete default window is built by a
// background producer through a Sale Watch read lane with its own long
// deadline, held in main-process memory, and written atomically (temp file +
// rename) beside the database. GET /api/sale-watch/daily answers from memory
// only; the request path never touches the database. A failed or slow rebuild
// keeps the previous snapshot, retries with backoff, and shows up as its own
// freshness check (stale past 30 minutes).

const fs = require('fs');
const path = require('path');
const ins = require('./sale-watch-insights');

const SNAPSHOT_FILE = 'sale-watch-daily-snapshot.json';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const BOOT_DELAY_MS = 15 * 1000;
const STALE_MS = 30 * 60 * 1000;
const BACKOFF_MS = Object.freeze([10000, 30000, 60000, 120000, 300000]);

function validSnapshot(s) {
  return !!(s && typeof s === 'object' && s.schema === ins.SNAPSHOT_SCHEMA && s.status === 'ready' && Array.isArray(s.rows)
    && typeof s.from === 'string' && typeof s.to === 'string' && Number.isFinite(Date.parse(s.generatedAt)));
}

/** Reads a snapshot file synchronously (boot only); null when absent or invalid. */
function readSnapshotFile(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return validSnapshot(s) ? s : null; } catch (_) { return null; }
}

/** Atomic write: same-directory temp file, then rename over the target. */
async function writeSnapshotFile(file, snapshot) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(snapshot));
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * options.file       snapshot path (data volume, beside sale_watch.db)
 * options.build()    -> Promise<snapshot>; runs off-main in a read lane
 * options.enrich(s)  optional -> Promise<snapshot> (e.g. verified extension counts)
 */
function createDailySnapshotStore({ file, build, enrich = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  intervalMs = REFRESH_INTERVAL_MS, bootDelayMs = BOOT_DELAY_MS, backoffMs = BACKOFF_MS, log = console } = {}) {
  if (typeof build !== 'function') throw new Error('createDailySnapshotStore requires build()');
  const state = { snapshot: null, loadedFrom: null, running: null, failures: 0, lastError: null, lastAttemptAt: null, lastSuccessAt: null, timer: null, interval: null };

  function loadFromFile() {
    const s = file ? readSnapshotFile(file) : null;
    if (s) { state.snapshot = s; state.loadedFrom = 'file'; }
    return s;
  }

  function schedule(ms) {
    if (state.timer) clearTimer(state.timer);
    state.timer = setTimer(() => { state.timer = null; void refresh('retry'); }, ms);
    if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
  }

  function refresh(reason = 'manual') {
    if (state.running) return state.running;
    state.lastAttemptAt = new Date(now()).toISOString();
    // The body must not run synchronously: a build() that throws before its
    // first await (the migration guard does) would reach `finally` before the
    // promise is assigned below, leaving state.running set forever and every
    // later refresh, retry and interval tick returning that settled promise.
    state.running = (async () => {
      await null;
      try {
        let s = await build();
        if (!s || s.status !== 'ready') throw new Error(s && s.status === 'pending' ? 'ledger pending' : 'snapshot build returned nothing');
        if (enrich) { try { s = (await enrich(s)) || s; } catch (error) { log.warn?.(`[SaleWatchSnapshot] enrich failed: ${error.message}`); } }
        if (!validSnapshot(s)) throw new Error('snapshot build returned an invalid snapshot');
        state.snapshot = s; state.loadedFrom = 'producer'; state.failures = 0; state.lastError = null; state.lastSuccessAt = new Date(now()).toISOString();
        if (file) { try { await writeSnapshotFile(file, s); } catch (error) { log.warn?.(`[SaleWatchSnapshot] write failed: ${error.message}`); } }
        return { ok: true, reason };
      } catch (error) {
        state.failures += 1;
        state.lastError = String((error && error.message) || error);
        log.warn?.(`[SaleWatchSnapshot] rebuild failed (${reason}, attempt ${state.failures}): ${state.lastError}`);
        schedule(backoffMs[Math.min(state.failures - 1, backoffMs.length - 1)]);
        return { ok: false, reason, error: state.lastError };
      } finally { state.running = null; }
    })();
    return state.running;
  }

  function start() {
    schedule(bootDelayMs);
    if (!state.interval) {
      state.interval = setInterval(() => { void refresh('interval'); }, intervalMs);
      if (typeof state.interval.unref === 'function') state.interval.unref();
    }
  }
  function stop() { if (state.timer) clearTimer(state.timer); if (state.interval) clearInterval(state.interval); state.timer = null; state.interval = null; }

  /** Freshness contract check: daily-snapshot. */
  function freshnessCheck() {
    const s = state.snapshot;
    if (!s) return { name: 'daily-snapshot', status: state.failures ? 'stale' : 'pending', detail: state.failures ? `no snapshot; ${state.failures} failed builds (${state.lastError})` : 'first snapshot building' };
    const ageMs = now() - Date.parse(s.generatedAt);
    const age = `${Math.round(ageMs / 60000)} min old`;
    if (ageMs > STALE_MS) return { name: 'daily-snapshot', status: 'stale', detail: `snapshot ${age}${state.lastError ? `; last build failed: ${state.lastError}` : ''}` };
    if (state.failures) return { name: 'daily-snapshot', status: 'degraded', detail: `snapshot ${age}; ${state.failures} failed builds (${state.lastError})` };
    return { name: 'daily-snapshot', status: 'ok', detail: `snapshot ${age}` };
  }

  /** Answers GET /api/sale-watch/daily from memory. rawQuery is req.query. */
  function serve(rawQuery = {}) {
    const s = state.snapshot;
    if (!s) {
      void refresh('first-request');
      return { schema: ins.DAILY_SCHEMA, status: 'pending', producer: 'started', detail: 'No Sale Watch snapshot exists yet; the producer is building the first one', days: [], pagination: { nextCursor: null } };
    }
    const explicitWindow = !!(rawQuery.from || rawQuery.to);
    // Default window = the snapshot's window, so cursors minted from it stay valid across midnight.
    const query = ins.normalizeDailyQuery(rawQuery, { now: explicitWindow ? null : `${s.to}T12:00:00Z` });
    const from = query.from < s.from ? s.from : query.from;
    const to = query.to > s.to ? s.to : query.to;
    const page = ins.serveDailyFromSnapshot(s, { ...query, from, to, explicitWindow: true });
    page.snapshot = { generatedAt: s.generatedAt, ledgerVersion: s.ledgerVersion, refreshing: !!state.running, failures: state.failures };
    return page;
  }

  return { loadFromFile, refresh, start, stop, serve, freshnessCheck, current: () => state.snapshot, _state: state };
}

module.exports = { SNAPSHOT_FILE, REFRESH_INTERVAL_MS, STALE_MS, BACKOFF_MS, validSnapshot, readSnapshotFile, writeSnapshotFile, createDailySnapshotStore };
