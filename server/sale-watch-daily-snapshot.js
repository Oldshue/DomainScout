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
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validSnapshot(s)) return null;
    // A file written before rows carried derived.sold/soldReason cannot say which
    // rows are sold; drop it so the producer rebuilds rather than guessing.
    if (s.rows.some(r => r && r.derived && !(r.discovery || r.reconstruction || r.assessment) && typeof r.derived.sold !== 'boolean')) return null;
    // A file written before slim rows (2026-11-12 OOM) carries every row's
    // evidence; slim it once on load so the fat rows never stay resident.
    if (s.rows.some(r => r && (r.discovery || r.reconstruction || r.assessment))) s.rows = s.rows.map(r => (r && (r.discovery || r.reconstruction || r.assessment) ? ins.slimRow(r) : r));
    return s;
  } catch (_) { return null; }
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
  intervalMs = REFRESH_INTERVAL_MS, bootDelayMs = BOOT_DELAY_MS, backoffMs = BACKOFF_MS, log = console, onSuccess = null, checkName = 'daily-snapshot' } = {}) {
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
        if (onSuccess) { try { onSuccess(reason); } catch (_) { /* a follower never fails this build */ } }
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
    const name = checkName;
    if (!s) return { name, status: state.failures ? 'stale' : 'pending', detail: state.failures ? `no snapshot; ${state.failures} failed builds (${state.lastError})` : 'first snapshot building' };
    const ageMs = now() - Date.parse(s.generatedAt);
    const age = `${Math.round(ageMs / 60000)} min old`;
    if (ageMs > STALE_MS) return { name, status: 'stale', detail: `snapshot ${age}${state.lastError ? `; last build failed: ${state.lastError}` : ''}` };
    if (state.failures) return { name, status: 'degraded', detail: `snapshot ${age}; ${state.failures} failed builds (${state.lastError})` };
    return { name, status: 'ok', detail: `snapshot ${age}` };
  }

  /** Answers GET /api/sale-watch/daily from memory. rawQuery is req.query. */
  function serve(rawQuery = {}) {
    const s = state.snapshot;
    if (!s) {
      void refresh('first-request');
      return { schema: ins.DAILY_SCHEMA, status: 'pending', producer: 'started', detail: 'No Sale Watch snapshot exists yet; the producer is building the first one', days: [], pagination: { nextCursor: null } };
    }
    // The snapshot set picks the window; the store answers over its own rows.
    const { window: _window, ...rest } = rawQuery || {};
    const explicitWindow = !!(rest.from || rest.to);
    // Default window = the snapshot's window, so cursors minted from it stay valid across midnight.
    const query = ins.normalizeDailyQuery(explicitWindow ? rest : { ...rest, from: s.from, to: s.to });
    const from = query.from < s.from ? s.from : query.from;
    const to = query.to > s.to ? s.to : query.to;
    const page = ins.serveDailyFromSnapshot(s, { ...query, from, to, explicitWindow: true });
    page.snapshot = { generatedAt: s.generatedAt, ledgerVersion: s.ledgerVersion, windowDays: s.windowDays || null, refreshing: !!state.running, failures: state.failures };
    return page;
  }

  return { loadFromFile, refresh, start, stop, serve, freshnessCheck, current: () => state.snapshot, _state: state };
}

// ── one snapshot per window (14 / 30 / 90 days) ────────────────────────────
// The 14-day store is the primary: it alone has the boot timer and refresh
// interval, and its build never waits on anything else. After each successful
// 14-day build the 30- and 90-day stores refresh one after another (lower
// priority, at most once per secondaryIntervalMs each), each with the same
// atomic file + memory pattern and its own generatedAt. A window with no
// snapshot yet answers from the largest existing window with a building note.
const SECONDARY_INTERVAL_MS = 15 * 60 * 1000;
function snapshotFileFor(days, primaryDays = 14) { return days === primaryDays ? SNAPSHOT_FILE : `sale-watch-daily-snapshot-${days}d.json`; }

function parseWindow(raw, windows) {
  if (raw === undefined || raw === '' || raw === null) return windows[0];
  if (!/^\d+$/.test(String(raw)) || !windows.includes(Number(raw))) throw new ins.InsightQueryError(`window: must be one of ${windows.join(', ')}`);
  return Number(raw);
}

/** options as createDailySnapshotStore, but build(days) and dir instead of file. */
function createDailySnapshotSet({ dir = null, build, enrich = null, windows = ins.DAILY_WINDOWS, secondaryIntervalMs = SECONDARY_INTERVAL_MS, now = Date.now, ...common } = {}) {
  if (typeof build !== 'function') throw new Error('createDailySnapshotSet requires build(days)');
  const primaryDays = windows[0];
  const stores = new Map();
  let chain = null;
  function refreshSecondaries(reason) {
    if (chain) return chain;
    chain = (async () => {
      await null;
      try {
        for (const days of windows.slice(1)) {
          const st = stores.get(days);
          const last = Date.parse(st._state.lastSuccessAt || '');
          if (st.current() && Number.isFinite(last) && now() - last < secondaryIntervalMs) continue;
          await st.refresh(`after-${primaryDays}d-${reason}`);
        }
      } finally { chain = null; }
    })();
    return chain;
  }
  for (const days of windows) {
    stores.set(days, createDailySnapshotStore({
      ...common, now,
      file: dir ? path.join(dir, snapshotFileFor(days, primaryDays)) : null,
      build: () => build(days), enrich,
      onSuccess: days === primaryDays ? (reason) => { void refreshSecondaries(reason); } : null,
      checkName: days === primaryDays ? 'daily-snapshot' : `daily-snapshot-${days}d`,
    }));
  }
  const primary = stores.get(primaryDays);
  const available = () => windows.filter(d => stores.get(d).current());

  function serve(rawQuery = {}) {
    const want = parseWindow(rawQuery.window, windows);
    const st = stores.get(want);
    if (st.current()) return { ...st.serve(rawQuery), windowDays: want, requestedWindow: want, windows: available() };
    const have = [...windows].reverse().find(d => stores.get(d).current());
    if (!have) return primary.serve(rawQuery);
    if (want !== primaryDays && !st._state.running && !chain) void refreshSecondaries('requested');
    const page = stores.get(have).serve({ ...rawQuery, window: undefined });
    return { ...page, windowDays: have, requestedWindow: want, windows: available(),
      building: { windowDays: want, note: `building ${want}-day view; showing the ${have}-day view meanwhile` } };
  }

  function freshnessCheck() {
    const check = primary.freshnessCheck();
    const others = windows.slice(1).map(d => { const c = stores.get(d).freshnessCheck(); return `${d}d ${c.status}: ${c.detail}`; });
    return { ...check, detail: `${check.detail}; ${others.join('; ')}` };
  }

  return {
    loadFromFile: () => { const out = {}; for (const [d, st] of stores) out[d] = !!st.loadFromFile(); return out; },
    refresh: (reason) => primary.refresh(reason),
    refreshSecondaries,
    start: () => primary.start(),
    stop: () => { for (const st of stores.values()) st.stop(); },
    serve, freshnessCheck, available,
    current: (days = primaryDays) => (stores.get(days) ? stores.get(days).current() : null),
    store: (days) => stores.get(days),
  };
}

module.exports = { SNAPSHOT_FILE, REFRESH_INTERVAL_MS, STALE_MS, BACKOFF_MS, SECONDARY_INTERVAL_MS, validSnapshot, readSnapshotFile, writeSnapshotFile, snapshotFileFor, createDailySnapshotStore, createDailySnapshotSet };
