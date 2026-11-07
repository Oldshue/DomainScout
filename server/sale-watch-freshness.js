'use strict';

// Sale Watch freshness contract: GET /api/sale-watch/freshness.
//
// One verdict (current | degraded | stale) plus the parts it was derived
// from. The same evaluateFreshness() result drives the Probably sold status
// line and the out-of-process watchdog (bin/sale-watch-watchdog.js), so the
// page and the watchdog can never disagree.
//
// readFreshnessParts() runs in the db-read worker (operation
// 'sale-watch.freshness'): only indexed / LIMIT 1 reads, a directory listing
// of day folders, and stat/statfs calls. It never scans a table or reads the
// discovery file's contents. Supervisor state (in-memory, main thread) is
// merged in by the route.
//
// 2026-11 outage: every hourly wave failed for three days and nothing outside
// the app noticed. A missing movement day is a failure, never a pass.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'domainscout.sale-watch-freshness/v1';
const VERDICTS = Object.freeze(['current', 'degraded', 'stale']);

// ── Thresholds ──────────────────────────────────────────────────────────
/** A clean wave must have finished within this window. */
const CLEAN_WAVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Consecutive failed waves that make the verdict stale (one is degraded). */
const WAVE_FAILURES_STALE = 2;
/**
 * The daily CZDS tape is pulled at 07:05 UTC (DOMAINSCOUT_UNIVERSE_PULL_CRON)
 * and normally lands within two hours; from this UTC hour today's movement
 * must be imported, before it yesterday's must.
 */
const MOVEMENT_TAPE_READY_UTC_HOUR = 9;
/** Movement days checked for gaps (every day in the window must be imported). */
const MOVEMENT_GAP_WINDOW_DAYS = 7;
/** A dirty assessment backlog must drain within this window. */
const DIRTY_BACKLOG_MAX_AGE_MS = 60 * 60 * 1000;
/** Discovery file: degraded from this share of its limit, stale past the limit. */
const DISCOVERY_WARN_RATIO = 0.75;
/** WAL: degraded past its journal size limit, stale past this many bytes. */
const WAL_STALE_BYTES = 2 * 1024 * 1024 * 1024;
/** Disk headroom on the data volume. */
const DISK_DEGRADED_FREE_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_STALE_FREE_BYTES = 1 * 1024 * 1024 * 1024;
/** A running wave whose heartbeat is older than this is stuck, not a healthy long pass. */
const WAVE_HEARTBEAT_STALE_MS = 15 * 60 * 1000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function dayMinus(day, n) { return isoDay(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS); }

/** The movement day that must be imported at `nowMs`. */
function expectedMovementDay(nowMs) {
  const d = new Date(nowMs);
  return d.getUTCHours() >= MOVEMENT_TAPE_READY_UTC_HOUR ? isoDay(nowMs) : isoDay(nowMs - DAY_MS);
}

function safe(fn, fallback = null) { try { return fn(); } catch (_) { return fallback; } }

/** Day folders under the universe work dir that carry a movement tape. */
function availableMovementDays(directory, { limit = MOVEMENT_GAP_WINDOW_DAYS + 1 } = {}) {
  if (!directory) return null;
  let names;
  try { names = fs.readdirSync(directory).filter(n => DAY_RE.test(n)).sort(); } catch (error) { return error.code === 'ENOENT' ? [] : null; }
  const lane = require('./universe-lane');
  const out = [];
  for (let i = names.length - 1; i >= 0 && out.length < limit; i -= 1) {
    if (safe(() => lane.dayMovementTapes(directory, names[i]).length, 0) > 0) out.push(names[i]);
  }
  return out.reverse();
}

function fileBytes(file) {
  if (!file) return null;
  try { return fs.statSync(file).size; } catch (error) { return error.code === 'ENOENT' ? 0 : null; }
}

function diskFree(dir, statfs = fs.statfsSync) {
  if (!dir || typeof statfs !== 'function') return null;
  try { const s = statfs(dir); return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }; } catch (_) { return null; }
}

/**
 * Collects the contract's parts from cheap reads. `db` is a sale_watch.db
 * handle (read-only is fine). Never throws: an unreadable part is null and
 * evaluateFreshness treats null as a failure.
 */
