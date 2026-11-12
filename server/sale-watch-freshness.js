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
/**
 * WAL: journal_size_limit is the size the file is truncated back to after a
 * checkpoint, not a ceiling between checkpoints: a healthy wave overshoots it
 * for seconds while a reader delays the reset (2026-11-12: 83 MB for under a
 * minute, then back to the limit). Degraded past this multiple of the limit,
 * stale past WAL_STALE_BYTES.
 */
const WAL_DEGRADED_LIMIT_MULTIPLE = 4;
const WAL_STALE_BYTES = 2 * 1024 * 1024 * 1024;
/** Disk headroom on the data volume. */
const DISK_DEGRADED_FREE_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_STALE_FREE_BYTES = 1 * 1024 * 1024 * 1024;
/** A running wave whose heartbeat is older than this is stuck, not a healthy long pass. */
const WAVE_HEARTBEAT_STALE_MS = 15 * 60 * 1000;
/**
 * A rebuild to a new classifier version keeps serving the previous verdicts,
 * so it is informational while it makes progress. It is degraded only when
 * its last committed batch is older than this.
 */
const REBUILD_STALL_MS = 60 * 60 * 1000;
/**
 * Oldest seller / marketplace departure inside the follow-up window still
 * missing its first RDAP check or first probe (2026-11-07: a clean wave hid a
 * backlog of unchecked departures). Age counts from arrival: the later of the
 * departure day, the import of that movement day and, when the latest clean
 * wave left no seller departure unchecked, the start of that wave.
 */
const SELLER_BACKLOG_DEGRADED_MS = 2 * 60 * 60 * 1000;
const SELLER_BACKLOG_STALE_MS = 6 * 60 * 60 * 1000;
const SELLER_BACKLOG_WINDOW_DAYS = 14;
/** Rows a rescoring pass turned into unchecked seller departures, with the time it did (written by reassessStoredEvidence). */
const SELLER_ADMISSIONS_TABLE = 'sale_watch_seller_admissions';
/** Up to this many unchecked rows are read with their admission time; a larger backlog ages from its oldest departure day. */
const SELLER_BACKLOG_ADMISSION_ROWS = 2000;

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

/**
 * Unchecked seller departures from the partial seller index on the candidate
 * keys (no candidates scan): { ready, unchecked, oldestDay, oldestArrivedAt }.
 * ready false while the keys are still being backfilled.
 */
function readSellerBacklog(db, nowMs) {
  const K = require('./sale-watch-candidate-keys');
  if (!K.candidateKeysReady(db)) {
    const meta = safe(() => K.candidateKeysProgress(db), null);
    const progress = meta ? { rid: Number(meta.rid) || 0, maxRid: Number(meta.maxRid) || null, rowsPerSec: Number(meta.rowsPerSec) || null } : null;
    return { ready: false, unchecked: null, oldestDay: null, oldestArrivedAt: null, progress };
  }
  const T = K.TABLE;
  const cutoff = isoDay(nowMs - SELLER_BACKLOG_WINDOW_DAYS * DAY_MS);
  const where = `${K.keySellerSql('k')} AND k.exit_observed_day >= @cutoff AND (k.rdap_at IS NULL OR COALESCE(k.probe_count, 0) = 0)`;
  const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${T} k INDEXED BY idx_${T}_seller WHERE ${where}`).get({ cutoff }).n) || 0;
  if (!count) return { ready: true, unchecked: 0, oldestDay: null, oldestArrivedAt: null };
  // Arrival of a row: the later of its departure day, the import of that
  // movement day and, for a row a rescoring pass brought back as an unchecked
  // seller departure (sale_watch_seller_admissions), the moment it did. The
  // backlog's age is that of its earliest arrival. Past the cap the admissions
  // are not consulted: the oldest departure day decides, as before.
  const importMs = new Map();
  const importMsOf = day => {
    if (!importMs.has(day)) {
      const imported = day ? safe(() => db.prepare('SELECT imported_at FROM sale_watch_movement_imports WHERE day = ?').get(day), null) : null;
      importMs.set(day, imported && imported.imported_at ? Date.parse(imported.imported_at) : NaN);
    }
    return importMs.get(day);
  };
  const arrivalOf = (day, admittedAt) => {
    const at = [day ? Date.parse(`${day}T00:00:00Z`) : NaN, importMsOf(day), admittedAt ? Date.parse(admittedAt) : NaN].filter(Number.isFinite);
    return at.length ? Math.max(...at) : NaN;
  };
  const admissions = count <= SELLER_BACKLOG_ADMISSION_ROWS
    && safe(() => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(SELLER_ADMISSIONS_TABLE)), false);
  let day = null;
  let arrivedMs = NaN;
  if (admissions) {
    const rows = db.prepare(`SELECT k.exit_observed_day AS day, a.admitted_at AS admittedAt FROM ${T} k INDEXED BY idx_${T}_seller
      LEFT JOIN ${SELLER_ADMISSIONS_TABLE} a ON a.domain = k.domain WHERE ${where} ORDER BY k.exit_observed_day, k.domain LIMIT ${SELLER_BACKLOG_ADMISSION_ROWS}`).all({ cutoff });
    for (const row of rows) {
      const ms = arrivalOf(row.day, row.admittedAt);
      if (!Number.isFinite(ms)) { day = row.day; arrivedMs = NaN; break; }
      if (!Number.isFinite(arrivedMs) || ms < arrivedMs) { arrivedMs = ms; day = row.day; }
    }
  } else {
    const oldest = db.prepare(`SELECT k.exit_observed_day AS day FROM ${T} k INDEXED BY idx_${T}_seller WHERE ${where} ORDER BY k.exit_observed_day, k.domain LIMIT 1`).get({ cutoff });
    day = oldest && oldest.day;
    arrivedMs = arrivalOf(day, null);
  }
  return { ready: true, unchecked: count, oldestDay: day || null, oldestArrivedAt: Number.isFinite(arrivedMs) ? new Date(arrivedMs).toISOString() : null };
}

/**
 * Start of the latest clean wave that recorded its seller-departure backlog
 * (summary.sellerBacklog, written at the wave's health stage after the sweep
 * and probes) when that wave left none unchecked; null when it left some, or
 * no recent wave recorded one.
 */
function sellerBacklogClearedSince(db) {
  const row = safe(() => db.prepare(`SELECT started_at AS startedAt, json_extract(summary_json, '$.sellerBacklog.unchecked') AS unchecked
    FROM sale_watch_wave_runs
    WHERE id > (SELECT MAX(id) FROM sale_watch_wave_runs) - 12 AND finished_at IS NOT NULL
      AND json_valid(summary_json) AND json_type(summary_json, '$.sellerBacklog.unchecked') = 'integer'
    ORDER BY id DESC LIMIT 1`).get(), null);
  return row && Number(row.unchecked) === 0 && row.startedAt ? row.startedAt : null;
}

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
  // Cheap version probe. A complete marker on the current VERSION is written
  // only when no dirty or older-VERSION row remains, and every later write
  // marks its row dirty, so an off-version row can only be a dirty one: read
  // it through the partial dirty index, never a full-table scan.
  const staleVersion = store && store.complete
    ? safe(() => db.prepare(`SELECT 1 AS x FROM ${assessments.TABLE} INDEXED BY idx_${assessments.TABLE}_dirty WHERE dirty = 1 AND (version IS NULL OR version <> ?) LIMIT 1`).get(store.currentVersion), undefined)
    : 1;
  const progress = safe(() => assessments.rebuildProgress(db), null);
  const newestProbable = safe(() => db.prepare(`SELECT report_date FROM ${assessments.VIEWS_TABLE} WHERE view = 'probable' ORDER BY report_date DESC LIMIT 1`).get(), undefined);
  const discoveryLimit = Number(params.discoveryLimitBytes) || require('./sale-watch-discovery-io').DISCOVERY_FILE_LIMIT_BYTES;
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
      rebuildProgressAt: progress && store && progress.version === store.currentVersion ? progress.at : null,
    },
    probableList: { newestReportDate: newestProbable && newestProbable.report_date ? newestProbable.report_date : null },
    sellerBacklog: safe(() => {
      const backlog = readSellerBacklog(db, nowMs);
      if (backlog && backlog.ready && backlog.unchecked) backlog.clearedSince = sellerBacklogClearedSince(db);
      return backlog;
    }, null),
    disk: diskFree(params.dataDir, deps.statfs),
  };
}

function add(checks, name, status, detail) { checks.push({ name, status, detail }); }

/**
 * What the Probably sold reader needs, with no internal vocabulary:
 * { lastUpdateAt, behind }. lastUpdateAt is when evidence last landed (the
 * newer of the last clean wave finish and the last movement import), or null
 * when unknown, in which case the page omits the time. behind is true only
 * when the verdict is stale: a degraded part (one failed wave, a stalled
 * rebuild, disk headroom) does not mean the list is behind. A rebuild in
 * progress keeps serving valid verdicts and is never behind.
 */
function readerStatus(parts, verdict) {
  const p = parts || {};
  const times = [p.wave && p.wave.lastCleanFinishedAt, p.movement && p.movement.latestImportedAt]
    .map(v => (v ? Date.parse(v) : NaN)).filter(Number.isFinite);
  return {
    lastUpdateAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    behind: verdict === 'stale',
  };
}

/**
 * Pure verdict. `supervisor` is waveSupervisorState() from the main thread
 * (optional). Each check is ok | degraded | stale; the verdict is the worst.
 */
function evaluateFreshness(parts, { now, supervisor = null, extraChecks = [] } = {}) {
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
  else if (wal.bytes > wal.limitBytes * WAL_DEGRADED_LIMIT_MULTIPLE) add(checks, 'wal', 'degraded', `wal ${wal.bytes} B over ${wal.limitBytes * WAL_DEGRADED_LIMIT_MULTIPLE} B`);
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
  // Rebuild to a new classifier version: not staleness (the previous verdicts
  // keep serving). Informational while progressing, degraded once stalled.
  let rebuild = null;
  if (!a.versionComplete) {
    const progAge = a.rebuildProgressAt ? nowMs - Date.parse(a.rebuildProgressAt) : Infinity;
    const progressing = Number.isFinite(progAge) && progAge <= REBUILD_STALL_MS;
    rebuild = { inProgress: true, progressing, lastProgressAt: a.rebuildProgressAt || null, fromVersion: a.version || null, toVersion: a.currentVersion || null };
    if (progressing) add(checks, 'rebuild', 'ok', `rebuilding to ${a.currentVersion || 'unknown'}, last progress ${Math.round(progAge / 60000)} min ago`);
    else add(checks, 'rebuild', 'degraded', a.rebuildProgressAt ? `rebuild to ${a.currentVersion || 'unknown'} stalled ${Math.round(progAge / 60000)} min` : `rebuild to ${a.currentVersion || 'unknown'} has not recorded progress`);
  }

  // Probably sold list
  const newest = p.probableList && p.probableList.newestReportDate;
  if (!newest) add(checks, 'probable-list', 'degraded', 'Probably sold list is empty');
  else add(checks, 'probable-list', 'ok', `newest report ${newest}`);

  // Seller / marketplace departures awaiting their first RDAP check or probe.
  const sb = p.sellerBacklog;
  if (!sb) add(checks, 'seller-backlog', 'stale', 'seller-departure backlog unreadable');
  // Not cheaply readable until the candidate-keys backfill completes: the part
  // is pending (never a timeout, never a stale verdict from a slow scan).
  else if (sb.ready === false) add(checks, 'seller-backlog', 'pending', `candidate keys still backfilling${sb.progress ? ` (rid ${sb.progress.rid}${sb.progress.maxRid ? ` of ${sb.progress.maxRid}` : ''})` : ''}; seller-departure backlog pending`);
  else if (!sb.unchecked) add(checks, 'seller-backlog', 'ok', 'no unchecked seller departures');
  else {
    // Every wave's RDAP sweep takes every live seller departure. When the
    // latest clean wave left none unchecked (clearedSince), whatever is
    // unchecked now was admitted after that wave began, so it cannot be older
    // than that, whatever its departure day says. Rows that survive a clean
    // wave keep their full age.
    const since = [sb.oldestArrivedAt, sb.clearedSince].map(v => (v ? Date.parse(v) : NaN)).filter(Number.isFinite);
    const age = since.length ? nowMs - Math.max(...since) : NaN;
    const detail = `${sb.unchecked} unchecked seller departure${sb.unchecked === 1 ? '' : 's'}, oldest ${Number.isFinite(age) ? `${Math.round(age / 60000)} min` : 'age unknown'} (${sb.oldestDay || 'unknown day'})`;
    if (!Number.isFinite(age)) add(checks, 'seller-backlog', 'degraded', detail);
    else if (age > SELLER_BACKLOG_STALE_MS) add(checks, 'seller-backlog', 'stale', detail);
    else if (age > SELLER_BACKLOG_DEGRADED_MS) add(checks, 'seller-backlog', 'degraded', detail);
    else add(checks, 'seller-backlog', 'ok', detail);
  }

  // Disk
  const disk = p.disk;
  if (!disk) add(checks, 'disk', 'degraded', 'disk headroom unknown');
  else if (disk.freeBytes < DISK_STALE_FREE_BYTES) add(checks, 'disk', 'stale', `${disk.freeBytes} B free`);
  else if (disk.freeBytes < DISK_DEGRADED_FREE_BYTES) add(checks, 'disk', 'degraded', `${disk.freeBytes} B free`);
  else add(checks, 'disk', 'ok', `${disk.freeBytes} B free`);

  // Main-process checks (e.g. daily-snapshot age from the snapshot producer).
  for (const c of Array.isArray(extraChecks) ? extraChecks : []) if (c && c.name && ['ok', 'pending', 'degraded', 'stale'].includes(c.status)) add(checks, c.name, c.status, c.detail);

  // 'pending' marks a part that cannot be read cheaply yet; it is reported
  // but never raises the verdict.
  const rank = { ok: 0, pending: 0, degraded: 1, stale: 2 };
  const worst = checks.reduce((n, c) => Math.max(n, rank[c.status]), 0);
  const verdict = VERDICTS[worst];
  const failing = checks.filter(c => c.status === 'degraded' || c.status === 'stale');
  return {
    schema: SCHEMA,
    verdict,
    checkedAt: new Date(nowMs).toISOString(),
    reasons: failing.map(c => `${c.name}: ${c.detail}`),
    pending: checks.filter(c => c.status === 'pending').map(c => c.name),
    checks,
    waveRunning,
    rebuild,
    reader: readerStatus(p, verdict),
    parts: p,
    thresholds: {
      cleanWaveMaxAgeMs: CLEAN_WAVE_MAX_AGE_MS, waveFailuresStale: WAVE_FAILURES_STALE,
      movementTapeReadyUtcHour: MOVEMENT_TAPE_READY_UTC_HOUR, movementGapWindowDays: MOVEMENT_GAP_WINDOW_DAYS,
      dirtyBacklogMaxAgeMs: DIRTY_BACKLOG_MAX_AGE_MS, discoveryWarnRatio: DISCOVERY_WARN_RATIO,
      walDegradedLimitMultiple: WAL_DEGRADED_LIMIT_MULTIPLE, walStaleBytes: WAL_STALE_BYTES, diskDegradedFreeBytes: DISK_DEGRADED_FREE_BYTES, diskStaleFreeBytes: DISK_STALE_FREE_BYTES,
      waveHeartbeatStaleMs: WAVE_HEARTBEAT_STALE_MS,
      rebuildStallMs: REBUILD_STALL_MS,
      sellerBacklogDegradedMs: SELLER_BACKLOG_DEGRADED_MS, sellerBacklogStaleMs: SELLER_BACKLOG_STALE_MS,
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
  DIRTY_BACKLOG_MAX_AGE_MS, DISCOVERY_WARN_RATIO, WAL_DEGRADED_LIMIT_MULTIPLE, WAL_STALE_BYTES, DISK_DEGRADED_FREE_BYTES, DISK_STALE_FREE_BYTES,
  WAVE_HEARTBEAT_STALE_MS,
  REBUILD_STALL_MS,
  SELLER_BACKLOG_DEGRADED_MS, SELLER_BACKLOG_STALE_MS, SELLER_BACKLOG_WINDOW_DAYS, SELLER_ADMISSIONS_TABLE, SELLER_BACKLOG_ADMISSION_ROWS,
  expectedMovementDay, availableMovementDays, readSellerBacklog, sellerBacklogClearedSince, readFreshnessParts, evaluateFreshness, freshnessStatusLine, readerStatus,
};