function readFreshnessParts(db, params = {}, deps = {}) {
  const nowMs = Number.isFinite(Date.parse(params.now)) ? Date.parse(params.now) : Date.now();
  const recon = require('./sale-watch-reconstruction');
  const assessments = require('./sale-watch-assessments');
  const health = safe(() => recon.waveHealth(db, { scan: 48 }), null);
  const lastRun = safe(() => db.prepare('SELECT id, started_at, finished_at, stage FROM sale_watch_wave_runs ORDER BY id DESC LIMIT 1').get(), null);
  const imported = safe(() => db.prepare('SELECT day, imported_at FROM sale_watch_movement_imports ORDER BY day DESC LIMIT ?').all(MOVEMENT_GAP_WINDOW_DAYS + 1), null);
  const available = deps.availableMovementDays ? deps.availableMovementDays(params.movementDir) : availableMovementDays(params.movementDir);
  const dirtyCount = safe(() => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${assessments.TABLE} WHERE dirty = 1`).get().n) || 0, null);
  const oldestDirty = dirtyCount ? safe(() => db.prepare(`SELECT MIN(dirty_since) AS at FROM ${assessments.TABLE} WHERE dirty = 1`).get().at, null) : null;
  const store = safe(() => assessments.ledgerStoreStatus(db, { counts: false }), null);
  const staleVersion = safe(() => db.prepare(`SELECT 1 AS x FROM ${assessments.TABLE} WHERE version IS NULL OR version <> ? LIMIT 1`).get(store && store.currentVersion), undefined);
  const newestProbable = safe(() => db.prepare(`SELECT report_date FROM ${assessments.VIEWS_TABLE} WHERE view = 'probable' ORDER BY report_date DESC LIMIT 1`).get(), undefined);
  const discoveryLimit = Number(params.discoveryLimitBytes) || require('./sale-watch-discovery-io').V8_MAX_STRING_LENGTH;
  return {
    now: new Date(nowMs).toISOString(),
    wave: health ? {
      lastCleanFinishedAt: health.lastCleanFinishedAt,
      consecutiveFailures: health.consecutiveFailures,
      failingSince: health.failingSince,
      failingStages: [...new Set((health.lastStageErrors || []).map(e => e && e.stage).filter(Boolean))],
      lastFailureReason: health.lastFailureReason,
      inProgressSince: lastRun && !lastRun.finished_at ? lastRun.started_at : null,
      inProgressStage: lastRun && !lastRun.finished_at ? lastRun.stage : null,
    } : null,
    movement: {
      latestImportedDay: imported && imported[0] ? imported[0].day : null,
      latestImportedAt: imported && imported[0] ? imported[0].imported_at : null,
      importedDays: imported ? imported.map(r => r.day).sort() : null,
      newestAvailableDay: Array.isArray(available) && available.length ? available[available.length - 1] : null,
      availableDays: available,
      expectedDay: expectedMovementDay(nowMs),
    },
    discovery: { bytes: fileBytes(params.discoveryPath), limitBytes: discoveryLimit },
    wal: { bytes: safe(() => recon.walFileBytes(db), null), limitBytes: recon.SALE_WATCH_JOURNAL_SIZE_LIMIT },
    assessments: {
      dirtyBacklog: dirtyCount,
      oldestDirtyAt: oldestDirty || null,
      version: store ? store.version : null,
      currentVersion: store ? store.currentVersion : null,
      versionComplete: Boolean(store && store.complete && staleVersion === undefined),
    },
    probableList: { newestReportDate: newestProbable && newestProbable.report_date ? newestProbable.report_date : null },
    disk: diskFree(params.dataDir, deps.statfs),
  };
}

function add(checks, name, status, detail) { checks.push({ name, status, detail }); }

/**
 * Pure verdict. `supervisor` is waveSupervisorState() from the main thread
 * (optional). Each check is ok | degraded | stale; the verdict is the worst.
 */
function evaluateFreshness(parts, { now, supervisor = null } = {}) {
  const nowMs = Number.isFinite(Date.parse(now)) ? Date.parse(now) : (Number.isFinite(Date.parse(parts && parts.now)) ? Date.parse(parts.now) : Date.now());
  const checks = [];
  const p = parts || {};

  // Wave
  const w = p.wave;
  if (!w) add(checks, 'wave', 'stale', 'wave history unreadable');
  else {
    const cleanAge = w.lastCleanFinishedAt ? nowMs - Date.parse(w.lastCleanFinishedAt) : Infinity;
    if (w.consecutiveFailures >= WAVE_FAILURES_STALE) add(checks, 'wave', 'stale', `${w.consecutiveFailures} consecutive failed waves (${(w.failingStages || []).join(', ') || w.lastFailureReason || 'unknown stage'})`);
    else if (!(cleanAge <= CLEAN_WAVE_MAX_AGE_MS)) add(checks, 'wave', 'stale', w.lastCleanFinishedAt ? `last clean wave finished ${Math.round(cleanAge / 60000)} min ago` : 'no clean wave recorded');
    else if (w.consecutiveFailures > 0) add(checks, 'wave', 'degraded', `last wave failed (${(w.failingStages || []).join(', ') || w.lastFailureReason || 'unknown'})`);
    else add(checks, 'wave', 'ok', `clean wave ${Math.round(cleanAge / 60000)} min ago`);
  }
  // Running wave: healthy long pass vs stuck.
  let waveRunning = null;
  if (supervisor && supervisor.running) {
    const beatAge = supervisor.lastHeartbeatAt ? nowMs - Date.parse(supervisor.lastHeartbeatAt) : Infinity;
    waveRunning = { healthy: beatAge <= WAVE_HEARTBEAT_STALE_MS, startedAt: supervisor.startedAt, lastHeartbeatAt: supervisor.lastHeartbeatAt, stage: supervisor.stage };
    if (!waveRunning.healthy) add(checks, 'wave-heartbeat', 'stale', `running wave silent for ${Math.round(beatAge / 1000)} s in ${supervisor.stage || 'unknown'}`);
  }

  // Movement: the expected day, and every available/recent day, must be imported.
  const m = p.movement || {};
  const imported = new Set(m.importedDays || []);
  if (!m.importedDays) add(checks, 'movement', 'stale', 'movement imports unreadable');
  else {
    const missing = [];
    const expected = m.expectedDay || expectedMovementDay(nowMs);
    if (!imported.has(expected) && !(m.latestImportedDay && m.latestImportedDay > expected)) missing.push(expected);
    for (const day of m.availableDays || []) if (day <= expected && !imported.has(day) && !missing.includes(day)) missing.push(day);
    // Gaps between imported days inside the window (a skipped day is never a pass).
    const sorted = [...imported].filter(d => d <= expected).sort();
    const from = dayMinus(expected, MOVEMENT_GAP_WINDOW_DAYS - 1);
    if (sorted.length) for (let d = sorted[0] > from ? sorted[0] : from; d < expected; d = dayMinus(d, -1)) if (!imported.has(d) && !missing.includes(d)) missing.push(d);
    missing.sort();
    if (missing.length) add(checks, 'movement', 'stale', `movement day${missing.length > 1 ? 's' : ''} not imported: ${missing.join(', ')}`);
    else add(checks, 'movement', 'ok', `imported through ${m.latestImportedDay}`);
    if (m.newestAvailableDay && m.latestImportedDay && m.newestAvailableDay > m.latestImportedDay && !missing.length) add(checks, 'movement-available', 'degraded', `${m.newestAvailableDay} available, imported through ${m.latestImportedDay}`);
  }

  // Discovery file
  const disc = p.discovery || {};
  if (disc.bytes == null) add(checks, 'discovery', 'degraded', 'discovery file size unknown');
  else if (disc.bytes > disc.limitBytes) add(checks, 'discovery', 'stale', `discovery file ${disc.bytes} B over limit ${disc.limitBytes} B`);
  else if (disc.bytes > disc.limitBytes * DISCOVERY_WARN_RATIO) add(checks, 'discovery', 'degraded', `discovery file at ${Math.round(100 * disc.bytes / disc.limitBytes)}% of limit`);
  else add(checks, 'discovery', 'ok', `${disc.bytes} B`);

  // WAL
  const wal = p.wal || {};
  if (wal.bytes == null) add(checks, 'wal', 'ok', 'no wal file');
  else if (wal.bytes > WAL_STALE_BYTES) add(checks, 'wal', 'stale', `wal ${wal.bytes} B`);
  else if (wal.bytes > wal.limitBytes) add(checks, 'wal', 'degraded', `wal ${wal.bytes} B over ${wal.limitBytes} B`);
  else add(checks, 'wal', 'ok', `${wal.bytes} B`);

  // Assessments
  const a = p.assessments || {};
  if (a.dirtyBacklog == null) add(checks, 'assessments', 'stale', 'assessment backlog unreadable');
  else if (a.dirtyBacklog > 0) {
    const age = a.oldestDirtyAt ? nowMs - Date.parse(a.oldestDirtyAt) : null;
    if (age == null || !Number.isFinite(age)) add(checks, 'assessments', 'degraded', `${a.dirtyBacklog} dirty, oldest age unknown`);
    else if (age > DIRTY_BACKLOG_MAX_AGE_MS) add(checks, 'assessments', 'stale', `${a.dirtyBacklog} dirty, oldest ${Math.round(age / 60000)} min`);
    else add(checks, 'assessments', 'ok', `${a.dirtyBacklog} dirty, oldest ${Math.round(age / 60000)} min`);
  } else add(checks, 'assessments', 'ok', 'no dirty backlog');
  if (!a.versionComplete) add(checks, 'assessment-version', 'degraded', `stored assessments on ${a.version || 'none'}, current ${a.currentVersion || 'unknown'}`);

  // Probably sold list
  const newest = p.probableList && p.probableList.newestReportDate;
  if (!newest) add(checks, 'probable-list', 'degraded', 'Probably sold list is empty');
  else add(checks, 'probable-list', 'ok', `newest report ${newest}`);

  // Disk
  const disk = p.disk;
  if (!disk) add(checks, 'disk', 'degraded', 'disk headroom unknown');
  else if (disk.freeBytes < DISK_STALE_FREE_BYTES) add(checks, 'disk', 'stale', `${disk.freeBytes} B free`);
  else if (disk.freeBytes < DISK_DEGRADED_FREE_BYTES) add(checks, 'disk', 'degraded', `${disk.freeBytes} B free`);
  else add(checks, 'disk', 'ok', `${disk.freeBytes} B free`);

  const rank = { ok: 0, degraded: 1, stale: 2 };
  const worst = checks.reduce((n, c) => Math.max(n, rank[c.status]), 0);
  const verdict = VERDICTS[worst];
  const failing = checks.filter(c => c.status !== 'ok');
  return {
    schema: SCHEMA,
    verdict,
    checkedAt: new Date(nowMs).toISOString(),
    reasons: failing.map(c => `${c.name}: ${c.detail}`),
    checks,
    waveRunning,
    parts: p,
    thresholds: {
      cleanWaveMaxAgeMs: CLEAN_WAVE_MAX_AGE_MS, waveFailuresStale: WAVE_FAILURES_STALE,
      movementTapeReadyUtcHour: MOVEMENT_TAPE_READY_UTC_HOUR, movementGapWindowDays: MOVEMENT_GAP_WINDOW_DAYS,
      dirtyBacklogMaxAgeMs: DIRTY_BACKLOG_MAX_AGE_MS, discoveryWarnRatio: DISCOVERY_WARN_RATIO,
      walStaleBytes: WAL_STALE_BYTES, diskDegradedFreeBytes: DISK_DEGRADED_FREE_BYTES, diskStaleFreeBytes: DISK_STALE_FREE_BYTES,
      waveHeartbeatStaleMs: WAVE_HEARTBEAT_STALE_MS,
    },
  };
}

/** One-line page status for a verdict (shared wording with the watchdog summary). */
function freshnessStatusLine(result) {
  if (!result || !VERDICTS.includes(result.verdict)) return 'Freshness unknown';
  const head = { current: 'Current', degraded: 'Degraded', stale: 'Stale' }[result.verdict];
  return result.reasons && result.reasons.length ? `${head}: ${result.reasons.slice(0, 2).join('; ')}` : head;
}

module.exports = {
  SCHEMA, VERDICTS,
  CLEAN_WAVE_MAX_AGE_MS, WAVE_FAILURES_STALE, MOVEMENT_TAPE_READY_UTC_HOUR, MOVEMENT_GAP_WINDOW_DAYS,
  DIRTY_BACKLOG_MAX_AGE_MS, DISCOVERY_WARN_RATIO, WAL_STALE_BYTES, DISK_DEGRADED_FREE_BYTES, DISK_STALE_FREE_BYTES,
  WAVE_HEARTBEAT_STALE_MS,
  expectedMovementDay, availableMovementDays, readFreshnessParts, evaluateFreshness, freshnessStatusLine,
};
