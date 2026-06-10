// ── EMERGENCY DISK CLEANUP ─────────────────────────────────────────────────
// Must run BEFORE require('./db') — if the Railway volume is full, SQLite's
// WAL mode cannot write and the process crashes before the server starts.
// Zone data is preserved in zone_index.db; raw zone files are safe to delete.
(function purgeZoneFilesSync() {
  const _fs = require('fs');
  const _path = require('path');
  const _cp = require('child_process');
  const zonesDir = _path.join(
    process.env.RAILWAY_VOLUME_MOUNT_PATH || _path.join(__dirname, '../data'),
    'zones'
  );
  if (!_fs.existsSync(zonesDir)) return;
  try {
    _cp.execFileSync('pgrep', ['-f', 'server/czds-sync.js'], { stdio: 'ignore' });
    console.log('[Startup] Active CZDS worker detected; zone file cleanup skipped');
    return;
  } catch (_) {}
  let deleted = 0;
  const preservePriorityZones = process.env.DOMAINSCOUT_PURGE_PRIORITY_ZONE_FILES !== '1';
  const priorityZoneTlds = new Set(
    String(process.env.DOMAINSCOUT_PRIORITY_ZONE_TLDS || 'com,net,org,info,biz')
      .split(',')
      .map(tld => tld.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean)
  );
  for (const f of _fs.readdirSync(zonesDir)) {
    if (f.endsWith('.part')) continue;
    if (/\.(zone|zone\.gz)$/.test(f)) {
      const tld = (f.match(/^([a-z0-9-]+)-\d{4}-\d{2}-\d{2}\.zone(?:\.gz)?$/) || [])[1];
      if (preservePriorityZones && tld && priorityZoneTlds.has(tld)) continue;
      try { _fs.unlinkSync(_path.join(zonesDir, f)); deleted++; }
      catch (_) {}
    }
  }
  if (deleted > 0) console.log(`[Startup] Purged ${deleted} zone files from disk (freeing volume space)`);
})();
// ───────────────────────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const session = require('express-session');
const { spawn } = require('child_process');
const DATA_BASE_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const SERVER_LOCK_PATH = path.join(DATA_BASE_PATH, 'server.lock.json');

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function acquireServerLock() {
  fs.mkdirSync(DATA_BASE_PATH, { recursive: true });
  if (fs.existsSync(SERVER_LOCK_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(SERVER_LOCK_PATH, 'utf8'));
      if (existing.pid !== process.pid && isPidAlive(existing.pid)) {
        console.error(`[Startup] DomainScout already running as pid ${existing.pid}; exiting duplicate process before DB init.`);
        process.exit(0);
      }
      fs.unlinkSync(SERVER_LOCK_PATH);
    } catch (_) {
      try { fs.unlinkSync(SERVER_LOCK_PATH); } catch (_) {}
    }
  }

  fs.writeFileSync(SERVER_LOCK_PATH, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2));

  process.on('exit', () => {
    try {
      const lock = JSON.parse(fs.readFileSync(SERVER_LOCK_PATH, 'utf8'));
      if (Number(lock.pid) === process.pid) fs.unlinkSync(SERVER_LOCK_PATH);
    } catch (_) {}
  });
}

if (process.env.DOMAINSCOUT_SKIP_SERVER_LOCK !== '1') acquireServerLock();

const db = require('./db');
const { startWorker } = require('./tlds-worker');
const { checkTldsTakenFull, getRegistrarAvailabilityConfig, getRegistrarRequiredAvailableTlds } = require('../enrichment');
const { getCheckTlds, getTldSource, refreshLogicalTlds } = require('./tlds-list');
const { getSupportedTldUniverse } = require('./tld-universe');
const { indexAllPendingZoneFiles, queryZoneIndex, getZoneIndexStats,
        getTldTrends, getKeywordTrends, getKeywordTrendHistory,
        hasTrendData, getNameTlds, getIndexedTldSet } = require('./zone-indexer');
const { normalizePrefix } = require('./research-prefix-index');
const { ACTIVE_AUCTION_STREAMS, activeAuctionWhere, endedAuctionWhere, purgeEndedAuctions } = require('./auction-cleanup');
const { getGoDaddyInventoryCacheMeta, isGoDaddyInventoryStream,
        readGoDaddyInventoryCache, readGoDaddyInventoryDomainMap } = require('./godaddy-cache');
const { backfillAvailableQualityScores } = require('./quality-backfill');
const { importCzdsDropCandidates } = require('./czds-drop-importer');
const {
  estimateAvailabilityBacklog,
  getAvailabilityCooldowns,
  getAvailabilityBacklogSignature,
  selectAvailabilityCandidates,
} = require('./expired-availability');

// ATTACH zone_index.db for cross-DB "also taken in" filtering.
// Called after zone-indexer has had a chance to create the file.
const SCRAPE_LOCK_PATH = path.join(DATA_BASE_PATH, 'scrape.lock.json');
const GODADDY_REFRESH_LOCK_PATH = path.join(DATA_BASE_PATH, 'godaddy-refresh.lock.json');
const TLD_ACCURACY_LOCK_PATH = path.join(DATA_BASE_PATH, 'tld-accuracy.lock.json');
const EXPIRED_AVAILABILITY_LOCK_PATH = path.join(DATA_BASE_PATH, 'expired-availability.lock.json');
const EXPIRED_DOGFOOD_ENABLED = process.env.DOMAINSCOUT_EXPIRED_DOGFOOD_ENABLED !== '0';
const DEFAULT_EXPIRED_AVAILABILITY_CRON = '15,35,55 * * * *';
const DEFAULT_EXPIRED_DOGFOOD_CRON = '10 * * * *';
const EXPIRED_COOLDOWN_RETRY_BUFFER_MS = Math.max(
  1000,
  Math.min(
    10 * 60_000,
    parseInt(process.env.DOMAINSCOUT_EXPIRED_COOLDOWN_RETRY_BUFFER_MS || '5000', 10) || 5000
  )
);
let _zoneIndexAttached = false;

function validatedCron(value, fallback, label) {
  const candidate = String(value || fallback || '').trim();
  if (candidate && cron.validate(candidate)) return candidate;
  console.warn(`[Cron] Invalid ${label} schedule "${candidate}", using "${fallback}"`);
  return fallback;
}

const EXPIRED_AVAILABILITY_CRON = validatedCron(
  process.env.DOMAINSCOUT_EXPIRED_AVAILABILITY_CRON,
  DEFAULT_EXPIRED_AVAILABILITY_CRON,
  'expired availability'
);
const EXPIRED_DOGFOOD_CRON = validatedCron(
  process.env.DOMAINSCOUT_EXPIRED_DOGFOOD_CRON,
  DEFAULT_EXPIRED_DOGFOOD_CRON,
  'expired dogfood'
);

function getExpiredDogfoodMaxAgeMs() {
  const hours = Math.max(
    1,
    Math.min(24 * 30, parseInt(process.env.DOMAINSCOUT_EXPIRED_DOGFOOD_MAX_AGE_HOURS || '3', 10) || 3)
  );
  return hours * 3_600_000;
}

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function readActiveScrapeLock() {
  if (!fs.existsSync(SCRAPE_LOCK_PATH)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(SCRAPE_LOCK_PATH, 'utf8'));
    if (isProcessAlive(lock.pid)) return lock;
    fs.unlinkSync(SCRAPE_LOCK_PATH);
    console.warn(`[Scrape] Removed stale scrape lock for pid ${lock.pid || 'unknown'}`);
  } catch (err) {
    try { fs.unlinkSync(SCRAPE_LOCK_PATH); } catch (_) {}
    console.warn('[Scrape] Removed unreadable scrape lock:', err.message);
  }
  return null;
}

function writeScrapeLock(lock, flags = 'w') {
  fs.mkdirSync(DATA_BASE_PATH, { recursive: true });
  fs.writeFileSync(SCRAPE_LOCK_PATH, JSON.stringify(lock, null, 2), { flag: flags });
}

function releaseScrapeLock(pid) {
  try {
    const lock = JSON.parse(fs.readFileSync(SCRAPE_LOCK_PATH, 'utf8'));
    if (Number(lock.pid) === Number(pid)) fs.unlinkSync(SCRAPE_LOCK_PATH);
  } catch (_) {}
}

function readActiveTldAccuracyLock() {
  if (!fs.existsSync(TLD_ACCURACY_LOCK_PATH)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(TLD_ACCURACY_LOCK_PATH, 'utf8'));
    if (isProcessAlive(lock.pid)) return lock;
    fs.unlinkSync(TLD_ACCURACY_LOCK_PATH);
    console.warn(`[TLDs Worker] Removed stale accuracy lock for pid ${lock.pid || 'unknown'}`);
  } catch (err) {
    try { fs.unlinkSync(TLD_ACCURACY_LOCK_PATH); } catch (_) {}
    console.warn('[TLDs Worker] Removed unreadable accuracy lock:', err.message);
  }
  return null;
}

function releaseTldAccuracyLock(pid) {
  try {
    const lock = JSON.parse(fs.readFileSync(TLD_ACCURACY_LOCK_PATH, 'utf8'));
    if (Number(lock.pid) === Number(pid)) fs.unlinkSync(TLD_ACCURACY_LOCK_PATH);
  } catch (_) {}
}

function startTldAccuracyWorkerProcess(reason = 'startup') {
  const active = readActiveTldAccuracyLock();
  if (active) return { ok: false, running: true, pid: active.pid, startedAt: active.startedAt, reason: active.reason };

  let command = process.execPath;
  let args = [path.join(__dirname, 'tlds-worker.js')];
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/nice')) {
    command = '/usr/bin/nice';
    args = ['-n', '10', process.execPath, ...args];
  }

  const child = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DOMAINSCOUT_SKIP_DB_MAINTENANCE: '1',
      TLDS_WORKER_SCOPE: process.env.TLDS_WORKER_SCOPE || 'auction',
    },
    stdio: 'inherit',
  });

  const lock = {
    pid: child.pid,
    parentPid: process.pid,
    reason,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(TLD_ACCURACY_LOCK_PATH, JSON.stringify(lock, null, 2));
  console.log(`[TLDs Worker] Started accurate backfill pid ${child.pid} (${reason})`);

  child.on('exit', (code, signal) => {
    console.log(`[TLDs Worker] Accurate backfill pid ${child.pid} finished (${signal || code})`);
    releaseTldAccuracyLock(child.pid);
  });
  child.on('error', (err) => {
    console.error('[TLDs Worker] Accurate backfill failed to start:', err.message);
    releaseTldAccuracyLock(child.pid);
  });

  return { ok: true, started: true, pid: child.pid, startedAt: lock.startedAt };
}

function startScrapeWorker(reason, options = {}) {
  const active = readActiveScrapeLock();
  if (active) {
    return {
      ok: false,
      message: 'Scrape already running',
      pid: active.pid,
      reason: active.reason,
      startedAt: active.startedAt,
    };
  }

  const reservation = {
    pid: process.pid,
    parentPid: process.pid,
    reason,
    startedAt: new Date().toISOString(),
    reserving: true,
  };

  try {
    writeScrapeLock(reservation, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const lock = readActiveScrapeLock();
    return {
      ok: false,
      message: 'Scrape already running',
      pid: lock?.pid,
      reason: lock?.reason,
      startedAt: lock?.startedAt,
    };
  }

  const childArgs = [path.join(__dirname, 'scrape-all.js')];
  if (options.includeCZDS) childArgs.push('--czds');

  let command = process.execPath;
  let args = childArgs;
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/nice')) {
    command = '/usr/bin/nice';
    args = ['-n', '10', process.execPath, ...childArgs];
  }

  const child = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DOMAINSCOUT_SCRAPE_REASON: reason,
      DOMAINSCOUT_SKIP_DB_MAINTENANCE: '1',
    },
    stdio: 'inherit',
  });

  const lock = {
    pid: child.pid,
    parentPid: process.pid,
    reason,
    includeCZDS: options.includeCZDS === true,
    startedAt: new Date().toISOString(),
  };
  writeScrapeLock(lock);
  console.log(`[Scrape] Started ${reason} scrape worker pid ${child.pid}`);

  child.on('exit', (code, signal) => {
    console.log(`[Scrape] Worker pid ${child.pid} finished (${signal || code})`);
    releaseScrapeLock(child.pid);
    bustCache();
    invalidateStatsCache();
  });

  child.on('error', (err) => {
    console.error('[Scrape] Worker failed to start:', err.message);
    releaseScrapeLock(child.pid);
  });

  return { ok: true, pid: child.pid, reason, startedAt: lock.startedAt };
}

function readActiveExpiredAvailabilityLock() {
  if (!fs.existsSync(EXPIRED_AVAILABILITY_LOCK_PATH)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(EXPIRED_AVAILABILITY_LOCK_PATH, 'utf8'));
    if (isProcessAlive(lock.pid)) return lock;
    fs.unlinkSync(EXPIRED_AVAILABILITY_LOCK_PATH);
  } catch (_) {
    try { fs.unlinkSync(EXPIRED_AVAILABILITY_LOCK_PATH); } catch (_) {}
  }
  return null;
}

function releaseExpiredAvailabilityLock(pid) {
  try {
    const lock = JSON.parse(fs.readFileSync(EXPIRED_AVAILABILITY_LOCK_PATH, 'utf8'));
    if (Number(lock.pid) === Number(pid)) fs.unlinkSync(EXPIRED_AVAILABILITY_LOCK_PATH);
  } catch (_) {}
}

let expiredAvailabilityStatusCache = null;
let expiredAvailabilityCooldownRetryTimer = null;
let expiredAvailabilityCooldownRetryState = null;

function invalidateExpiredBacklogEstimate() {
  expiredAvailabilityStatusCache = null;
  try { deletePersistentCache('expired-availability-backlog'); } catch (_) {}
}

function summarizeCandidateRows(rows) {
  const byTld = {};
  const byBucket = {};
  for (const row of rows) {
    const tld = row.tld || '';
    byTld[tld] = (byTld[tld] || 0) + 1;
    const bucket = String(row.due_bucket ?? 'unknown');
    byBucket[bucket] = (byBucket[bucket] || 0) + 1;
  }
  return { byTld, byBucket };
}

function cooldownRetrySnapshot() {
  if (!expiredAvailabilityCooldownRetryState) return null;
  return {
    ...expiredAvailabilityCooldownRetryState,
    remainingMs: Math.max(0, expiredAvailabilityCooldownRetryState.runAtMs - Date.now()),
  };
}

function cooldownStatusSignature(cooldowns) {
  return JSON.stringify(
    Object.entries(cooldowns || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tld, item]) => [tld, item?.until || null])
  );
}

function withFreshAvailabilityCooldowns(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    cooldowns: getAvailabilityCooldowns({ readOnly: true }),
  };
}

function withFreshDogfoodCooldowns(value) {
  if (!value || typeof value !== 'object') return value;
  const cooldowns = getAvailabilityCooldowns({ readOnly: true });
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.map(warning => warning?.cooldowns ? { ...warning, cooldowns } : warning)
    : value.warnings;
  const registrarHealth = value.registrarHealth?.availabilityCooldowns
    ? { ...value.registrarHealth, availabilityCooldowns: cooldowns }
    : value.registrarHealth;

  return {
    ...value,
    warnings,
    registrarHealth,
  };
}

function getExpiredBacklogCacheMaxAgeMs(value) {
  return Math.max(
    60_000,
    Math.min(
      24 * 3_600_000,
      parseInt(value || process.env.DOMAINSCOUT_EXPIRED_BACKLOG_CACHE_MS || '600000', 10) || 600_000
    )
  );
}

function isExpiredBacklogCacheShapeCurrent(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'blockedTotal') &&
    Object.prototype.hasOwnProperty.call(value, 'blockedByTld') &&
    Object.prototype.hasOwnProperty.call(value, 'blockedByBucket')
  );
}

function clearExpiredAvailabilityCooldownRetry() {
  if (expiredAvailabilityCooldownRetryTimer) clearTimeout(expiredAvailabilityCooldownRetryTimer);
  expiredAvailabilityCooldownRetryTimer = null;
  expiredAvailabilityCooldownRetryState = null;
}

function scheduleExpiredAvailabilityCooldownRetry(reason = 'cooldown') {
  const cooldowns = getAvailabilityCooldowns();
  const entries = Object.values(cooldowns)
    .map(item => ({
      tld: String(item.tld || '').toLowerCase(),
      untilMs: Date.parse(item.until || ''),
    }))
    .filter(item => item.tld && Number.isFinite(item.untilMs));

  if (entries.length === 0) {
    const pendingRetry = cooldownRetrySnapshot();
    if (pendingRetry && pendingRetry.runAtMs > Date.now()) return pendingRetry;
    clearExpiredAvailabilityCooldownRetry();
    return null;
  }

  const soonestMs = Math.min(...entries.map(item => item.untilMs));
  const tlds = entries
    .filter(item => item.untilMs === soonestMs)
    .map(item => item.tld)
    .sort();
  const runAtMs = soonestMs + EXPIRED_COOLDOWN_RETRY_BUFFER_MS;
  const signature = JSON.stringify({ runAtMs, tlds });
  if (
    expiredAvailabilityCooldownRetryTimer &&
    expiredAvailabilityCooldownRetryState?.signature === signature
  ) {
    return cooldownRetrySnapshot();
  }

  clearExpiredAvailabilityCooldownRetry();
  const delayMs = Math.max(1000, Math.min(2_147_483_647, runAtMs - Date.now()));
  expiredAvailabilityCooldownRetryState = {
    reason,
    tlds,
    runAt: new Date(runAtMs).toISOString(),
    runAtMs,
    scheduledAt: new Date().toISOString(),
    signature,
  };
  expiredAvailabilityCooldownRetryTimer = setTimeout(() => {
    const targetTlds = expiredAvailabilityCooldownRetryState?.tlds || [];
    expiredAvailabilityCooldownRetryTimer = null;
    expiredAvailabilityCooldownRetryState = null;

    const activeCooldowns = getAvailabilityCooldowns();
    const readyTlds = targetTlds.filter(tld => !activeCooldowns[tld]);
    if (readyTlds.length === 0) {
      scheduleExpiredAvailabilityCooldownRetry('cooldown-still-active');
      return;
    }

    const result = startExpiredAvailabilityWorkerIfDue(`cooldown-expired-${readyTlds.join(',')}`, {
      tlds: readyTlds,
      limit: process.env.DOMAINSCOUT_COOLDOWN_EXPIRED_AVAILABILITY_LIMIT ||
        process.env.DOMAINSCOUT_SCHEDULED_EXPIRED_AVAILABILITY_LIMIT ||
        1000,
    });
    if (!result.ok) {
      console.log(`[ExpiredAvailability] Cooldown retry skipped: ${result.message}${result.pid ? ` (pid ${result.pid})` : ''}`);
      setTimeout(() => scheduleExpiredAvailabilityCooldownRetry('cooldown-retry-skipped'), 60_000);
    }
  }, delayMs);
  console.log(`[ExpiredAvailability] Scheduled cooldown retry for ${tlds.join(', ')} at ${expiredAvailabilityCooldownRetryState.runAt}`);
  return cooldownRetrySnapshot();
}

function getExpiredAvailabilityStatus({ force = false } = {}) {
  const ttlMs = Math.max(30_000, parseInt(process.env.DOMAINSCOUT_EXPIRED_STATUS_TTL_MS || '120000', 10) || 120_000);
  if (!force && expiredAvailabilityStatusCache && Date.now() - expiredAvailabilityStatusCache.ts < ttlMs) {
    const cachedValue = expiredAvailabilityStatusCache.value;
    const active = readActiveExpiredAvailabilityLock();
    const cooldowns = getAvailabilityCooldowns();
    const sameCooldownState = cooldownStatusSignature(cooldowns) === cooldownStatusSignature(cachedValue.cooldowns);
    const sameRunningState = Boolean(active) === Boolean(cachedValue.running);
    if (sameCooldownState && sameRunningState) {
      return {
        ...cachedValue,
        running: Boolean(active),
        active,
        cooldowns,
        dueEstimate: withFreshAvailabilityCooldowns(cachedValue.dueEstimate),
        cooldownRetry: scheduleExpiredAvailabilityCooldownRetry('status-cache'),
      };
    }
  }

  const latestAttempt = db.prepare(`
    SELECT ran_at, domains_found, domains_new, error
    FROM scrape_log
    WHERE stream = 'expired-availability'
    ORDER BY ran_at DESC, id DESC
    LIMIT 1
  `).get() || null;
  const latest = db.prepare(`
    SELECT ran_at, domains_found, domains_new, error
    FROM scrape_log
    WHERE stream = 'expired-availability'
      AND (domains_found > 0 OR error IS NOT NULL)
    ORDER BY ran_at DESC, id DESC
    LIMIT 1
  `).get() || latestAttempt;

  const active = readActiveExpiredAvailabilityLock();
  const cooldowns = getAvailabilityCooldowns();
  const cooldownRetry = scheduleExpiredAvailabilityCooldownRetry('status');
  const scheduledLimit = parseInt(process.env.DOMAINSCOUT_SCHEDULED_EXPIRED_AVAILABILITY_LIMIT || '1000', 10) || 1000;
  const sampleLimit = Math.max(1, Math.min(5000, parseInt(process.env.DOMAINSCOUT_EXPIRED_STATUS_SAMPLE_LIMIT || String(scheduledLimit), 10) || scheduledLimit));
  const started = Date.now();
  let dueSample = null;
  let dueEstimate = null;
  let error = null;
  try {
    const rows = selectAvailabilityCandidates({ limit: sampleLimit });
    dueSample = {
      limit: sampleLimit,
      count: rows.length,
      saturated: rows.length >= sampleLimit,
      selectorElapsedMs: Date.now() - started,
      ...summarizeCandidateRows(rows),
    };
  } catch (err) {
    error = err.message || String(err);
  }
  try {
    const cachedEstimate = getPersistentCache('expired-availability-backlog');
    const cachedAgeMs = cachedEstimate ? persistentCacheAgeMs(cachedEstimate.updatedAt) : Infinity;
    if (
      cachedEstimate &&
      isExpiredBacklogCacheShapeCurrent(cachedEstimate.value) &&
      cachedEstimate.value?.signature === getAvailabilityBacklogSignature() &&
      cachedAgeMs <= getExpiredBacklogCacheMaxAgeMs()
    ) {
      dueEstimate = {
        ...withFreshAvailabilityCooldowns(cachedEstimate.value),
        cached: true,
        cachedAt: cachedEstimate.updatedAt,
        ageMs: cachedAgeMs,
      };
    }
  } catch (_) {}
  const dueCount = Number(dueSample?.count || 0);
  if (
    dueEstimate &&
    Number.isFinite(Number(dueEstimate.total)) &&
    dueCount > Number(dueEstimate.total)
  ) {
    dueEstimate = null;
  }
  if (!dueEstimate) {
    try {
      const estimate = {
        ...estimateAvailabilityBacklog(),
        computedAt: new Date().toISOString(),
      };
      setPersistentCache('expired-availability-backlog', estimate);
      dueEstimate = {
        ...withFreshAvailabilityCooldowns(estimate),
        cached: false,
        ageMs: 0,
      };
    } catch (err) {
      error = error || err.message || String(err);
    }
  }

  const value = {
    running: Boolean(active),
    active,
    cooldowns,
    cooldownRetry,
    scheduledLimit,
    scheduledCron: EXPIRED_AVAILABILITY_CRON,
    latest: latest ? {
      ranAt: latest.ran_at,
      checkedRows: latest.domains_found,
      availableRows: latest.domains_new,
      ok: !latest.error,
      error: latest.error,
    } : null,
    latestAttempt: latestAttempt ? {
      ranAt: latestAttempt.ran_at,
      checkedRows: latestAttempt.domains_found,
      availableRows: latestAttempt.domains_new,
      ok: !latestAttempt.error,
      error: latestAttempt.error,
      noop: Number(latestAttempt.domains_found || 0) === 0 && !latestAttempt.error,
    } : null,
    dueSample,
    dueEstimate,
    error,
  };
  expiredAvailabilityStatusCache = { ts: Date.now(), value };
  return value;
}

function startExpiredAvailabilityWorker(reason, options = {}) {
  const active = readActiveExpiredAvailabilityLock();
  if (active) {
    return {
      ok: false,
      running: true,
      message: 'Expired availability refresh already running',
      pid: active.pid,
      reason: active.reason,
      startedAt: active.startedAt,
    };
  }

  const activeScrape = readActiveScrapeLock();
  if (activeScrape) {
    return {
      ok: false,
      running: true,
      message: 'Scrape already running; expired availability refresh runs at the end of the scrape',
      pid: activeScrape.pid,
      reason: activeScrape.reason,
      startedAt: activeScrape.startedAt,
    };
  }

  const childArgs = [path.join(__dirname, 'scrape-all.js'), '--expired-availability'];
  const workerEnv = {
    ...process.env,
    DOMAINSCOUT_SKIP_DB_MAINTENANCE: '1',
  };
  if (options.limit) workerEnv.DOMAINSCOUT_EXPIRED_AVAILABILITY_LIMIT = String(options.limit);
  if (options.tlds) {
    const tlds = Array.isArray(options.tlds) ? options.tlds : String(options.tlds).split(',');
    const normalized = [...new Set(tlds
      .map(tld => String(tld || '').trim().toLowerCase())
      .filter(Boolean)
      .map(tld => tld.startsWith('.') ? tld : `.${tld}`))];
    if (normalized.length) workerEnv.DOMAINSCOUT_EXPIRED_AVAILABILITY_TLDS = normalized.join(',');
  }
  if (options.concurrency) workerEnv.DOMAINSCOUT_EXPIRED_AVAILABILITY_CONCURRENCY = String(options.concurrency);
  if (options.delayMs != null) workerEnv.DOMAINSCOUT_EXPIRED_AVAILABILITY_DELAY_MS = String(options.delayMs);

  let command = process.execPath;
  let args = childArgs;
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/nice')) {
    command = '/usr/bin/nice';
    args = ['-n', '10', process.execPath, ...childArgs];
  }

  fs.mkdirSync(DATA_BASE_PATH, { recursive: true });
  const child = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    env: workerEnv,
    stdio: 'inherit',
  });

  const lock = {
    pid: child.pid,
    parentPid: process.pid,
    reason,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(EXPIRED_AVAILABILITY_LOCK_PATH, JSON.stringify(lock, null, 2));
  invalidateExpiredBacklogEstimate();
  console.log(`[ExpiredAvailability] Started refresh pid ${child.pid} (${reason})`);

  child.on('exit', (code, signal) => {
    console.log(`[ExpiredAvailability] Refresh pid ${child.pid} finished (${signal || code})`);
    releaseExpiredAvailabilityLock(child.pid);
    invalidateExpiredBacklogEstimate();
    scheduleExpiredAvailabilityCooldownRetry('worker-exit');
    bustCache();
    invalidateStatsCache();
    queueExpiredDogfoodAfterAvailability(reason);
  });

  child.on('error', (err) => {
    console.error('[ExpiredAvailability] Refresh failed to start:', err.message);
    releaseExpiredAvailabilityLock(child.pid);
    invalidateExpiredBacklogEstimate();
  });

  return { ok: true, started: true, pid: child.pid, reason, startedAt: lock.startedAt };
}

function startExpiredAvailabilityWorkerIfDue(reason, options = {}) {
  const active = readActiveExpiredAvailabilityLock();
  if (active) return startExpiredAvailabilityWorker(reason, options);
  const activeScrape = readActiveScrapeLock();
  if (activeScrape) return startExpiredAvailabilityWorker(reason, options);

  let duePreview = null;
  try {
    const previewRows = selectAvailabilityCandidates(options);
    const previewLimit = options.limit || null;
    duePreview = {
      limit: previewLimit,
      count: previewRows.length,
      saturated: previewLimit != null ? previewRows.length >= previewLimit : false,
      cooldowns: getAvailabilityCooldowns(),
      ...summarizeCandidateRows(previewRows),
    };
    if (previewRows.length === 0) {
      return {
        ok: true,
        started: false,
        noop: true,
        reason,
        duePreview,
        message: 'No due expired availability candidates',
      };
    }
  } catch (err) {
    duePreview = { error: err.message || String(err) };
  }

  return {
    ...startExpiredAvailabilityWorker(reason, options),
    duePreview,
  };
}

let expiredDogfoodRunning = false;
function logExpiredDogfoodRun({ reason, startedAt, code, signal, stdout, stderr }) {
  let report = null;
  try { report = JSON.parse(stdout); } catch (_) {}

  const checkedRows = Array.isArray(report?.results)
    ? report.results.reduce((sum, row) => sum + Number(row.checkedRows || 0), 0)
    : 0;
  const failures = Array.isArray(report?.failures) ? report.failures : [];
  const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
  const ok = code === 0 && failures.length === 0;
  const elapsedMs = Number.isFinite(Date.parse(startedAt)) ? Date.now() - Date.parse(startedAt) : null;
  const liveHealth = Array.isArray(report?.results)
    ? report.results.find(row => row.label === 'live expired availability samples') || null
    : null;
  const registrarHealth = Array.isArray(report?.results)
    ? report.results.find(row => row.label === 'registrar readiness') || null
    : null;
  const visibilityHealth = Array.isArray(report?.results)
    ? report.results.find(row => row.label === 'expired visibility status') || null
    : null;
  const expiredEndpointHealth = Array.isArray(report?.results)
    ? report.results.find(row => row.label === 'expired all-TLD endpoint') || null
    : null;
  const registrarBlockedRefreshHealth = Array.isArray(report?.results)
    ? report.results.find(row => String(row.label || '').startsWith('blocked registrar refresh ')) || null
    : null;
  const noopRefreshHealth = Array.isArray(report?.results)
    ? report.results.find(row => String(row.label || '').startsWith('noop expired refresh ')) || null
    : null;
  const error = ok ? null : JSON.stringify({
    reason,
    code,
    signal,
    elapsedMs,
    failures: failures.slice(0, 10),
    output: failures.length ? undefined : (stderr || stdout || 'no verifier output').slice(-2000),
  });

  try {
    db.prepare(`
      INSERT INTO scrape_log (stream, domains_found, domains_new, error)
      VALUES (@stream, @domains_found, @domains_new, @error)
    `).run({
      stream: 'expired-dogfood',
      domains_found: checkedRows,
      domains_new: ok ? 0 : Math.max(1, failures.length),
      error,
    });
  } catch (err) {
    console.warn('[Dogfood] Failed to persist verifier run:', err.message);
  }

  try {
    setPersistentCache('expired-dogfood-latest', {
      reason,
      startedAt,
      checkedAt: report?.checkedAt || null,
      elapsedMs,
      ok,
      checkedRows,
      failureCount: failures.length,
      warningCount: warnings.length,
      warnings: warnings.slice(0, 10),
      failures: failures.slice(0, 10),
      liveHealth,
      registrarHealth,
      visibilityHealth,
      expiredEndpointHealth,
      registrarBlockedRefreshHealth,
      noopRefreshHealth,
    });
  } catch (err) {
    console.warn('[Dogfood] Failed to cache verifier report:', err.message);
  }

  return {
    report,
    checkedRows,
    failureCount: failures.length,
    warningCount: warnings.length,
    ok,
  };
}

function startExpiredDogfood(reason = 'scheduled') {
  if (!EXPIRED_DOGFOOD_ENABLED) return { ok: false, disabled: true };
  if (expiredDogfoodRunning) return { ok: false, running: true };

  expiredDogfoodRunning = true;
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [path.join(__dirname, '../scripts/dogfood-expired.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DOMAINSCOUT_BASE_URL: process.env.DOMAINSCOUT_BASE_URL || `http://localhost:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    if (stdout.length > 30000) stdout = stdout.slice(-30000);
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
    if (stderr.length > 10000) stderr = stderr.slice(-10000);
  });
  child.on('exit', (code, signal) => {
    expiredDogfoodRunning = false;
    const elapsed = ((Date.now() - Date.parse(startedAt)) / 1000).toFixed(1);
    const persisted = logExpiredDogfoodRun({ reason, startedAt, code, signal, stdout, stderr });
    if (persisted.ok) {
      console.log(`[Dogfood] Expired verifier passed (${reason}) in ${elapsed}s (${persisted.checkedRows} checked, ${persisted.warningCount} warnings)`);
      return;
    }
    const failureText = persisted.report?.failures?.length
      ? JSON.stringify(persisted.report.failures.slice(0, 5))
      : (stderr || stdout || 'no verifier output').slice(-2000);
    console.warn(`[Dogfood] Expired verifier failed (${reason}, ${signal || code}) in ${elapsed}s: ${failureText}`);
  });
  child.on('error', (err) => {
    expiredDogfoodRunning = false;
    console.warn('[Dogfood] Expired verifier failed to start:', err.message);
  });

  return { ok: true, started: true, pid: child.pid, startedAt };
}

function queueExpiredDogfoodAfterAvailability(reason = 'availability-refresh') {
  if (process.env.DOMAINSCOUT_EXPIRED_DOGFOOD_AFTER_AVAILABILITY === '0') return;
  const delayMs = Math.max(
    0,
    Math.min(60_000, parseInt(process.env.DOMAINSCOUT_EXPIRED_DOGFOOD_AFTER_AVAILABILITY_DELAY_MS || '2000', 10) || 2000)
  );
  setTimeout(() => {
    const result = startExpiredDogfood(`post-${reason}`);
    if (result.ok) return;
    if (result.disabled || result.running) return;
    console.log('[Dogfood] Post-availability expired verifier skipped');
  }, delayMs);
}

function getExpiredDogfoodStatus() {
  const rawCachedExpiredDogfood = getPersistentCache('expired-dogfood-latest')?.value || null;
  const cachedExpiredDogfood = withFreshDogfoodCooldowns(rawCachedExpiredDogfood);
  const latestExpiredDogfood = db.prepare(`
    SELECT ran_at, domains_found, domains_new, error
    FROM scrape_log
    WHERE stream = 'expired-dogfood'
    ORDER BY ran_at DESC, id DESC
    LIMIT 1
  `).get() || null;
  const ageMs = latestExpiredDogfood ? persistentCacheAgeMs(latestExpiredDogfood.ran_at) : null;
  const maxAgeMs = getExpiredDogfoodMaxAgeMs();
  return {
    enabled: EXPIRED_DOGFOOD_ENABLED,
    running: expiredDogfoodRunning,
    scheduledCron: EXPIRED_DOGFOOD_CRON,
    latest: latestExpiredDogfood ? {
      ranAt: latestExpiredDogfood.ran_at,
      checkedRows: latestExpiredDogfood.domains_found,
      failureCount: latestExpiredDogfood.domains_new,
      warningCount: cachedExpiredDogfood?.warningCount ?? null,
      ageMs,
      maxAgeMs,
      stale: ageMs > maxAgeMs,
      ok: !latestExpiredDogfood.error,
      error: latestExpiredDogfood.error,
      warnings: cachedExpiredDogfood?.warnings || [],
      liveHealth: cachedExpiredDogfood?.liveHealth || null,
      registrarHealth: cachedExpiredDogfood?.registrarHealth || null,
      visibilityHealth: cachedExpiredDogfood?.visibilityHealth || null,
      expiredEndpointHealth: cachedExpiredDogfood?.expiredEndpointHealth || null,
      registrarBlockedRefreshHealth: cachedExpiredDogfood?.registrarBlockedRefreshHealth || null,
      noopRefreshHealth: cachedExpiredDogfood?.noopRefreshHealth || null,
    } : null,
  };
}

function readActiveGoDaddyRefreshLock() {
  if (!fs.existsSync(GODADDY_REFRESH_LOCK_PATH)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(GODADDY_REFRESH_LOCK_PATH, 'utf8'));
    if (isProcessAlive(lock.pid)) return lock;
    fs.unlinkSync(GODADDY_REFRESH_LOCK_PATH);
  } catch (_) {
    try { fs.unlinkSync(GODADDY_REFRESH_LOCK_PATH); } catch (_) {}
  }
  return null;
}

function releaseGoDaddyRefreshLock(pid) {
  try {
    const lock = JSON.parse(fs.readFileSync(GODADDY_REFRESH_LOCK_PATH, 'utf8'));
    if (Number(lock.pid) === Number(pid)) fs.unlinkSync(GODADDY_REFRESH_LOCK_PATH);
  } catch (_) {}
}

function goDaddyInventoryMeta() {
  const streams = ['godaddy-auction', 'godaddy-closeout'];
  const byStream = Object.fromEntries(streams.map(stream => [stream, getGoDaddyInventoryCacheMeta(stream)]));
  const ages = Object.values(byStream).map(meta => meta?.ageMs).filter(Number.isFinite);
  return {
    byStream,
    maxAgeMs: ages.length ? Math.max(...ages) : Infinity,
    oldestGeneratedAt: Object.values(byStream)
      .map(meta => meta?.generatedAt)
      .filter(Boolean)
      .sort()[0] || null,
  };
}

const GODADDY_REFRESH_MAX_AGE_MS = Math.max(
  60_000,
  parseInt(process.env.DOMAINSCOUT_GODADDY_REFRESH_MAX_AGE_MS || String(15 * 60_000), 10)
);
let lastGoDaddyRefreshAttempt = 0;

function startGoDaddyRefreshWorker(reason, { force = false } = {}) {
  const active = readActiveGoDaddyRefreshLock();
  const meta = goDaddyInventoryMeta();
  const stale = meta.maxAgeMs > GODADDY_REFRESH_MAX_AGE_MS;

  if (active) {
    return { ok: false, running: true, stale, pid: active.pid, startedAt: active.startedAt, meta };
  }
  if (!force && !stale) return { ok: true, started: false, stale: false, meta };

  const now = Date.now();
  if (!force && now - lastGoDaddyRefreshAttempt < 60_000) {
    return { ok: true, started: false, stale, throttled: true, meta };
  }
  lastGoDaddyRefreshAttempt = now;

  fs.mkdirSync(DATA_BASE_PATH, { recursive: true });
  const child = spawn(process.execPath, [path.join(__dirname, 'scrape-all.js'), '--godaddy-cache-only'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DOMAINSCOUT_SCRAPE_REASON: reason,
      DOMAINSCOUT_SKIP_DB_MAINTENANCE: '1',
    },
    stdio: 'inherit',
  });

  const lock = {
    pid: child.pid,
    parentPid: process.pid,
    reason,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(GODADDY_REFRESH_LOCK_PATH, JSON.stringify(lock, null, 2));
  console.log(`[GoDaddy] Started live inventory refresh pid ${child.pid} (${reason})`);

  child.on('exit', (code, signal) => {
    console.log(`[GoDaddy] Live inventory refresh pid ${child.pid} finished (${signal || code})`);
    releaseGoDaddyRefreshLock(child.pid);
    bustCache();
    invalidateStatsCache();
  });

  child.on('error', (err) => {
    console.error('[GoDaddy] Live inventory refresh failed to start:', err.message);
    releaseGoDaddyRefreshLock(child.pid);
  });

  return { ok: true, started: true, stale, pid: child.pid, startedAt: lock.startedAt, meta };
}

function attachZoneIndex() {
  if (_zoneIndexAttached) return;
  const zoneDbPath = path.join(DATA_BASE_PATH, 'zone_index.db');
  if (!fs.existsSync(zoneDbPath)) return;
  try {
    db.exec(`ATTACH DATABASE '${zoneDbPath}' AS zi`);
    _zoneIndexAttached = true;
    console.log('[ZoneFilter] zone_index.db attached for cross-DB filtering');
  } catch (err) {
    if (!err.message.includes('already')) console.warn('[ZoneFilter] ATTACH failed:', err.message);
  }
}

function domainBaseName(domain) {
  const d = String(domain || '').toLowerCase();
  const dot = d.lastIndexOf('.');
  return dot > 0 ? d.slice(0, dot) : d;
}

function normalizeBaseNameInput(value) {
  let clean = String(value || '').trim().toLowerCase();
  clean = clean.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  clean = clean.replace(/^www\./, '');
  if (clean.includes('.')) clean = clean.slice(0, clean.indexOf('.'));
  return clean.replace(/[^a-z0-9-]/g, '').slice(0, 80);
}

function baseNameSql(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `LOWER(SUBSTR(${p}domain, 1, INSTR(${p}domain, '.') - 1))`;
}

// SQL fragment listing every base_name known to be registered in the @<key> TLD,
// across ALL authoritative sources:
//   1. internal domains rows (this TLD appears as a listing somewhere)
//   2. the gTLD zone index (zi.zone_names) — exhaustive for CZDS gTLDs
//   3. the DNS ccTLD cache (tld_check_cache.taken_json) — the ONLY source that
//      knows .ai/.io/.co and other ccTLDs, plus DNS-confirmed gTLDs.
// Source 3 is what the old takenIn filter ignored, so ".ai"/".io" under-matched.
function takenInSubquery(key) {
  const cache = `SELECT tc.base_name FROM tld_check_cache tc, json_each(tc.taken_json) je WHERE je.value = @${key}`;
  const zone = _zoneIndexAttached ? `UNION SELECT base_name FROM zi.zone_names WHERE tld = @${key}\n      ` : '';
  return `(
      SELECT base_name FROM domains WHERE tld = @${key}
      ${zone}UNION ${cache}
    )`;
}

function bestTldCountSql(alias = '') {
  const baseExpr = baseNameSql(alias);
  const zonePart = _zoneIndexAttached
    ? `COALESCE((SELECT ns.tld_count FROM zi.name_summary ns WHERE ns.base_name = ${baseExpr}), 0)`
    : '0';
  return `MAX(
    COALESCE((SELECT tc.count FROM tld_check_cache tc WHERE tc.base_name = ${baseExpr}), 0),
    ${zonePart},
    COALESCE(${alias ? `${alias}.` : ''}tlds_taken, 0)
  )`;
}

const BASE_TLD_COUNTS_STATE_KEY = 'base_tld_counts_state';

function getBaseTldCountsSnapshot() {
  const domainBases = db.prepare(`
    SELECT COUNT(*) AS n
    FROM (
      SELECT base_name
      FROM domains
      WHERE base_name IS NOT NULL AND base_name != ''
      GROUP BY base_name
    )
  `).get().n;
  const materializedRows = db.prepare('SELECT COUNT(*) AS n FROM base_tld_counts').get().n;
  const zoneStats = getZoneIndexStats();
  return {
    domainBases,
    materializedRows,
    zoneTlds: zoneStats.tlds || 0,
    zoneNames: zoneStats.names || 0,
  };
}

function shouldSkipBaseTldCountSync(snapshot, force) {
  if (force || snapshot.materializedRows === 0) return false;
  if (snapshot.materializedRows < snapshot.domainBases) return false;

  const cached = getPersistentCache(BASE_TLD_COUNTS_STATE_KEY)?.value;
  if (!cached) return false;

  return cached.domainBases === snapshot.domainBases &&
    cached.zoneTlds === snapshot.zoneTlds &&
    cached.zoneNames === snapshot.zoneNames;
}

function syncDomainTldCountsFromVerifiedCache() {
  // Keep domains.tlds_taken (the indexed column the EXTENSION list sorts by) equal to
  // what enrichPageTldCounts DISPLAYS: MAX(zone name_summary.tld_count, latest
  // tld_check_cache.count). Previously this synced ONLY from the cache (and only for
  // the current universe signature), so names whose count comes from the zone index
  // kept a null/stale tlds_taken and sorted wrong while displaying the zone value.
  // base_name is PK/indexed in both name_summary (zi) and tld_check_cache.
  attachZoneIndex();
  const zoneExpr = _zoneIndexAttached
    ? `COALESCE((SELECT tld_count FROM zi.name_summary WHERE base_name = domains.base_name), 0)`
    : `0`;
  const liveExpr = `MAX(${zoneExpr}, COALESCE((SELECT count FROM tld_check_cache WHERE base_name = domains.base_name), 0))`;
  const result = db.prepare(`
    UPDATE domains
    SET tlds_taken = ${liveExpr},
        tlds_checked_at = COALESCE(
          (SELECT checked_at FROM tld_check_cache WHERE base_name = domains.base_name),
          tlds_checked_at
        )
    WHERE base_name IS NOT NULL
      AND base_name != ''
      AND COALESCE(tlds_taken, -1) != ${liveExpr}
  `).run();
  return result.changes;
}

let baseTldCountSyncRunning = false;
function syncBaseTldCounts({ force = false, reason = 'background' } = {}) {
  if (baseTldCountSyncRunning) return { ok: false, running: true };
  baseTldCountSyncRunning = true;
  const t0 = Date.now();
  try {
    attachZoneIndex();
    const before = getBaseTldCountsSnapshot();
    if (shouldSkipBaseTldCountSync(before, force)) {
      console.log(`[TLDCounts] Fresh (${before.materializedRows.toLocaleString()} base counts); skipped ${reason} sync`);
      return { ok: true, skipped: true };
    }

    const zoneJoin = _zoneIndexAttached
      ? 'LEFT JOIN zi.name_summary ns ON ns.base_name = b.base_name'
      : '';
    const zoneCount = _zoneIndexAttached ? 'COALESCE(ns.tld_count, 0)' : '0';
    const result = db.prepare(`
      INSERT INTO base_tld_counts (base_name, tld_count, source, updated_at)
      SELECT
        b.base_name,
        MAX(COALESCE(tc.count, 0), ${zoneCount}, COALESCE(b.domain_count, 0)) AS tld_count,
        CASE
          WHEN COALESCE(tc.count, 0) >= ${zoneCount} AND COALESCE(tc.count, 0) >= COALESCE(b.domain_count, 0) THEN 'hybrid-cache'
          WHEN ${zoneCount} >= COALESCE(b.domain_count, 0) THEN 'zone-summary'
          ELSE 'domains'
        END AS source,
        datetime('now') AS updated_at
      FROM (
        SELECT base_name, MAX(COALESCE(tlds_taken, 0)) AS domain_count
        FROM domains
        WHERE base_name IS NOT NULL AND base_name != ''
        GROUP BY base_name
      ) b
      LEFT JOIN tld_check_cache tc ON tc.base_name = b.base_name
      ${zoneJoin}
      ON CONFLICT(base_name) DO UPDATE SET
        tld_count = excluded.tld_count,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run();
    const domainUpdates = syncDomainTldCountsFromVerifiedCache();
    const after = getBaseTldCountsSnapshot();
    setPersistentCache(BASE_TLD_COUNTS_STATE_KEY, after);
    console.log(`[TLDCounts] Synced ${result.changes.toLocaleString()} base counts, updated ${domainUpdates.toLocaleString()} domains in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { ok: true, changes: result.changes, domainUpdates };
  } catch (err) {
    console.warn('[TLDCounts] sync failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    baseTldCountSyncRunning = false;
  }
}

function enrichPageTldCounts(domains, options = {}) {
  if (!Array.isArray(domains) || domains.length === 0) return domains;
  const skipZoneLookup = options.skipZoneLookup === true;
  const bases = [...new Set(domains.map(d => d.base_name || domainBaseName(d.domain)).filter(Boolean))];
  const universe = getSupportedTldUniverse();
  const verified = new Map();

  // Zone index = the authoritative "registered across N TLDs" count, populated for
  // EVERY base name from the CZDS zone files (181M rows). This is the real signal;
  // the live-check cache only ever covered a tiny fraction (~105 of 413k auction
  // .com), so the column was blank. Look the page's base names up in the zone index
  // (indexed on base_name PK — ~10ms for a page) and prefer it.
  const zoneCount = new Map();
  if (!skipZoneLookup) {
    try {
      attachZoneIndex();
      if (_zoneIndexAttached) {
        for (let i = 0; i < bases.length; i += 900) {
          const batch = bases.slice(i, i + 900);
          const rows = db.prepare(
            `SELECT base_name, tld_count FROM zi.name_summary WHERE base_name IN (${batch.map(() => '?').join(',')})`
          ).all(...batch);
          for (const r of rows) zoneCount.set(r.base_name, Number(r.tld_count) || 0);
        }
      }
    } catch { /* fall back to live-check cache below */ }
  }

  const queryCountChunks = (baseNames) => {
    for (let i = 0; i < baseNames.length; i += 900) {
      const batch = baseNames.slice(i, i + 900);
      const placeholders = batch.map(() => '?').join(',');
      // Pull every cached check for these base names — NOT only the current
      // universe signature. "TLDs taken" is how many extensions are registered
      // for the base; that count stays valid when the supported-TLD universe
      // ticks by a zone or two (e.g. 284 -> 285), which otherwise silently
      // invalidated ~224k checks and blanked the column. Order so an exact
      // current-universe match wins, else fall back to the most recent check.
      const rows = db.prepare(`
        SELECT base_name, count, checked_at, all_count, source
        FROM tld_check_cache
        WHERE base_name IN (${placeholders})
        ORDER BY (all_count = ? AND source = ?) DESC, checked_at DESC
      `).all(...batch, universe.count, universe.source);
      for (const row of rows) {
        if (!verified.has(row.base_name)) verified.set(row.base_name, row);
      }
    }
  };

  queryCountChunks(bases);

  for (const d of domains) {
    const baseName = d.base_name || domainBaseName(d.domain);
    const row = verified.get(baseName);
    const zone = zoneCount.get(baseName);
    // Prefer the larger of the zone count and any live-check count — both measure
    // "registered in N extensions"; the zone index is comprehensive, the cache is
    // occasionally fresher for a specific name.
    const stored = d.tlds_taken != null ? Number(d.tlds_taken) || 0 : null;
    const count = Math.max(zone != null ? zone : 0, row ? Number(row.count) || 0 : 0, skipZoneLookup && stored != null ? stored : 0);
    if (zone != null || row || (skipZoneLookup && stored != null)) {
      d.tlds_taken = count;
      d.tlds_checked_at = row ? row.checked_at : new Date().toISOString();
      d.tlds_verified = !skipZoneLookup || Boolean(row);
      d.tlds_all_count = row ? row.all_count : universe.count;
      d.tlds_source = (zone != null && (!row || zone >= (Number(row.count) || 0))) ? 'zone-index' : (row ? row.source : (skipZoneLookup ? 'stored' : universe.source));
    } else {
      d.tlds_taken = null;
      d.tlds_checked_at = null;
      d.tlds_verified = false;
      d.tlds_all_count = universe.count;
      d.tlds_source = universe.source;
    }
  }
  return domains;
}

function overlayGoDaddyInventoryRows(domains) {
  if (!Array.isArray(domains) || domains.length === 0) return domains;
  const maps = new Map();
  const metas = new Map();

  for (const d of domains) {
    if (!isGoDaddyInventoryStream(d.stream)) continue;
    if (!maps.has(d.stream)) {
      maps.set(d.stream, readGoDaddyInventoryDomainMap(d.stream));
      metas.set(d.stream, getGoDaddyInventoryCacheMeta(d.stream));
    }
    const live = maps.get(d.stream)?.get(d.domain);
    if (!live) continue;
    d.auction_price = live.auction_price;
    d.bid_count = live.bid_count ?? d.bid_count;
    d.auction_end = live.auction_end || d.auction_end;
    d.auction_url = live.auction_url || d.auction_url;
    d.age_years = live.age_years ?? d.age_years;
    d.source = live.source || d.source;
    d.source_feed = live.source_feed || d.source_feed;
    d.metrics = live.metrics || d.metrics;
    d.live_inventory_at = metas.get(d.stream)?.generatedAt || null;
  }
  return domains;
}

function normalizeSaleInfo(row, { live = false } = {}) {
  if (!row || !row.domain) return null;
  const saleStreams = new Set([
    'godaddy-auction',
    'godaddy-closeout',
    'namecheap-auction',
    'marketplace',
    'godaddy-premium',
  ]);
  const price = row.auction_price != null && row.auction_price !== ''
    ? Number(row.auction_price)
    : null;
  return {
    exists: true,
    forSale: saleStreams.has(row.stream) || price != null,
    price: Number.isFinite(price) ? price : null,
    url: row.auction_url || null,
    stream: row.stream || null,
    source: row.source || null,
    auctionEnd: row.auction_end || null,
    bidCount: row.bid_count ?? null,
    live,
  };
}

function isBetterSaleInfo(current, incoming) {
  if (!incoming) return false;
  if (!current) return true;
  if (!!incoming.checked !== !!current.checked && !current.forSale) return !!incoming.checked;
  if (incoming.live !== current.live) return incoming.live;
  if (!!incoming.forSale !== !!current.forSale) return !!incoming.forSale;
  if ((incoming.price != null) !== (current.price != null)) return incoming.price != null;
  if (incoming.price != null && current.price != null && incoming.price !== current.price) {
    return incoming.price < current.price;
  }
  if (incoming.auctionEnd && current.auctionEnd && incoming.auctionEnd !== current.auctionEnd) {
    return new Date(incoming.auctionEnd) < new Date(current.auctionEnd);
  }
  return false;
}

function mergeResearchSaleInfo(nameObj, tld, info) {
  if (!nameObj || !info) return;
  const key = tld === '.ai' ? 'ai' : 'com';
  if (nameObj[key]?.exists && info.checked && !info.forSale) {
    nameObj[key] = { ...nameObj[key], checked: true };
    return;
  }
  if (isBetterSaleInfo(nameObj[key], info)) nameObj[key] = info;
}

function enrichResearchSaleInfo(names, { limit = 100 } = {}) {
  if (!Array.isArray(names) || names.length === 0 || limit <= 0) return names;
  const subset = names.slice(0, Math.min(limit, names.length));
  const wantedDomains = [];
  const byDomain = new Map();
  for (const n of subset) {
    for (const tld of ['.com', '.ai']) {
      const domain = `${n.base_name}${tld}`;
      wantedDomains.push(domain);
      byDomain.set(domain, { row: n, tld });
    }
  }

  for (const stream of ['godaddy-auction', 'godaddy-closeout']) {
    const map = readGoDaddyInventoryDomainMap(stream);
    if (!map) continue;
    for (const domain of wantedDomains) {
      const live = map.get(domain);
      if (!live) continue;
      const target = byDomain.get(domain);
      mergeResearchSaleInfo(target.row, target.tld, normalizeSaleInfo(live, { live: true }));
    }
  }

  for (let i = 0; i < wantedDomains.length; i += 900) {
    const batch = wantedDomains.slice(i, i + 900);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT domain, auction_price, auction_url, stream, source, auction_end, bid_count
      FROM domains
      WHERE domain IN (${placeholders})
      ORDER BY
        CASE
          WHEN stream = 'namecheap-auction' THEN 1
          WHEN stream = 'godaddy-auction' THEN 2
          WHEN stream = 'godaddy-closeout' THEN 3
          WHEN stream IN ('marketplace', 'godaddy-premium') THEN 4
          ELSE 9
        END,
        auction_price IS NULL,
        auction_price ASC
    `).all(...batch);
    for (const row of rows) {
      const target = byDomain.get(row.domain);
      if (!target) continue;
      mergeResearchSaleInfo(target.row, target.tld, normalizeSaleInfo(row));
    }
  }

  return names;
}

function saleInfoFromLander(domain, data) {
  const price = data?.price != null ? Number(data.price) : null;
  return {
    exists: !!data?.forSale,
    checked: true,
    forSale: !!data?.forSale,
    price: Number.isFinite(price) ? price : null,
    url: data?.url || (data?.forSale ? `https://${domain}/` : null),
    stream: data?.platform || null,
    source: data?.source || 'lander',
    live: false,
  };
}

async function hydrateResearchSaleInfo(names, { limit = 50, timeoutMs = 9000, concurrency = 40 } = {}) {
  enrichResearchSaleInfo(names, { limit });
  const subset = names.slice(0, Math.min(limit, names.length));
  const tasks = [];
  for (const n of subset) {
    for (const [key, tld] of [['com', '.com'], ['ai', '.ai']]) {
      const existing = n[key];
      if (existing?.price != null) continue;
      const domain = `${n.base_name}${tld}`;
      tasks.push({ row: n, key, tld, domain });
    }
  }

  let index = 0;
  // Marketplace landers (BoldDomains, Sedo, HugeDomains…) routinely take several
  // seconds to respond — a 900ms cutoff aborted them and falsely reported them as
  // not-for-sale (e.g. agentshield.ai → bolddomains.com is a real 7s+ lander).
  // Use a real timeout; callers run this in the background so it doesn't block.
  const CONCURRENCY = concurrency;
  const worker = async () => {
    while (index < tasks.length) {
      const task = tasks[index++];
      try {
        const cached = landerCache.get(task.domain);
        let data = cached && Date.now() - cached.ts < LANDER_CACHE_TTL
          ? cached.data
          : null;
        if (!data) {
          const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const timer = ac ? setTimeout(() => ac.abort(), timeoutMs + 1500) : null;
          try {
            data = await checkLander(task.domain, {
              timeoutMs,
              maxRedirects: 3,
              signal: ac?.signal,
            });
          } finally {
            if (timer) clearTimeout(timer);
          }
          data.domain = task.domain;
          data.source = 'http';
          landerCache.set(task.domain, { data, ts: Date.now() });
        }
        mergeResearchSaleInfo(task.row, task.tld, saleInfoFromLander(task.domain, data));
      } catch (_) {
        mergeResearchSaleInfo(task.row, task.tld, {
          exists: false,
          checked: true,
          forSale: false,
          price: null,
          url: null,
          stream: null,
          source: 'lander',
          live: false,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
  return names;
}

const app = express();
const PORT = process.env.PORT || 3737;

// The data here is live (auctions age out, counts update). The desktop WebKit
// wrapper and browsers would otherwise cache /api responses (Express sends an
// ETag) and the embedded JS, so the desktop app could show a stale snapshot
// while the browser shows fresh data — the "two instances disagree" symptom.
// Force every dynamic response and the app shell to revalidate, never serve
// from a stale cache.
app.disable('etag');
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
const AGENTFORGE_AGENT_API_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.DOMAINSCOUT_AGENTFORGE_API_ENABLED || '')
);

const AGENTFORGE_MANIFEST = {
  name: 'DomainScout',
  description: 'Local domain discovery, auction, closeout, pending-delete, marketplace, and domain research dashboard. Use the live UI for orientation, and use the app-owned API for large candidate sets and source-backed evidence.',
  primaryUrl: '/',
  workflows: [
    {
      name: 'Discover available domain streams and categories',
      usage: 'Start with /api/agentforge/streams when the user names a category such as auction, closeout, premium, marketplace, pending delete, expired, or expiring. It returns the app-owned stream names and counts agents can query.',
    },
    {
      name: 'Retrieve candidate domains from any DomainScout stream',
      usage: 'Query /api/agentforge/domain-candidates?stream=<stream>&limit=<rows> for candidate rows with raw metrics, source URLs, and research signals. For best/top/research tasks, use the largest practical page size and date/category filters so the agent compares the full relevant source set rather than a small sample. Use stream aliases such as godaddy-auction, godaddy-closeout, namecheap-auction, marketplace, pending-delete, or all.',
    },
    {
      name: 'Retrieve current auction candidates',
      usage: 'Query /api/agentforge/domain-candidates?stream=godaddy-auction&limit=<rows> for current GoDaddy auctions. For a specific auction day, add date=today, date=tomorrow, or date=YYYY-MM-DD and retrieve the full matching day when possible.',
    },
    {
      name: 'Inspect visible domain rows',
      usage: 'Use the browser table for quick confirmation of active filters, selected sort, prices, bids, TLD spread, and auction end dates.',
    },
  ],
  endpoints: [
    {
      method: 'GET',
      path: '/api/agentforge/streams',
      usage: 'Agent-facing inventory of DomainScout streams/categories with counts and useful date/price metadata.',
    },
    {
      method: 'GET',
      path: '/api/agentforge/domain-candidates',
      maxLimit: 100000,
      usage: 'Agent-facing candidate rows from any DomainScout stream/category. Optional params: stream/category, limit, candidates, date=today|tomorrow|YYYY-MM-DD, tld, q, searchMode, maxPrice, minLength, maxLength, noNumbers, noHyphens, hasBids, hasWayback, takenIn, domainSuffix, sortField, and sortDir. sortField accepts source field names and common aliases such as bids, price, auctionEnd, expiryDate, tldsTaken, ageYears, and waybackSnapshots.',
    },
    {
      method: 'GET',
      path: '/api/domains',
      usage: 'Paginated domain rows. Useful params include stream, tld, q, searchMode, sortField, sortDir, page, limit, maxPrice, noNumbers, noHyphens, hasBids, takenIn, domainSuffix, and expiryToday.',
    },
    {
      method: 'GET',
      path: '/api/stats',
      usage: 'Current dataset counts by stream and TLD.',
    },
  ],
  agentNotes: [
    'For recommendation tasks, inspect enough candidates and explain your own selection criteria from the raw fields, source URLs, and research signals; do not present endpoint order as a final verdict by itself.',
    'GoDaddy auctions, GoDaddy closeouts, premium/marketplace listings, pending-delete, and discovered domains are DomainScout streams/categories; do not treat a follow-up category as an undefined external web concept before checking DomainScout streams.',
    'GoDaddy closeouts are current BuyNow snapshot rows from closeout_listings.json.zip. For that stream, auctionEnd is the original auction transition time; do not reject a closeout solely because auctionEnd is in the past.',
    'The expiryToday filter means ending today only. It is narrower than a request for today/current/latest data.',
  ],
  examples: [
    {
      name: 'Discover streams/categories',
      command: "curl -fsS 'http://127.0.0.1:3737/api/agentforge/streams'",
      usage: 'Use this before deciding which stream to query.',
    },
    {
      name: 'GoDaddy auction candidate pool',
      command: "curl -fsS 'http://127.0.0.1:3737/api/agentforge/domain-candidates?stream=godaddy-auction&limit=100000'",
      usage: 'Use this to retrieve a broad current GoDaddy auction candidate pool, then compare the rows yourself.',
    },
    {
      name: 'GoDaddy auction candidate pool for tomorrow',
      command: "curl -fsS 'http://127.0.0.1:3737/api/agentforge/domain-candidates?stream=godaddy-auction&limit=100000&date=tomorrow'",
      usage: 'Use this when the request names tomorrow or another specific auction day; compare the full returned day/window yourself before selecting.',
    },
    {
      name: 'GoDaddy closeout candidate pool',
      command: "curl -fsS 'http://127.0.0.1:3737/api/agentforge/domain-candidates?stream=godaddy-closeout&limit=100000'",
      usage: 'Use this for closeout follow-ups, then decide which names merit deeper research from the returned evidence.',
    },
  ],
};

if (!AGENTFORGE_AGENT_API_ENABLED) {
  AGENTFORGE_MANIFEST.description = 'Local domain discovery, auction, closeout, pending-delete, marketplace, and domain research dashboard. Agent-facing bulk API endpoints are disabled for visual-browser dogfood mode; use the rendered UI and browser/DOM harvesting.';
  AGENTFORGE_MANIFEST.agentApiEnabled = false;
  AGENTFORGE_MANIFEST.workflows = [
    {
      name: 'Inspect and harvest visible DomainScout results',
      usage: 'Open the live dashboard, use the UI controls to choose the requested stream/date/sort, then use browser DOM harvesting over the rendered result table. Do not curl app-owned bulk endpoints for recommendation tasks while visual-browser dogfood mode is active.',
    },
  ];
  AGENTFORGE_MANIFEST.endpoints = [
    {
      method: 'GET',
      path: '/',
      usage: 'Rendered DomainScout dashboard. Use browser/DOM harvesting against the visible table.',
    },
  ];
  AGENTFORGE_MANIFEST.agentNotes = [
    'Agent-facing /api/agentforge/* endpoints are disabled by default in this build.',
    'For DomainScout recommendation tasks, operate through the rendered browser UI and harvest table rows from the DOM.',
    'The normal UI backing APIs remain available for the web app itself; they are not the approved bulk path for agents during this dogfood mode.',
  ];
  AGENTFORGE_MANIFEST.examples = [];
} else {
  AGENTFORGE_MANIFEST.agentApiEnabled = true;
}

app.get('/.well-known/agentforge.json', (_req, res) => res.json(AGENTFORGE_MANIFEST));
app.get('/agentforge.json', (_req, res) => res.json(AGENTFORGE_MANIFEST));

function requireAgentForgeApiEnabled(req, res, next) {
  if (AGENTFORGE_AGENT_API_ENABLED) return next();
  res.set('X-DomainScout-Agent-Api', 'disabled');
  return res.status(410).json({
    error: 'DomainScout agent-facing API is disabled',
    disabled: true,
    mode: 'visual-browser-dogfood',
    message: 'Use the rendered DomainScout UI and browser/DOM harvesting instead of /api/agentforge bulk endpoints.',
    ui: '/',
  });
}

app.use('/api/agentforge', requireAgentForgeApiEnabled);

// ── In-memory query cache ────────────────────────────────────────────────────
const queryCache = new Map();
const CACHE_TTL  = 60_000; // 60 seconds
const STATS_CACHE_TTL = Math.max(60_000, parseInt(process.env.DOMAINSCOUT_STATS_CACHE_TTL_MS || String(15 * 60_000), 10));
const EXPIRED_VISIBLE_MAX_AGE_HOURS = Math.max(
  1,
  Math.min(24 * 30, parseInt(process.env.DOMAINSCOUT_EXPIRED_VISIBLE_MAX_AGE_HOURS || '24', 10) || 24)
);
const STATS_REFRESH_ENABLED = !/^(0|false|no|off)$/i.test(
  String(process.env.DOMAINSCOUT_STATS_REFRESH_ENABLED || '')
);
const STARTUP_ZONE_INDEX_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.DOMAINSCOUT_STARTUP_ZONE_INDEX_ENABLED || '')
);
const STARTUP_MAINTENANCE_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.DOMAINSCOUT_STARTUP_MAINTENANCE_ENABLED || '')
);

function getCached(key) {
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { queryCache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) {
  if (queryCache.size >= 150) {
    // evict oldest
    let oldest = null;
    for (const [k, v] of queryCache) if (!oldest || v.ts < oldest[1].ts) oldest = [k, v];
    if (oldest) queryCache.delete(oldest[0]);
  }
  queryCache.set(key, { data, ts: Date.now() });
}
function bustCache() { queryCache.clear(); }

function getPersistentCache(key) {
  const row = db.prepare('SELECT value_json, updated_at FROM app_cache WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value_json), updatedAt: row.updated_at };
  } catch (_) {
    return null;
  }
}

function setPersistentCache(key, value) {
  db.prepare(`
    INSERT INTO app_cache (key, value_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value));
}

function deletePersistentCache(key) {
  db.prepare('DELETE FROM app_cache WHERE key = ?').run(key);
}

function persistentCacheAgeMs(updatedAt) {
  if (!updatedAt) return Infinity;
  const normalized = String(updatedAt).includes('T')
    ? String(updatedAt)
    : `${String(updatedAt).replace(' ', 'T')}Z`;
  const ts = new Date(normalized).getTime();
  return Number.isFinite(ts) ? Date.now() - ts : Infinity;
}

function getCachedStatsCount(kind, days) {
  const cached = getPersistentCache('stats');
  if (!cached || !cached.value) return null;
  const key = `${kind}${parseBoundedPositiveInt(days, 90, 1, 365)}`;
  if (!Object.prototype.hasOwnProperty.call(cached.value, key)) return null;
  const n = Number(cached.value[key]);
  if (!Number.isFinite(n) || n < 0) return null;
  if (persistentCacheAgeMs(cached.updatedAt) > STATS_CACHE_TTL && STATS_REFRESH_ENABLED) {
    refreshStatsCache({ force: true });
  }
  return n;
}

function visibleDroppedCandidateWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `(
    ${p}stream != 'just-dropped'
    OR ${p}registration_available IS NULL
    OR ${p}registration_available = 1
  )`;
}

function visibleJustDroppedCandidateWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `(
    ${p}registration_available IS NULL
    OR ${p}registration_available = 1
  )`;
}

function recentExpiredWhere(days = 30, prefix = '') {
  const n = Math.min(365, Math.max(1, parseInt(days, 10) || 30));
  const p = prefix ? `${prefix}.` : '';
  return `(
    ${p}registration_available = 1
    AND COALESCE(${p}first_available_at, ${p}availability_checked_at) IS NOT NULL
    AND datetime(COALESCE(${p}first_available_at, ${p}availability_checked_at)) >= datetime('now','-${n} days')
    AND ${p}availability_checked_at IS NOT NULL
    AND datetime(${p}availability_checked_at) >= datetime('now','-${EXPIRED_VISIBLE_MAX_AGE_HOURS} hours')
    AND ${p}availability_error IS NULL
    AND ${registrarConfirmedAvailableWhere(prefix)}
    AND ${p}stream NOT IN ('godaddy-auction','godaddy-closeout','godaddy-premium','namecheap-auction','marketplace')
    AND ${visibleDroppedCandidateWhere(prefix)}
  )`;
}

function getExpiredVisibilityStatus(days = 90) {
  const where = recentExpiredWhere(days);
  const rows = db.prepare(`
    SELECT
      tld,
      COUNT(DISTINCT domain) AS n,
      MIN(availability_checked_at) AS oldest_checked_at,
      MAX(availability_checked_at) AS newest_checked_at
    FROM domains
    WHERE ${where}
    GROUP BY tld
    ORDER BY n DESC, tld ASC
  `).all();
  const total = rows.reduce((sum, row) => sum + Number(row.n || 0), 0);
  const timestamps = rows.flatMap(row => [row.oldest_checked_at, row.newest_checked_at]).filter(Boolean);
  const oldestCheckedAt = timestamps.length ? timestamps.reduce((min, ts) => String(ts) < String(min) ? ts : min, timestamps[0]) : null;
  const newestCheckedAt = timestamps.length ? timestamps.reduce((max, ts) => String(ts) > String(max) ? ts : max, timestamps[0]) : null;
  const oldestAgeMs = oldestCheckedAt ? persistentCacheAgeMs(oldestCheckedAt) : null;
  const newestAgeMs = newestCheckedAt ? persistentCacheAgeMs(newestCheckedAt) : null;
  const maxAgeMs = EXPIRED_VISIBLE_MAX_AGE_HOURS * 3_600_000;
  return {
    days: Math.min(365, Math.max(1, parseInt(days, 10) || 90)),
    maxAgeHours: EXPIRED_VISIBLE_MAX_AGE_HOURS,
    maxAgeMs,
    total,
    byTld: Object.fromEntries(rows.map(row => [row.tld, Number(row.n || 0)])),
    oldestCheckedAt,
    newestCheckedAt,
    oldestAgeMs,
    newestAgeMs,
    stale: oldestAgeMs != null ? oldestAgeMs > maxAgeMs : false,
  };
}

function getExpiredCandidateSupplyStatus() {
  const targetTlds = ['.sh', '.ai', '.io', '.bot'];
  const tldPlaceholders = targetTlds.map(() => '?').join(',');
  const rows = db.prepare(`
    WITH scoped AS (
      SELECT
        tld,
        stream,
        domain,
        whois_checked,
        expiry_date,
        availability_checked_at,
        registration_available,
        availability_error,
        SUBSTR(domain, 1, LENGTH(domain) - LENGTH(tld)) AS base_name
      FROM domains
      WHERE tld IN (${tldPlaceholders})
        AND stream NOT IN ('godaddy-auction','godaddy-closeout','godaddy-premium','namecheap-auction','marketplace')
    )
    SELECT
      tld,
      COUNT(*) AS total,
      SUM(CASE WHEN stream = 'discovered' THEN 1 ELSE 0 END) AS discovered,
      SUM(CASE WHEN whois_checked IS NULL THEN 1 ELSE 0 END) AS expiry_unpolled,
      SUM(CASE
        WHEN
          (expiry_date < datetime('now') AND (whois_checked IS NULL OR whois_checked < datetime('now', '-5 days')))
          OR (expiry_date BETWEEN datetime('now') AND datetime('now', '+90 days') AND (whois_checked IS NULL OR whois_checked < datetime('now', '-5 days')))
          OR whois_checked IS NULL
          OR (whois_checked < datetime('now', '-30 days') AND expiry_date IS NULL)
          OR (whois_checked < datetime('now', '-30 days') AND expiry_date > datetime('now', '+90 days'))
        THEN 1 ELSE 0
      END) AS expiry_poll_due,
      SUM(CASE WHEN expiry_date IS NOT NULL THEN 1 ELSE 0 END) AS expiry_known,
      SUM(CASE WHEN expiry_date IS NOT NULL AND datetime(expiry_date) <= datetime('now') THEN 1 ELSE 0 END) AS expired_evidence,
      SUM(CASE WHEN expiry_date BETWEEN datetime('now') AND datetime('now', '+90 days') THEN 1 ELSE 0 END) AS expiring_evidence,
      SUM(CASE WHEN availability_checked_at IS NULL THEN 1 ELSE 0 END) AS availability_unverified,
      SUM(CASE
        WHEN expiry_date IS NOT NULL
          AND datetime(expiry_date) <= datetime('now')
          AND (
            availability_checked_at IS NULL
            OR (
              registration_available IS NULL
              AND availability_error IS NOT NULL
              AND availability_error != ''
              AND datetime(availability_checked_at) <= datetime('now', '-6 hours')
            )
            OR (
              registration_available IS NULL
              AND (availability_error IS NULL OR availability_error = '')
              AND datetime(availability_checked_at) <= datetime('now', '-12 hours')
            )
            OR (registration_available = 0 AND datetime(availability_checked_at) <= datetime('now', '-12 hours'))
            OR (registration_available = 1 AND datetime(availability_checked_at) <= datetime('now', '-6 hours'))
          )
        THEN 1 ELSE 0
      END) AS expired_availability_unverified,
      SUM(CASE
        WHEN domain LIKE '%@%'
          OR domain LIKE '% %'
          OR domain GLOB '*[^a-z0-9.-]*'
          OR base_name LIKE '%.%'
          OR base_name LIKE '-%'
          OR base_name LIKE '%-'
          OR LENGTH(base_name) < 2
          OR LENGTH(base_name) > 63
          OR base_name GLOB '*[^a-z0-9-]*'
        THEN 1 ELSE 0
      END) AS malformed
    FROM scoped
    GROUP BY tld
    ORDER BY tld
  `).all(...targetTlds);
  const byTld = Object.fromEntries(rows.map(row => [row.tld, {
    total: Number(row.total || 0),
    discovered: Number(row.discovered || 0),
    expiryUnpolled: Number(row.expiry_unpolled || 0),
    expiryPollDue: Number(row.expiry_poll_due || 0),
    expiryKnown: Number(row.expiry_known || 0),
    expiredEvidence: Number(row.expired_evidence || 0),
    expiringEvidence: Number(row.expiring_evidence || 0),
    availabilityUnverified: Number(row.availability_unverified || 0),
    expiredAvailabilityUnverified: Number(row.expired_availability_unverified || 0),
    malformed: Number(row.malformed || 0),
  }]));
  for (const tld of targetTlds) {
    byTld[tld] ||= {
      total: 0,
      discovered: 0,
      expiryUnpolled: 0,
      expiryPollDue: 0,
      expiryKnown: 0,
      expiredEvidence: 0,
      expiringEvidence: 0,
      availabilityUnverified: 0,
      expiredAvailabilityUnverified: 0,
      malformed: 0,
    };
  }
  const totals = Object.values(byTld).reduce((acc, item) => {
    acc.total += item.total;
    acc.discovered += item.discovered;
    acc.expiryUnpolled += item.expiryUnpolled;
    acc.expiryPollDue += item.expiryPollDue;
    acc.expiryKnown += item.expiryKnown;
    acc.expiredEvidence += item.expiredEvidence;
    acc.expiringEvidence += item.expiringEvidence;
    acc.availabilityUnverified += item.availabilityUnverified;
    acc.expiredAvailabilityUnverified += item.expiredAvailabilityUnverified;
    acc.malformed += item.malformed;
    return acc;
  }, {
    total: 0,
    discovered: 0,
    expiryUnpolled: 0,
    expiryPollDue: 0,
    expiryKnown: 0,
    expiredEvidence: 0,
    expiringEvidence: 0,
    availabilityUnverified: 0,
    expiredAvailabilityUnverified: 0,
    malformed: 0,
  });
  return {
    targetTlds,
    totals,
    byTld,
    generatedAt: new Date().toISOString(),
  };
}

function registrarConfirmedAvailableWhere(prefix = '') {
  const tlds = getRegistrarRequiredAvailableTlds();
  if (!tlds.length) return '1=1';
  const p = prefix ? `${prefix}.` : '';
  const quoted = tlds.map(tld => `'${String(tld).replace(/'/g, "''")}'`).join(',');
  return `(
    ${p}tld NOT IN (${quoted})
    OR ${p}availability_source = 'registrar'
    OR ${p}availability_source LIKE 'registrar+%'
  )`;
}

function expiringAtSql(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `CASE
    WHEN ${p}stream IN ('godaddy-auction','namecheap-auction') THEN ${p}auction_end
    WHEN ${p}stream = 'pending-delete' THEN COALESCE(${p}expiry_date, ${p}auction_end, ${p}drop_date)
    ELSE ${p}expiry_date
  END`;
}

function recentExpiringWhere(days = 90, prefix = '') {
  const n = Math.min(365, Math.max(1, parseInt(days, 10) || 90));
  const p = prefix ? `${prefix}.` : '';
  const nowIso = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const cutoffIso = `strftime('%Y-%m-%dT%H:%M:%fZ','now','+${n} days')`;
  const today = `date('now')`;
  const cutoffDate = `date('now','+${n} days')`;
  return `(
    (
      ${p}stream IN ('godaddy-auction','namecheap-auction')
      AND ${p}auction_end IS NOT NULL
      AND ${p}auction_end > ${nowIso}
      AND ${p}auction_end <= ${cutoffIso}
    )
    OR (
      ${p}stream = 'discovered'
      AND ${p}domain NOT IN (SELECT domain FROM domains WHERE stream = 'pending-delete')
      AND ${p}expiry_date IS NOT NULL
      AND ${p}expiry_date > ${nowIso}
      AND ${p}expiry_date <= ${cutoffIso}
    )
    OR (
      ${p}stream = 'pending-delete'
      AND (
        (
          ${p}expiry_date IS NOT NULL
          AND ${p}expiry_date > ${nowIso}
          AND ${p}expiry_date <= ${cutoffIso}
        )
        OR (
          ${p}expiry_date IS NULL
          AND ${p}auction_end IS NOT NULL
          AND ${p}auction_end > ${nowIso}
          AND ${p}auction_end <= ${cutoffIso}
        )
        OR (
          ${p}expiry_date IS NULL
          AND ${p}auction_end IS NULL
          AND ${p}drop_date IS NOT NULL
          AND date(${p}drop_date) >= ${today}
          AND date(${p}drop_date) <= ${cutoffDate}
        )
      )
    )
  )`;
}

function recentExpiringDomainUnionSql(days = 90, extraWhere = '') {
  const n = Math.min(365, Math.max(1, parseInt(days, 10) || 90));
  const nowIso = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const cutoffIso = `strftime('%Y-%m-%dT%H:%M:%fZ','now','+${n} days')`;
  const today = `date('now')`;
  const cutoffDate = `date('now','+${n} days')`;
  const extra = extraWhere ? ` AND (${extraWhere})` : '';
  return `
    SELECT domain
    FROM domains
    WHERE stream IN ('godaddy-auction','namecheap-auction')
      AND auction_end IS NOT NULL
      AND auction_end > ${nowIso}
      AND auction_end <= ${cutoffIso}
      ${extra}
    UNION
    SELECT domain
    FROM domains
    WHERE stream = 'discovered'
      AND domain NOT IN (SELECT domain FROM domains WHERE stream = 'pending-delete')
      AND expiry_date IS NOT NULL
      AND expiry_date > ${nowIso}
      AND expiry_date <= ${cutoffIso}
      ${extra}
    UNION
    SELECT domain
    FROM domains
    WHERE stream = 'pending-delete'
      AND expiry_date IS NOT NULL
      AND expiry_date > ${nowIso}
      AND expiry_date <= ${cutoffIso}
      ${extra}
    UNION
    SELECT domain
    FROM domains
    WHERE stream = 'pending-delete'
      AND expiry_date IS NULL
      AND auction_end IS NOT NULL
      AND auction_end > ${nowIso}
      AND auction_end <= ${cutoffIso}
      ${extra}
    UNION
    SELECT domain
    FROM domains
    WHERE stream = 'pending-delete'
      AND expiry_date IS NULL
      AND auction_end IS NULL
      AND drop_date IS NOT NULL
      AND date(drop_date) >= ${today}
      AND date(drop_date) <= ${cutoffDate}
      ${extra}
  `;
}

let statsRefreshRunning = false;

function activeStatsCount(where = '1=1') {
  const visibleWhere = `(${where}) AND ${visibleDroppedCandidateWhere()}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM domains WHERE ${visibleWhere}`).get().n;
  const ended = db.prepare(`SELECT COUNT(*) AS n FROM domains WHERE ${visibleWhere} AND ${endedAuctionWhere()}`).get().n;
  return total - ended;
}

function activeGroupedStats(field) {
  const visibleWhere = visibleDroppedCandidateWhere();
  const rows = db.prepare(`SELECT ${field} AS value, COUNT(*) AS n FROM domains WHERE ${visibleWhere} GROUP BY ${field}`).all();
  const endedRows = db.prepare(`
    SELECT ${field} AS value, COUNT(*) AS n
    FROM domains
    WHERE ${visibleWhere} AND ${endedAuctionWhere()}
    GROUP BY ${field}
  `).all();
  const endedByValue = new Map(endedRows.map(row => [row.value, row.n]));

  return rows
    .map(row => ({ [field]: row.value, n: row.n - (endedByValue.get(row.value) || 0) }))
    .filter(row => row.n > 0);
}

function buildStats() {
  const total = activeStatsCount();
  // Saved is a curated watchlist — count every saved row regardless of auction
  // status/visibility (consistent with the saved view), so the badge never reads
  // 0 while saved names exist whose auctions have already ended.
  const saved = db.prepare('SELECT COUNT(*) AS n FROM domains WHERE saved = 1').get().n;
  const unseen = activeStatsCount('seen = 0 AND skipped = 0');
  const byStream = activeGroupedStats('stream');
  const byTld = activeGroupedStats('tld').sort((a, b) => b.n - a.n);
  const lastRun = db.prepare(`
    SELECT ran_at, stream, domains_found, domains_new FROM scrape_log
    ORDER BY ran_at DESC LIMIT 8
  `).all();

  const expiredCount = (days) => db.prepare(`SELECT COUNT(DISTINCT domain) as n FROM domains WHERE ${recentExpiredWhere(days)}`).get().n;
  const expiryCount = (days) => db.prepare(`
    SELECT COUNT(*) AS n
    FROM (${recentExpiringDomainUnionSql(days)})
  `).get().n;

  return {
    total, saved, unseen,
    expired1: expiredCount(1),
    expired7: expiredCount(7),
    expired14: expiredCount(14),
    expired30: expiredCount(30),
    expired60: expiredCount(60),
    expired90: expiredCount(90),
    byStream,
    byTld,
    lastRun,
    expiring1: expiryCount(1),
    expiring7: expiryCount(7),
    expiring14: expiryCount(14),
    expiring30: expiryCount(30),
    expiring60: expiryCount(60),
    expiring90: expiryCount(90),
  };
}

function emptyStatsSnapshot() {
  return {
    total: 0,
    saved: 0,
    unseen: 0,
    expired1: 0,
    expired7: 0,
    expired14: 0,
    expired30: 0,
    expired60: 0,
    expired90: 0,
    byStream: [],
    byTld: [],
    lastRun: [],
    expiring1: 0,
    expiring7: 0,
    expiring14: 0,
    expiring30: 0,
    expiring60: 0,
    expiring90: 0,
  };
}

function refreshStatsCache({ force = false } = {}) {
  if (!force && !STATS_REFRESH_ENABLED) return;
  if (statsRefreshRunning) return;
  statsRefreshRunning = true;
  const child = spawn(process.execPath, [path.join(__dirname, 'stats-refresh.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DOMAINSCOUT_SKIP_DB_MAINTENANCE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', (err) => {
    statsRefreshRunning = false;
    console.warn('[Stats] refresh worker failed:', err.message);
  });
  child.on('close', (code) => {
    statsRefreshRunning = false;
    if (code !== 0) {
      console.warn(`[Stats] refresh worker exited ${code}: ${stderr.trim()}`);
    }
  });
}

function invalidateStatsCache() {
  if (!STATS_REFRESH_ENABLED) return;
  refreshStatsCache({ force: true });
}

const APP_USER = 'Admin';
const APP_PASS = 'Gofuckyourselfclaudeyouretard';
const SESSION_SECRET = process.env.SESSION_SECRET || 'domainscout-secret-fixed-key-xk9p2m';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
}));

// ── Auth middleware ──────────────────────────────────────────────────────────
function normalizeRemoteIp(rawIp) {
  return String(rawIp || '')
    .replace(/^::ffff:/, '')
    .replace(/^::1$/, '127.0.0.1');
}

function isTrustedPrivateIp(rawIp) {
  const ip = normalizeRemoteIp(rawIp);
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return true;
  }
  const parts = ip.split('.').map(n => Number(n));
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) return false;
  const [a, b] = parts;
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127);
}

function isLocalRequest(req) {
  if (process.env.DISABLE_AUTH === '1') return true;
  const host = (req.headers.host || '').split(':')[0];
  const ip = normalizeRemoteIp(req.ip || req.socket?.remoteAddress || '');
  return ['localhost', '127.0.0.1', '::1'].includes(host) ||
         ip === '127.0.0.1' ||
         isTrustedPrivateIp(ip);
}

function requireAuth(req, res, next) {
  if (isLocalRequest(req)) return next();
  if (req.session?.authed) return next();
  if (req.path === '/login' || req.path === '/api/login' || req.path === '/api/stats') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── Login page ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (isLocalRequest(req)) return res.redirect('/');
  if (req.session?.authed) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DomainScout — Login</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0f; color: #e0e0e0; font-family: 'JetBrains Mono', monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { width: 360px; }
    .wordmark { font-size: 28px; font-weight: 700; letter-spacing: -1px; margin-bottom: 32px; }
    .wordmark span { color: #22c55e; }
    form { display: flex; flex-direction: column; gap: 12px; }
    input { background: #16161e; border: 1px solid #2a2a3a; color: #e0e0e0; padding: 12px 14px; border-radius: 6px; font-family: inherit; font-size: 14px; outline: none; }
    input:focus { border-color: #22c55e; }
    button { background: #22c55e; color: #0a0a0f; border: none; padding: 12px; border-radius: 6px; font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer; margin-top: 4px; }
    button:hover { background: #16a34a; }
    .err { color: #f87171; font-size: 13px; display: none; }
    .err.show { display: block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="wordmark">domain<span>scout</span></div>
    <form method="POST" action="/api/login">
      <input name="username" type="text" placeholder="username" autocomplete="username" autofocus>
      <input name="password" type="password" placeholder="password" autocomplete="current-password">
      <p class="err ${req.query.err ? 'show' : ''}">Invalid credentials</p>
      <button type="submit">Sign in →</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === APP_USER && password === APP_PASS) {
    req.session.authed = true;
    return res.redirect('/');
  }
  res.redirect('/login?err=1');
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// All routes below require auth
app.use(requireAuth);
app.use(express.static(path.join(__dirname, '../public')));

// ── GET /api/domains ────────────────────────────────────────────────────────
// Filters: stream, tld, minLength, maxLength, noNumbers, noHyphens,
//          minAge, maxAge, hasWayback, dnsAvailable, q (search), seen, saved, skipped
// Sort: field, dir. Pagination: page, limit

function parseBoundedPositiveInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function compactMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'no listed price';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function daysUntil(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.ceil((time - Date.now()) / 86400000);
}

function localDateWindow(offsetDays = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString(), label: start.toISOString().slice(0, 10) };
}

function parseAgentAuctionDateWindow(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'current' || raw === 'latest' || raw === 'active') return null;
  if (raw === 'today') return localDateWindow(0);
  if (raw === 'tomorrow') return localDateWindow(1);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString(), label: raw };
}

const ACTIVE_AUCTION_STREAMS_SQL = ACTIVE_AUCTION_STREAMS
  .map(s => `'${String(s).replace(/'/g, "''")}'`)
  .join(',');
const ACTIVE_AUCTION_STREAM_SET = new Set(ACTIVE_AUCTION_STREAMS);

function dateWindowCondition(field, startParam = 'todayStart', endParam = 'todayEnd') {
  // Compare the stored ISO timestamp directly against ISO bounds (params come from
  // Date.toISOString(), same format as stored values). Do NOT wrap the column in
  // datetime() — that makes the predicate non-sargable and forces a full table
  // scan of ~700k rows, so a "today" auction query took >60s and hung the page.
  // Direct ISO string comparison is chronological AND lets idx_auction_end /
  // idx_expiry_date serve the range (~0.06s).
  return `${field} IS NOT NULL
    AND ${field} >= @${startParam}
    AND ${field} < @${endParam}`;
}

function endingDateWindowConditionForStream(stream, startParam = 'todayStart', endParam = 'todayEnd') {
  const auctionEndWindow = dateWindowCondition('auction_end', startParam, endParam);
  const expiryWindow = dateWindowCondition('expiry_date', startParam, endParam);

  if (stream && stream !== 'all') {
    return ACTIVE_AUCTION_STREAM_SET.has(stream) ? auctionEndWindow : expiryWindow;
  }

  return `((
      stream IN (${ACTIVE_AUCTION_STREAMS_SQL})
      AND ${auctionEndWindow}
    ) OR (
      stream NOT IN (${ACTIVE_AUCTION_STREAMS_SQL})
      AND ${expiryWindow}
    ))`;
}

function endingTodayConditionForStream(stream) {
  return endingDateWindowConditionForStream(stream);
}

function countPhrase(value, singular, plural = `${singular}s`) {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

const AGENTFORGE_STREAM_ALIASES = new Map(Object.entries({
  auction: 'godaddy-auction',
  auctions: 'godaddy-auction',
  'godaddy-auctions': 'godaddy-auction',
  'godaddy auction': 'godaddy-auction',
  'godaddy auctions': 'godaddy-auction',
  closeout: 'godaddy-closeout',
  closeouts: 'godaddy-closeout',
  'godaddy closeout': 'godaddy-closeout',
  'godaddy closeouts': 'godaddy-closeout',
  premium: 'marketplace',
  premiums: 'marketplace',
  marketplace: 'marketplace',
  market: 'marketplace',
  pending: 'pending-delete',
  'pending delete': 'pending-delete',
  'pending-delete': 'pending-delete',
  pendingdelete: 'pending-delete',
  namecheap: 'namecheap-auction',
  'namecheap auction': 'namecheap-auction',
  'namecheap auctions': 'namecheap-auction',
  expired: '_expired30',
  'recent expired': '_expired30',
  'recent-expired': '_expired30',
  'recently expired': '_expired30',
  discovered: 'discovered',
  all: 'all',
}));

function normalizeAgentStream(value, fallback = 'godaddy-auction') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  const compact = raw.replace(/[^a-z0-9]/g, '');
  const expiredMatch = compact.match(/^(?:recentlyexpired|recentexpired|expired)(\d+)?$/);
  if (expiredMatch) {
    const days = parseBoundedPositiveInt(expiredMatch[1], 30, 1, 365);
    return `_expired${days}`;
  }
  const cleaned = raw.replace(/_/g, '-').replace(/\s+/g, ' ');
  return AGENTFORGE_STREAM_ALIASES.get(cleaned) || cleaned.replace(/\s+/g, '-');
}

const DOMAIN_SORT_FIELD_ALIASES = new Map(Object.entries({
  bids: 'bid_count',
  bidcount: 'bid_count',
  bid_count: 'bid_count',
  numberofbids: 'bid_count',
  price: 'auction_price',
  auctionprice: 'auction_price',
  auction_price: 'auction_price',
  end: 'auction_end',
  ends: 'auction_end',
  ending: 'auction_end',
  auctionend: 'auction_end',
  auction_end: 'auction_end',
  expiring: 'expiring_at',
  expiringat: 'expiring_at',
  expiring_at: 'expiring_at',
  expiringdate: 'expiring_at',
  expiring_date: 'expiring_at',
  expiry: 'expiry_date',
  expirydate: 'expiry_date',
  expiry_date: 'expiry_date',
  drop: 'drop_date',
  dropdate: 'drop_date',
  drop_date: 'drop_date',
  available: 'first_available_at',
  availableat: 'first_available_at',
  firstavailable: 'first_available_at',
  firstavailableat: 'first_available_at',
  first_available_at: 'first_available_at',
  confirmed: 'first_available_at',
  confirmedat: 'first_available_at',
  score: 'quality_score',
  quality: 'quality_score',
  qualityscore: 'quality_score',
  quality_score: 'quality_score',
  tldstaken: 'tlds_taken',
  tlds_taken: 'tlds_taken',
  age: 'age_years',
  ageyears: 'age_years',
  age_years: 'age_years',
  wayback: 'wayback_snapshots',
  waybacksnapshots: 'wayback_snapshots',
  wayback_snapshots: 'wayback_snapshots',
}));

function normalizeDomainSortField(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const snake = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
  return DOMAIN_SORT_FIELD_ALIASES.get(compact) || DOMAIN_SORT_FIELD_ALIASES.get(snake) || snake;
}

function agentStreamLabel(stream) {
  const expiredMatch = String(stream || '').match(/^_expired(\d+)$/);
  if (expiredMatch) return `recent expired (${expiredMatch[1]}d)`;
  return {
    'godaddy-auction': 'GoDaddy auction',
    'godaddy-closeout': 'GoDaddy closeout',
    'namecheap-auction': 'Namecheap auction',
    marketplace: 'marketplace/premium',
    'pending-delete': 'pending-delete',
    discovered: 'discovered',
    all: 'all active',
  }[stream] || stream;
}

function isGoDaddyCloseoutStream(streamOrDomain) {
  if (!streamOrDomain) return false;
  if (typeof streamOrDomain === 'string') return streamOrDomain === 'godaddy-closeout';
  return streamOrDomain.stream === 'godaddy-closeout' || /closeout/i.test(String(streamOrDomain.source || ''));
}

function closeoutInventoryMetadata() {
  return {
    status: 'current GoDaddy BuyNow closeout snapshot',
    sourceFeed: 'closeout_listings.json.zip',
    dateFieldMeaning: 'auctionEnd is the original auction transition time, not active closeout expiry or availability proof',
  };
}

function buildAgentResearchSignals(domain) {
  const signals = [];
  const length = Number(domain.length || String(domain.domain || '').split('.')[0]?.length || 0);
  const isCloseout = isGoDaddyCloseoutStream(domain);
  if (isCloseout) signals.push('GoDaddy BuyNow closeout snapshot');
  if (domain.tld) signals.push(`extension=${domain.tld}`);
  if (length) signals.push(`length=${length}`);
  if (!domain.has_numbers && !domain.has_hyphens) signals.push('clean spelling');
  if (Number(domain.tlds_taken || 0) > 0) signals.push(`${countPhrase(domain.tlds_taken, 'TLD')} already registered`);
  if (Number(domain.bid_count || 0) > 0) signals.push(`${countPhrase(domain.bid_count, 'bid')} visible`);
  if (Number(domain.auction_price || 0) > 0) signals.push(`price=${compactMoney(domain.auction_price)}`);
  if (Number(domain.age_years || 0) > 0) signals.push(`${countPhrase(domain.age_years, 'year')} old`);
  if (Number(domain.wayback_snapshots || 0) > 0) signals.push(`${countPhrase(domain.wayback_snapshots, 'Wayback snapshot')} recorded`);
  if (Number(domain.quality_score || 0) > 0) signals.push(`quality score ${domain.quality_score}`);
  if (domain.quality_reasons) signals.push(`quality reasons: ${domain.quality_reasons}`);
  if (isCloseout && domain.auction_end) {
    signals.push(`originalAuctionTransition=${domain.auction_end}`);
  } else if (domain.auction_end || domain.expiry_date || domain.drop_date) {
    signals.push(`date=${domain.auction_end || domain.expiry_date || domain.drop_date}`);
  }
  return signals.filter(Boolean);
}

function agentCandidateFromDomain(domain, index) {
  const isCloseout = isGoDaddyCloseoutStream(domain);
  const isAvailableExpired = domain.registration_available === 1;
  return {
    candidateIndex: index + 1,
    domain: domain.domain,
    stream: domain.stream,
    source: domain.source,
    inventoryStatus: isAvailableExpired
      ? 'confirmed available to register'
      : (isCloseout ? 'current GoDaddy BuyNow closeout snapshot' : 'current active listing'),
    tld: domain.tld,
    length: domain.length,
    price: domain.auction_price,
    bids: domain.bid_count,
    tldsTaken: domain.tlds_taken,
    qualityScore: domain.quality_score,
    qualityReasons: domain.quality_reasons,
    ageYears: domain.age_years,
    waybackSnapshots: domain.wayback_snapshots,
    auctionEnd: domain.auction_end || null,
    auctionEndMeaning: isCloseout ? closeoutInventoryMetadata().dateFieldMeaning : null,
    expiryDate: domain.expiry_date || null,
    dropDate: domain.drop_date || null,
    researchSignals: buildAgentResearchSignals(domain),
    auctionUrl: domain.auction_url,
    sourceUrl: domain.auction_url,
    liveInventoryAt: domain.live_inventory_at || null,
    sourceFeed: domain.source_feed || null,
    metrics: domain.metrics || null,
  };
}

function latestScrapeForStream(stream) {
  if (!stream || stream === 'all') return null;
  try {
    return db.prepare(`
      SELECT ran_at, domains_found, domains_new, error
      FROM scrape_log
      WHERE stream = @stream
      ORDER BY ran_at DESC
      LIMIT 1
    `).get({ stream }) || null;
  } catch (_) {
    return null;
  }
}

function agentDomainPickFilters(req, stream) {
  const conditions = [activeAuctionWhere()];
  const params = {};
  const expiredMatch = stream && String(stream).match(/^_expired(\d+)$/);
  const includeUnavailableDropped = req.query.includeUnavailableDropped === '1' || req.query.includeUnavailable === '1';

  if (expiredMatch) {
    const days = parseBoundedPositiveInt(expiredMatch[1], 30, 1, 365);
    conditions.push(recentExpiredWhere(days));
  } else if (stream && stream !== 'all') {
    conditions.push('stream = @stream');
    params.stream = stream;
  }
  if (!includeUnavailableDropped) {
    if (stream === 'just-dropped') {
      conditions.push(visibleJustDroppedCandidateWhere());
    } else if (!expiredMatch) {
      conditions.push(visibleDroppedCandidateWhere());
    }
  }

  const requestedDateWindow = parseAgentAuctionDateWindow(req.query.date || req.query.day || req.query.auctionDate);
  const isCloseout = isGoDaddyCloseoutStream(stream);
  const dateFilterIgnoredReason = requestedDateWindow && expiredMatch
    ? 'Expired streams are already scoped by confirmed-available recency; auction/date filters are ignored.'
    : requestedDateWindow && isCloseout
    ? 'GoDaddy closeouts are a current BuyNow snapshot feed; date filters based on auctionEnd are ignored because auctionEnd is only the original auction transition time.'
    : null;
  const dateWindow = dateFilterIgnoredReason ? null : requestedDateWindow;
  if (dateWindow) {
    conditions.push(`COALESCE(auction_end, expiry_date, drop_date) IS NOT NULL
      AND datetime(COALESCE(auction_end, expiry_date, drop_date)) >= datetime(@dateStart)
      AND datetime(COALESCE(auction_end, expiry_date, drop_date)) < datetime(@dateEnd)`);
    params.dateStart = dateWindow.start;
    params.dateEnd = dateWindow.end;
  }

  const tld = req.query.tld;
  if (tld && tld !== 'all') {
    const tlds = String(tld).split(',').map(t => t.trim()).filter(Boolean);
    if (tlds.length === 1) {
      conditions.push('tld = @tld');
      params.tld = tlds[0].startsWith('.') ? tlds[0] : `.${tlds[0]}`;
    } else if (tlds.length > 1) {
      const placeholders = tlds.map((_, i) => `@tld${i}`).join(',');
      conditions.push(`tld IN (${placeholders})`);
      tlds.forEach((entry, i) => {
        params[`tld${i}`] = entry.startsWith('.') ? entry : `.${entry}`;
      });
    }
  }

  if (req.query.q) {
    const q = String(req.query.q).toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const mode = req.query.searchMode || 'contains';
    if (mode === 'starts') {
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @q");
      params.q = `${q}%`;
    } else if (mode === 'ends') {
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @q");
      params.q = `%${q}`;
    } else {
      conditions.push('LOWER(domain) LIKE @q');
      params.q = `%${q}%`;
    }
  }

  if (req.query.maxPrice) {
    conditions.push('auction_price IS NOT NULL AND auction_price <= @maxPrice');
    params.maxPrice = parseFloat(req.query.maxPrice);
  }
  if (req.query.minPrice) {
    conditions.push('auction_price IS NOT NULL AND auction_price >= @minPrice');
    params.minPrice = parseFloat(req.query.minPrice);
  }
  if (req.query.minLength) {
    conditions.push('length >= @minLength');
    params.minLength = parseInt(req.query.minLength, 10);
  }
  if (req.query.maxLength) {
    conditions.push('length <= @maxLength');
    params.maxLength = parseInt(req.query.maxLength, 10);
  }
  if (req.query.noNumbers === '1') conditions.push('has_numbers = 0');
  if (req.query.noHyphens === '1') conditions.push('has_hyphens = 0');
  if (req.query.hasBids === '1') conditions.push('bid_count > 0');
  if (req.query.hasWayback === '1') conditions.push('wayback_snapshots > 0');
  if (req.query.saved === '1') conditions.push('saved = 1');
  if (req.query.seen === '0') conditions.push('seen = 0');
  if (req.query.skipped === '0') conditions.push('skipped = 0');

  if (req.query.domainSuffix) {
    const suffixes = String(req.query.domainSuffix).split(',')
      .map(s => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean);
    if (suffixes.length === 1) {
      params.sfx0 = `%${suffixes[0]}`;
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @sfx0");
    } else if (suffixes.length > 1) {
      const orParts = suffixes.map((s, i) => {
        params[`sfx${i}`] = `%${s}`;
        return `LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @sfx${i}`;
      });
      conditions.push(`(${orParts.join(' OR ')})`);
    }
  }

  if (req.query.takenIn) {
    const tlds = String(req.query.takenIn).split(',').map(t => t.trim()).filter(Boolean)
      .map(t => t.startsWith('.') ? t : `.${t}`);
    attachZoneIndex();
    tlds.forEach((t, i) => {
      const key = `takenIn${i}`;
      params[key] = t;
      conditions.push(`${baseNameSql()} IN ${takenInSubquery(key)}`);
    });
  }

  return { conditions, params, dateWindow, requestedDateWindow, dateFilterIgnoredReason };
}

function baseNameFromRow(row) {
  return String(row.domain || '').split('.')[0].toLowerCase();
}

function compareNullableValues(a, b, dir, stringMode = false) {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (stringMode) return String(a).localeCompare(String(b)) * dir;
  const aNum = typeof a === 'number' ? a : Number(a);
  const bNum = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) return (aNum - bNum) * dir;
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return (aTime - bTime) * dir;
  return String(a).localeCompare(String(b)) * dir;
}

function buildGoDaddyCacheCandidatesResponse(req, context) {
  const {
    stream,
    limitNum,
    candidateLimit,
    dateWindow,
    requestedDateWindow,
    dateFilterIgnoredReason,
    isCloseout,
    rawSortField,
    sortField,
    sortDir,
    allowedSortFields,
  } = context;

  if (!isGoDaddyInventoryStream(stream)) return null;
  if (req.query.takenIn || req.query.saved || req.query.seen || req.query.skipped) return null;

  const cache = readGoDaddyInventoryCache(stream);
  if (!cache || !Array.isArray(cache.domains)) return null;

  let rows = cache.domains;

  if (dateWindow && !dateFilterIgnoredReason) {
    const start = new Date(dateWindow.start).getTime();
    const end = new Date(dateWindow.end).getTime();
    rows = rows.filter((row) => {
      const time = new Date(row.auction_end || row.expiry_date || row.drop_date || '').getTime();
      return Number.isFinite(time) && time >= start && time < end;
    });
  }

  const tld = req.query.tld;
  if (tld && tld !== 'all') {
    const wanted = new Set(String(tld).split(',').map(t => t.trim()).filter(Boolean).map(t => t.startsWith('.') ? t : `.${t}`));
    rows = rows.filter(row => wanted.has(row.tld));
  }

  if (req.query.q) {
    const q = String(req.query.q).toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const mode = req.query.searchMode || 'contains';
    rows = rows.filter((row) => {
      const base = baseNameFromRow(row);
      if (mode === 'starts') return base.startsWith(q);
      if (mode === 'ends') return base.endsWith(q);
      return String(row.domain || '').toLowerCase().includes(q);
    });
  }

  if (req.query.domainSuffix) {
    const suffixes = String(req.query.domainSuffix).split(',')
      .map(s => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean);
    if (suffixes.length) rows = rows.filter(row => suffixes.some(s => baseNameFromRow(row).endsWith(s)));
  }

  if (req.query.maxPrice) rows = rows.filter(row => row.auction_price != null && Number(row.auction_price) <= parseFloat(req.query.maxPrice));
  if (req.query.minPrice) rows = rows.filter(row => row.auction_price != null && Number(row.auction_price) >= parseFloat(req.query.minPrice));
  if (req.query.minLength) rows = rows.filter(row => Number(row.length) >= parseInt(req.query.minLength, 10));
  if (req.query.maxLength) rows = rows.filter(row => Number(row.length) <= parseInt(req.query.maxLength, 10));
  if (req.query.noNumbers === '1') rows = rows.filter(row => !row.has_numbers);
  if (req.query.noHyphens === '1') rows = rows.filter(row => !row.has_hyphens);
  if (req.query.hasBids === '1') rows = rows.filter(row => Number(row.bid_count || 0) > 0);
  if (req.query.hasWayback === '1') rows = rows.filter(row => Number(row.wayback_snapshots || 0) > 0);

  const dir = String(sortDir).toUpperCase() === 'ASC' ? 1 : -1;
  if (allowedSortFields.has(sortField)) {
    rows = [...rows].sort((a, b) => (
      compareNullableValues(a[sortField], b[sortField], dir, sortField === 'domain')
      || compareNullableValues(a.auction_end || a.expiry_date || a.drop_date, b.auction_end || b.expiry_date || b.drop_date, 1)
      || String(a.domain).localeCompare(String(b.domain))
    ));
  } else {
    rows = [...rows].sort((a, b) => (
      compareNullableValues(a.auction_end || a.expiry_date || a.drop_date, b.auction_end || b.expiry_date || b.drop_date, 1)
      || String(a.domain).localeCompare(String(b.domain))
    ));
  }

  const reviewedRows = rows.slice(0, candidateLimit);
  const candidates = reviewedRows.slice(0, limitNum).map(agentCandidateFromDomain);

  return {
    source: dateWindow
      ? `DomainScout ${agentStreamLabel(stream)} bulk inventory cache for ${dateWindow.label}`
      : `DomainScout current ${agentStreamLabel(stream)} bulk inventory cache`,
    stream,
    category: agentStreamLabel(stream),
    generatedAt: new Date().toISOString(),
    inventory: {
      ...(isCloseout ? closeoutInventoryMetadata() : { status: 'current active listing dataset' }),
      sourceFeed: stream === 'godaddy-auction' ? 'GoDaddy bulk biddable/expiring auction inventory' : 'closeout_listings.json.zip',
      latestCacheAt: cache.generatedAt,
      domainsInCache: cache.count,
      note: 'Served from raw GoDaddy bulk inventory cache so agents can work while the SQLite import/enrichment job continues.',
    },
    dateFilter: dateWindow ? { label: dateWindow.label, start: dateWindow.start, end: dateWindow.end } : null,
    requestedDateFilter: requestedDateWindow ? { label: requestedDateWindow.label, start: requestedDateWindow.start, end: requestedDateWindow.end, applied: !dateFilterIgnoredReason, ignoredReason: dateFilterIgnoredReason } : null,
    candidatesReviewed: reviewedRows.length,
    totalCandidatesMatched: rows.length,
    requestedLimit: limitNum,
    candidateOrdering: allowedSortFields.has(sortField)
      ? [`${sortField} ${sortDir}${rawSortField && rawSortField !== sortField ? ` (from sortField=${rawSortField})` : ''}`, 'then neutral date/discovery tie-breakers']
      : [
        'nearest relevant date',
        'domain name tie-breaker',
      ],
    sortableFields: [...allowedSortFields],
    availableSignals: [
      'tld',
      'length',
      'has_numbers',
      'has_hyphens',
      'bids',
      'price',
      'ageYears',
      'auctionEnd',
      'sourceUrl',
    ],
    notes: [
      isCloseout
        ? 'GoDaddy closeouts are BuyNow closeout snapshot rows from closeout_listings.json.zip; auctionEnd is the original auction transition time, not proof the closeout is unavailable.'
        : null,
      dateFilterIgnoredReason,
      dateWindow
        ? 'The date filter matches domains whose auction_end falls inside the requested local calendar day.'
        : 'No date filter was applied; current/latest means the current active dataset for the selected stream.',
      'This endpoint returns candidate data, not a purchase recommendation or final ranking.',
      'No third-party valuation fields are used here; agents should reason from the raw auction facts and follow-up research.',
    ].filter(Boolean),
    candidates,
  };
}

function buildAgentDomainCandidatesResponse(req, defaults = {}) {
  const limitNum = parseBoundedPositiveInt(req.query.limit, defaults.limit || 25, 1, 100000);
  const candidateLimit = parseBoundedPositiveInt(
    req.query.candidates,
    Math.max(250, limitNum),
    limitNum,
    100000
  );
  const stream = normalizeAgentStream(req.query.stream || req.query.category || defaults.stream, defaults.stream || 'godaddy-auction');
  const { conditions, params, dateWindow, requestedDateWindow, dateFilterIgnoredReason } = agentDomainPickFilters(req, stream);
  const scrapeInfo = latestScrapeForStream(stream);
  const isCloseout = isGoDaddyCloseoutStream(stream);
  const rawSortField = String(req.query.sortField || '').trim();
  const sortField = normalizeDomainSortField(rawSortField);
  const sortDir = String(req.query.sortDir || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const allowedSortFields = new Set(['auction_price', 'bid_count', 'tlds_taken', 'age_years', 'wayback_snapshots', 'length', 'auction_end', 'expiry_date', 'drop_date', 'domain']);
  const isRecentExpiredStream = /^_expired\d+$/.test(stream);
  const defaultOrdering = isRecentExpiredStream
    ? `
      tlds_taken DESC NULLS LAST,
      wayback_snapshots DESC NULLS LAST,
      COALESCE(drop_date, expiry_date, auction_end, discovered_at) DESC,
      discovered_at DESC
    `
    : `
      COALESCE(auction_end, expiry_date, drop_date, discovered_at) ASC,
      discovered_at DESC
    `;
  const primarySort = allowedSortFields.has(sortField)
    ? `${sortField} ${sortDir} NULLS LAST, ${defaultOrdering}`
    : defaultOrdering;

  const cacheResponse = buildGoDaddyCacheCandidatesResponse(req, {
    stream,
    limitNum,
    candidateLimit,
    dateWindow,
    requestedDateWindow,
    dateFilterIgnoredReason,
    isCloseout,
    rawSortField,
    sortField,
    sortDir,
    allowedSortFields,
  });
  if (cacheResponse) return cacheResponse;

  const rowsSql = isRecentExpiredStream
    ? `
      SELECT * FROM (
        SELECT d.*, ROW_NUMBER() OVER (
          PARTITION BY domain
          ORDER BY
            CASE d.stream
              WHEN 'pending-delete' THEN 0
              WHEN 'just-dropped' THEN 1
              WHEN 'godaddy-closeout' THEN 2
              WHEN 'discovered' THEN 3
              ELSE 9
            END ASC,
            COALESCE(auction_price, 9999999) ASC,
            id ASC
        ) AS _rn
        FROM domains d
        WHERE ${conditions.join(' AND ')}
      )
      WHERE _rn = 1
      ORDER BY ${primarySort}, domain ASC
      LIMIT ${candidateLimit}
    `
    : `
      SELECT *
      FROM domains
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${primarySort},
        domain ASC
      LIMIT ${candidateLimit}
    `;
  const rows = db.prepare(rowsSql).all(params);

  enrichPageTldCounts(rows);
  overlayGoDaddyInventoryRows(rows);
  const candidates = rows.slice(0, limitNum).map(agentCandidateFromDomain);

  return {
    source: dateWindow
      ? `DomainScout ${agentStreamLabel(stream)} dataset for ${dateWindow.label}`
      : `DomainScout current ${agentStreamLabel(stream)} dataset`,
    stream,
    category: agentStreamLabel(stream),
    generatedAt: new Date().toISOString(),
    inventory: scrapeInfo ? {
      ...(isCloseout ? closeoutInventoryMetadata() : { status: 'current active listing dataset' }),
      latestScrapeAt: scrapeInfo.ran_at,
      domainsFoundInLatestScrape: scrapeInfo.domains_found,
      domainsNewInLatestScrape: scrapeInfo.domains_new,
      error: scrapeInfo.error || null,
    } : (isCloseout ? closeoutInventoryMetadata() : null),
    dateFilter: dateWindow ? { label: dateWindow.label, start: dateWindow.start, end: dateWindow.end } : null,
    requestedDateFilter: requestedDateWindow ? { label: requestedDateWindow.label, start: requestedDateWindow.start, end: requestedDateWindow.end, applied: !dateFilterIgnoredReason, ignoredReason: dateFilterIgnoredReason } : null,
    candidatesReviewed: rows.length,
    requestedLimit: limitNum,
    candidateOrdering: allowedSortFields.has(sortField)
      ? [`${sortField} ${sortDir}${rawSortField && rawSortField !== sortField ? ` (from sortField=${rawSortField})` : ''}`, 'then neutral date/discovery tie-breakers']
      : [
        'nearest relevant date',
        'newer discovery timestamp',
      ],
    sortableFields: [...allowedSortFields],
    availableSignals: [
      'tld',
      'length',
      'has_numbers',
      'has_hyphens',
      'tldsTaken',
      'bids',
      'price',
      'ageYears',
      'waybackSnapshots',
      'auctionEnd/expiryDate/dropDate',
      'sourceUrl',
    ],
    notes: [
      isCloseout
        ? 'GoDaddy closeouts are BuyNow closeout snapshot rows from closeout_listings.json.zip; auctionEnd is the original auction transition time, not proof the closeout is unavailable.'
        : null,
      dateFilterIgnoredReason,
      dateWindow
        ? 'The date filter matches domains whose auction_end/expiry_date/drop_date falls inside the requested local calendar day.'
        : 'No date filter was applied; current/latest means the current active dataset for the selected stream.',
      'This endpoint returns candidate data, not a purchase recommendation or final ranking.',
      'Use sourceUrl and researchSignals for follow-up research on individual names.',
    ].filter(Boolean),
    candidates,
  };
}

app.get('/api/domains', (req, res) => {
  const cacheKey = req.url;
  const streamForCache = String(req.query.stream || '');
  const goDaddyLiveRequest = isGoDaddyInventoryStream(streamForCache);
  if (goDaddyLiveRequest) startGoDaddyRefreshWorker('stale-live-view');
  const cached = goDaddyLiveRequest ? null : getCached(cacheKey);
  if (cached) return res.json(cached);
  const {
    stream, tld, q,
    minLength, maxLength,
    noNumbers, noHyphens,
    minAge, maxAge,
    hasWayback, dnsAvailable,
    seen, saved, skipped,
    takenIn,
    sortField = 'discovered_at', sortDir = 'DESC',
    page = 1, limit = 100,
  } = req.query;
  let effectiveSortField = sortField;
  // Normalize so a lowercase ?sortDir=asc (common from agents/links) is honored
  // instead of silently falling through to DESC at the `=== 'ASC'` checks below.
  let effectiveSortDir = String(sortDir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const conditions = [];
  const params = {};

  const streamName = String(stream || '');
  const expiringMatch = streamName.match(/^_expiring(\d+)$/);
  const expiredMatch = streamName.match(/^_expired(\d+)$/);
  const includeUnavailableDropped = req.query.includeUnavailableDropped === '1' || req.query.includeUnavailable === '1';
  let virtualExpiringDays = null;
  let countTldClause = '';
  let hasNonTldCountFilters = false;

  // Virtual "expiring" streams: registry expiry/drop dates for tracked domains,
  // plus active expiry-auction close dates for auction streams.
  if (expiringMatch) {
    const days = parseBoundedPositiveInt(expiringMatch[1], 90, 1, 365);
    virtualExpiringDays = days;
    conditions.push(recentExpiringWhere(days));
    // Default sort for expiring view: soonest first
    if (!req.query.sortField) {
      effectiveSortField = 'expiring_at';
      effectiveSortDir = 'ASC';
    }
  } else if (expiredMatch) {
    // Recent expired view: only domains confirmed registerable by RDAP + DNS.
    const days = parseBoundedPositiveInt(expiredMatch[1], 30, 1, 365);
    conditions.push(recentExpiredWhere(days));
    if (!req.query.sortField) {
      effectiveSortField = 'quality_score';
      effectiveSortDir = 'DESC';
    }
  } else if (stream && stream !== 'all') {
    conditions.push('stream = @stream');
    params.stream = stream;
  } else if (!stream || stream === 'all') {
    // ccTLDs (.ai/.io/.sh/.bot) are seeded almost entirely via crt.sh → 'discovered'.
    // When the user explicitly filters by a ccTLD, show all discovered for that TLD —
    // RDAP polling may not have run yet so filtering by expiry_date would show nothing.
    // For 'all TLDs', still hide unpolled discovered to avoid flooding with active sites.
    const ccTLDs = ['.ai', '.io', '.sh', '.bot'];
    const filteredTlds = tld && tld !== 'all'
      ? tld.split(',').map(t => t.trim()).map(t => t.startsWith('.') ? t : '.' + t)
      : [];
    const filteringByCcTLD = filteredTlds.length > 0 && filteredTlds.every(t => ccTLDs.includes(t));
    if (!filteringByCcTLD) {
      conditions.push("(stream != 'discovered' OR (expiry_date IS NOT NULL AND expiry_date <= datetime('now','+30 days')))");
    }
  }
  if (!includeUnavailableDropped) {
    if (streamName === 'just-dropped') {
      conditions.push(visibleJustDroppedCandidateWhere());
    } else if (!expiredMatch && !expiringMatch) {
      conditions.push(visibleDroppedCandidateWhere());
    }
  }
  if (tld && tld !== 'all') {
    const tlds = tld.split(',').map(t => t.trim()).filter(Boolean);
    if (tlds.length === 1) {
      conditions.push('tld = @tld');
      params.tld = tlds[0].startsWith('.') ? tlds[0] : '.' + tlds[0];
      countTldClause = 'tld = @tld';
    } else {
      const placeholders = tlds.map((t, i) => `@tld${i}`).join(',');
      conditions.push(`tld IN (${placeholders})`);
      countTldClause = `tld IN (${placeholders})`;
      tlds.forEach((t, i) => params[`tld${i}`] = t.startsWith('.') ? t : '.' + t);
    }
  }
  if (q) {
    hasNonTldCountFilters = true;
    const mode = req.query.searchMode || 'contains';
    if (mode === 'starts') {
      // Match base name starts with q (strip TLD: SUBSTR up to first dot)
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @q");
      params.q = `${q.toLowerCase()}%`;
    } else if (mode === 'ends') {
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @q");
      params.q = `%${q.toLowerCase()}`;
    } else {
      // Comma-separated terms are an OR multi-keyword search: "AI, agent" matches
      // domains containing "ai" OR "agent", not the literal string "ai, agent"
      // (which matches nothing). Single term keeps the simple contains behavior.
      const terms = String(q).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      if (terms.length > 1) {
        const ors = terms.map((t, i) => { params[`q${i}`] = `%${t}%`; return `domain LIKE @q${i}`; });
        conditions.push(`(${ors.join(' OR ')})`);
      } else {
        conditions.push('domain LIKE @q');
        params.q = `%${(terms[0] || q.toLowerCase())}%`;
      }
    }
  }
  if (req.query.maxPrice) { hasNonTldCountFilters = true; conditions.push('auction_price IS NOT NULL AND auction_price <= @maxPrice'); params.maxPrice = parseFloat(req.query.maxPrice); }
  if (req.query.minPrice) { hasNonTldCountFilters = true; conditions.push('auction_price IS NOT NULL AND auction_price >= @minPrice'); params.minPrice = parseFloat(req.query.minPrice); }
  if (minLength) { hasNonTldCountFilters = true; conditions.push('length >= @minLength'); params.minLength = parseInt(minLength); }
  if (maxLength) { hasNonTldCountFilters = true; conditions.push('length <= @maxLength'); params.maxLength = parseInt(maxLength); }
  if (noNumbers === '1') { hasNonTldCountFilters = true; conditions.push('has_numbers = 0'); }
  if (noHyphens === '1') { hasNonTldCountFilters = true; conditions.push('has_hyphens = 0'); }
  if (minAge) { hasNonTldCountFilters = true; conditions.push('age_years >= @minAge'); params.minAge = parseInt(minAge); }
  if (maxAge) { hasNonTldCountFilters = true; conditions.push('age_years <= @maxAge'); params.maxAge = parseInt(maxAge); }
  if (hasWayback === '1') { hasNonTldCountFilters = true; conditions.push('wayback_snapshots > 0'); }
  if (dnsAvailable === '1') { hasNonTldCountFilters = true; conditions.push('dns_available = 1'); }
  if (req.query.hasBids === '1') { hasNonTldCountFilters = true; conditions.push('bid_count > 0'); }
  if (seen === '1') { hasNonTldCountFilters = true; conditions.push('seen = 1'); }
  if (seen === '0') { hasNonTldCountFilters = true; conditions.push('seen = 0'); }
  if (saved === '1') { hasNonTldCountFilters = true; conditions.push('saved = 1'); }
  if (skipped === '1') { hasNonTldCountFilters = true; conditions.push('skipped = 1'); }
  if (skipped === '0') { hasNonTldCountFilters = true; conditions.push('skipped = 0'); }
  // When the user is reviewing a curated/marked list (their saved watchlist or
  // skipped items), show those rows regardless of auction status — otherwise a
  // saved name silently vanishes the moment its auction ends.
  const viewingMarkedList = saved === '1' || skipped === '1';
  if (!expiredMatch && !expiringMatch && !viewingMarkedList) conditions.push(activeAuctionWhere());

  // "Also taken in" filter — queries internal domains table (works for all TLDs immediately)
  // plus zone_names when the zone index is attached (broader coverage for gTLDs).
  if (takenIn) {
    hasNonTldCountFilters = true;
    const tlds = takenIn.split(',').map(t => t.trim()).filter(Boolean)
      .map(t => t.startsWith('.') ? t : '.' + t);
    attachZoneIndex();
    tlds.forEach((t, i) => {
      const key = `takenIn${i}`;
      params[key] = t;
      conditions.push(`${baseNameSql()} IN ${takenInSubquery(key)}`);
    });
  }

  // Expiry filter: expiringDays=90 shows domains expiring within N days
  if (req.query.expiringDays) {
    hasNonTldCountFilters = true;
    const days = parseInt(req.query.expiringDays);
    const cutoff = new Date(Date.now() + days * 86400000).toISOString();
    conditions.push("expiry_date IS NOT NULL AND expiry_date <= @expiryCutoff AND expiry_date >= datetime('now')");
    params.expiryCutoff = cutoff;
  }

  const dateWindow = String(req.query.dateWindow || '').trim().toLowerCase();
  if (!expiredMatch && dateWindow && dateWindow !== 'any') {
    hasNonTldCountFilters = true;
    let start;
    let end;
    if (dateWindow === 'today') {
      ({ start, end } = localDateWindow(0));
    } else if (dateWindow === 'tomorrow') {
      ({ start, end } = localDateWindow(1));
    } else {
      const nextMatch = dateWindow.match(/^next(\d+)$/);
      const days = nextMatch ? parseBoundedPositiveInt(nextMatch[1], 0, 1, 31) : 0;
      if (days > 0) {
        start = localDateWindow(0).start;
        end = localDateWindow(days).end;
      }
    }
    if (start && end) {
      params.dateWindowStart = start;
      params.dateWindowEnd = end;
      conditions.push(endingDateWindowConditionForStream(stream, 'dateWindowStart', 'dateWindowEnd'));
    }
  } else if (!expiredMatch && req.query.expiryToday === '1') {
    hasNonTldCountFilters = true;
    // "Ends today only" = still-live auctions ending within the next 24 HOURS
    // (a rolling window from now), NOT the calendar day. A calendar-day filter is
    // empty every evening once the day's batch closes (~2:30pm Pacific for GoDaddy);
    // users want the soonest still-biddable auctions and explicitly do NOT want
    // ones that have already ended. auction streams use auction_end; non-auction
    // streams keep the expiry_date field behind the same flag.
    params.todayStart = new Date().toISOString();
    params.todayEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    conditions.push(endingTodayConditionForStream(stream));
  }

  // Domain suffix filter: comma-separated list of base-name suffixes (OR match)
  if (req.query.domainSuffix) {
    hasNonTldCountFilters = true;
    const suffixes = req.query.domainSuffix.split(',')
      .map(s => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean);
    if (suffixes.length === 1) {
      params.sfx0 = `%${suffixes[0]}`;
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @sfx0");
    } else if (suffixes.length > 1) {
      const orParts = suffixes.map((s, i) => { params[`sfx${i}`] = `%${s}`; return `LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @sfx${i}`; });
      conditions.push(`(${orParts.join(' OR ')})`);
    }
  }

  const allowedFields = ['discovered_at', 'domain', 'length', 'quality_score', 'tlds_taken', 'auction_price', 'age_years', 'wayback_snapshots', 'expiry_date', 'drop_date', 'first_available_at', 'auction_end', 'expiring_at', 'bid_count'];
  const normalizedSortField = normalizeDomainSortField(effectiveSortField);
  const sortBy = allowedFields.includes(normalizedSortField) ? normalizedSortField : 'discovered_at';
  const dir = effectiveSortDir === 'ASC' ? 'ASC' : 'DESC';
  const sortingByTlds = sortBy === 'tlds_taken';

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const pageNum = parseBoundedPositiveInt(page, 1, 1, 1000000);
  const limitNum = parseBoundedPositiveInt(limit, 100, 1, 10000);
  const offset = (pageNum - 1) * limitNum;

  // The EXTENSION column is sorted by the stored, indexed domains.tlds_taken column
  // (so pagination stays fast). syncDomainTldCountsFromVerifiedCache keeps that column
  // equal to what enrichPageTldCounts displays — MAX(zone tld_count, cache count) — and
  // runs on startup + after each CZDS/zone rebuild, so the order matches the numbers.

  // NULLS LAST lets SQLite use the index directly; expression-based sorts force a filesort
  const nullsLastFields = ['expiry_date', 'drop_date', 'first_available_at', 'auction_price', 'age_years', 'quality_score', 'tlds_taken', 'wayback_snapshots'];
  const orderClause = sortingByTlds
    ? `tlds_taken ${dir} NULLS LAST, domain ASC`
    : sortBy === 'expiring_at'
    ? `${expiringAtSql()} ${dir} NULLS LAST, domain ASC`
    : nullsLastFields.includes(sortBy)
    ? `${sortBy} ${dir} NULLS LAST`
    : `${sortBy} ${dir}`;

  const canUseFastList = !takenIn && !q && !req.query.domainSuffix;
  const isVirtualExpired = Boolean(expiredMatch);
  const isVirtualExpiring = Boolean(expiringMatch);
  const dedupeResults = !canUseFastList || isVirtualExpired || isVirtualExpiring;

  // If client already knows the total (e.g. from stats), skip the COUNT scan.
  // Recent-expired virtual streams are deduped by domain because the same name can
  // arrive from both a discovery feed and a pending/delete source.
  // A non-positive knownTotal is never a valid optimization — counting an empty
  // set is already cheap. Treat <=0/NaN as "not provided" so a stale 0 (e.g. the
  // disabled-stats saved/unseen count fed back as knownTotal) can't override and
  // zero out the real total while rows still render. Otherwise canTrustKnownTotal
  // below would return total=0 for a view that actually has rows.
  const parsedKnownTotal = req.query.knownTotal != null ? parseInt(req.query.knownTotal, 10) : NaN;
  const knownTotal = Number.isFinite(parsedKnownTotal) && parsedKnownTotal > 0 ? parsedKnownTotal : null;
  const canUseExpiringKnownTotal = isVirtualExpiring &&
    !hasNonTldCountFilters &&
    !countTldClause &&
    knownTotal != null &&
    Number.isFinite(knownTotal) &&
    knownTotal > 0;
  const canTrustKnownTotal = !isVirtualExpired && (!isVirtualExpiring || canUseExpiringKnownTotal);
  const cachedVirtualExpiringTotal = isVirtualExpiring && !hasNonTldCountFilters && !countTldClause
    ? getCachedStatsCount('expiring', virtualExpiringDays)
    : null;
  let fastVirtualExpiringTotal = null;
  if (!canTrustKnownTotal && cachedVirtualExpiringTotal == null && isVirtualExpiring && !hasNonTldCountFilters) {
    fastVirtualExpiringTotal = db.prepare(`
      SELECT COUNT(*) AS n
      FROM (${recentExpiringDomainUnionSql(virtualExpiringDays, countTldClause)})
    `).get(params).n;
  }
  const total = (canTrustKnownTotal && knownTotal != null && Number.isFinite(knownTotal))
    ? knownTotal
    : cachedVirtualExpiringTotal != null
      ? cachedVirtualExpiringTotal
      : fastVirtualExpiringTotal != null
      ? fastVirtualExpiringTotal
      : dedupeResults
        ? db.prepare(`SELECT COUNT(DISTINCT domain) as n FROM domains ${where}`).get(params).n
        : db.prepare(`SELECT COUNT(*) as n FROM domains ${where}`).get(params).n;

  function tryFastExpiringPage() {
    if (!isVirtualExpiring || !canUseFastList || sortBy !== 'expiring_at' || dir !== 'ASC') return null;
    if (hasNonTldCountFilters) return null;
    if (pageNum > 5) return null;

    const target = offset + limitNum;
    let fetchLimit = Math.min(5000, Math.max(250, target * 3));
    const nowIso = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
    const cutoffIso = `strftime('%Y-%m-%dT%H:%M:%fZ','now','+${virtualExpiringDays || 90} days')`;
    const today = `date('now')`;
    const cutoffDate = `date('now','+${virtualExpiringDays || 90} days')`;
    const tldFilter = countTldClause ? ` AND (${countTldClause})` : '';
    const segments = [
      {
        expiringExpr: 'auction_end',
        priority: 0,
        where: `
          stream = 'godaddy-auction'
          AND auction_end IS NOT NULL
          AND auction_end > ${nowIso}
          AND auction_end <= ${cutoffIso}
          ${tldFilter}
        `,
      },
      {
        expiringExpr: 'auction_end',
        priority: 0,
        where: `
          stream = 'namecheap-auction'
          AND auction_end IS NOT NULL
          AND auction_end > ${nowIso}
          AND auction_end <= ${cutoffIso}
          ${tldFilter}
        `,
      },
      {
        expiringExpr: 'expiry_date',
        priority: 3,
        where: `
          stream = 'discovered'
          AND domain NOT IN (SELECT domain FROM domains WHERE stream = 'pending-delete')
          AND expiry_date IS NOT NULL
          AND expiry_date > ${nowIso}
          AND expiry_date <= ${cutoffIso}
          ${tldFilter}
        `,
      },
      {
        expiringExpr: 'expiry_date',
        priority: 0,
        where: `
          stream = 'pending-delete'
          AND expiry_date IS NOT NULL
          AND expiry_date > ${nowIso}
          AND expiry_date <= ${cutoffIso}
          ${tldFilter}
        `,
      },
      {
        expiringExpr: 'auction_end',
        priority: 0,
        where: `
          stream = 'pending-delete'
          AND expiry_date IS NULL
          AND auction_end IS NOT NULL
          AND auction_end > ${nowIso}
          AND auction_end <= ${cutoffIso}
          ${tldFilter}
        `,
      },
      {
        expiringExpr: 'drop_date',
        priority: 0,
        where: `
          stream = 'pending-delete'
          AND expiry_date IS NULL
          AND auction_end IS NULL
          AND drop_date IS NOT NULL
          AND date(drop_date) >= ${today}
          AND date(drop_date) <= ${cutoffDate}
          ${tldFilter}
        `,
      },
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
      const batches = segments.map(segment => db.prepare(`
        SELECT domains.*, ${segment.expiringExpr} AS expiring_at, ${segment.priority} AS _priority
        FROM domains
        WHERE ${segment.where}
        ORDER BY ${segment.expiringExpr} ASC, domain ASC, COALESCE(auction_price, 9999999) ASC, id ASC
        LIMIT ${fetchLimit}
      `).all(params));
      const rows = batches.flat();
      rows.sort((a, b) => {
        const at = String(a.expiring_at || '');
        const bt = String(b.expiring_at || '');
        if (at !== bt) return at < bt ? -1 : 1;
        if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
        if (a._priority !== b._priority) return a._priority - b._priority;
        return (a.id || 0) - (b.id || 0);
      });

      const seenDomains = new Set();
      const uniqueRows = [];
      for (const row of rows) {
        if (seenDomains.has(row.domain)) continue;
        seenDomains.add(row.domain);
        uniqueRows.push(row);
        if (uniqueRows.length >= target) break;
      }

      const exhausted = batches.every(batch => batch.length < fetchLimit);
      if (uniqueRows.length >= target || exhausted) {
        return uniqueRows.slice(offset, offset + limitNum);
      }
      fetchLimit = Math.min(5000, fetchLimit * 2);
    }
    return null;
  }

  let domains;
  const fastExpiringRows = tryFastExpiringPage();
  if (fastExpiringRows) {
    domains = fastExpiringRows;
  } else if (!dedupeResults) {
    domains = db.prepare(`
      SELECT domains.*, ${expiringAtSql()} AS expiring_at
      FROM domains ${where}
      ORDER BY ${orderClause}
      LIMIT ${limitNum} OFFSET ${offset}
    `).all(params);
  } else {
    // Deduplicate only for searches/filters where cross-stream duplicates are
    // likely enough to justify the expensive window function.
    const dedupeSource = isVirtualExpired && tld && tld !== 'all'
      ? 'domains d INDEXED BY idx_tld_available_quality'
      : 'domains d';
    domains = db.prepare(`
      SELECT * FROM (
        SELECT d.*, ${expiringAtSql('d')} AS expiring_at, ROW_NUMBER() OVER (
          PARTITION BY domain
          ORDER BY
            CASE d.stream
              WHEN 'pending-delete' THEN 0
              WHEN 'just-dropped' THEN 1
              WHEN 'godaddy-closeout' THEN 2
              WHEN 'discovered' THEN 3
              ELSE 9
            END ASC,
            COALESCE(auction_price, 9999999) ASC,
            id ASC
        ) AS _rn
        FROM ${dedupeSource} ${where}
      ) WHERE _rn = 1 ORDER BY ${orderClause} LIMIT ${limitNum} OFFSET ${offset}
    `).all(params);
  }
  enrichPageTldCounts(domains, { skipZoneLookup: isVirtualExpiring });
  if (goDaddyLiveRequest) overlayGoDaddyInventoryRows(domains);

  const result = {
    total,
    page: pageNum,
    limit: limitNum,
    domains,
    godaddyInventory: goDaddyLiveRequest ? goDaddyInventoryMeta() : null,
  };
  if (!goDaddyLiveRequest) setCached(cacheKey, result);
  res.json(result);
});

// ── AgentForge app-owned APIs ────────────────────────────────────────────────
app.get('/api/agentforge/streams', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        stream,
        COUNT(*) AS total,
        MIN(auction_price) AS minPrice,
        AVG(auction_price) AS avgPrice,
        MIN(COALESCE(auction_end, expiry_date, drop_date)) AS firstDate,
        MAX(COALESCE(auction_end, expiry_date, drop_date)) AS lastDate
      FROM domains
      WHERE ${activeAuctionWhere()}
      GROUP BY stream
      ORDER BY total DESC
    `).all();
    res.json({
      source: 'DomainScout stream inventory',
      generatedAt: new Date().toISOString(),
      streams: rows.map(row => {
        const scrapeInfo = latestScrapeForStream(row.stream);
        const closeout = isGoDaddyCloseoutStream(row.stream);
        return {
          stream: row.stream,
          category: agentStreamLabel(row.stream),
          total: row.total,
          minPrice: row.minPrice,
          avgPrice: row.avgPrice ? Number(row.avgPrice.toFixed(2)) : null,
          firstDate: row.firstDate,
          lastDate: row.lastDate,
          dateFieldMeaning: closeout
            ? closeoutInventoryMetadata().dateFieldMeaning
            : 'listing date range from auctionEnd, expiryDate, or dropDate',
          inventory: scrapeInfo ? {
            ...(closeout ? closeoutInventoryMetadata() : { status: 'current active listing dataset' }),
            latestScrapeAt: scrapeInfo.ran_at,
            domainsFoundInLatestScrape: scrapeInfo.domains_found,
            domainsNewInLatestScrape: scrapeInfo.domains_new,
            error: scrapeInfo.error || null,
          } : (closeout ? closeoutInventoryMetadata() : null),
          queryUrl: `/api/agentforge/domain-candidates?stream=${encodeURIComponent(row.stream)}&limit=100000`,
        };
      }),
      aliases: Object.fromEntries(AGENTFORGE_STREAM_ALIASES),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agentforge/domain-candidates', (req, res) => {
  try {
    res.json(buildAgentDomainCandidatesResponse(req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compatibility endpoints for existing AgentForge prompts/runs.
app.get('/api/agentforge/domain-picks', (req, res) => {
  try {
    res.json(buildAgentDomainCandidatesResponse(req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agentforge/godaddy-auction-picks', (req, res) => {
  try {
    res.json(buildAgentDomainCandidatesResponse(
      { query: { ...req.query, stream: 'godaddy-auction' } },
      { stream: 'godaddy-auction' }
    ));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stats ──────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const cached = getPersistentCache('stats');
  if (cached) {
    const statsAgeMs = persistentCacheAgeMs(cached.updatedAt);
    const stale = statsAgeMs > STATS_CACHE_TTL;
    if (stale && STATS_REFRESH_ENABLED) refreshStatsCache({ force: true });
    // Saved is a curated watchlist the user toggles interactively, and it's a cheap
    // indexed COUNT — serve it fresh so the badge never lags behind the cached
    // snapshot (which froze at 0 while names were saved, esp. with refresh disabled).
    let savedNow = cached.value?.saved;
    try { savedNow = db.prepare('SELECT COUNT(*) AS n FROM domains WHERE saved = 1').get().n; } catch { /* keep cached */ }
    return res.json({
      ...cached.value,
      saved: savedNow,
      cached: true,
      stale,
      statsUpdatedAt: cached.updatedAt,
    });
  }

  try {
    const stats = buildStats();
    setPersistentCache('stats', stats);
    res.json({ ...stats, cached: false, stale: false, statsUpdatedAt: new Date().toISOString() });
  } catch (err) {
    if (STATS_REFRESH_ENABLED) refreshStatsCache({ force: true });
    res.json({ ...emptyStatsSnapshot(), cached: false, stale: true, error: err.message });
  }
});

// ── PATCH /api/domains/:id ──────────────────────────────────────────────────
app.patch('/api/domains/:id', (req, res) => {
  const { seen, saved, skipped, notes } = req.body;
  const updates = [];
  const params = { id: req.params.id };

  if (seen !== undefined) { updates.push('seen = @seen'); params.seen = seen ? 1 : 0; }
  if (saved !== undefined) { updates.push('saved = @saved'); params.saved = saved ? 1 : 0; }
  if (skipped !== undefined) { updates.push('skipped = @skipped'); params.skipped = skipped ? 1 : 0; }
  if (notes !== undefined) { updates.push('notes = @notes'); params.notes = notes; }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  db.prepare(`UPDATE domains SET ${updates.join(', ')} WHERE id = @id`).run(params);
  res.json({ ok: true });
});

// ── DELETE /api/domains/:id ─────────────────────────────────────────────────
app.delete('/api/domains/:id', (req, res) => {
  db.prepare('DELETE FROM domains WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── POST /api/scrape ────────────────────────────────────────────────────────
app.post('/api/scrape', (req, res) => {
  const result = startScrapeWorker('manual', { includeCZDS: false });
  res.json({
    ...result,
    message: result.ok ? 'Scrape started in background' : result.message,
  });
});

function parseScopedTlds(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(
    raw
      .map(tld => String(tld || '').trim().toLowerCase())
      .filter(Boolean)
      .map(tld => tld.startsWith('.') ? tld : `.${tld}`)
  )];
}

function scopedCooldowns(cooldowns, tlds) {
  const scoped = parseScopedTlds(tlds);
  if (!scoped.length) return cooldowns || {};
  return Object.fromEntries(
    scoped
      .filter(tld => cooldowns?.[tld])
      .map(tld => [tld, cooldowns[tld]])
  );
}

// ── POST /api/expired-availability-refresh ─────────────────────────────────
// Confirms due dropped/expired domains as registerable via RDAP + DNS.
app.post('/api/expired-availability-refresh', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const options = {};
  if (body.tlds || body.tld) {
    options.tlds = body.tlds || body.tld;
  }
  if (body.limit) {
    const limit = parseInt(body.limit, 10);
    if (Number.isFinite(limit) && limit > 0) options.limit = Math.min(5000, limit);
  }
  const scopedTlds = parseScopedTlds(options.tlds);
  const registrarAvailability = getRegistrarAvailabilityConfig();
  if (!registrarAvailability.configured && scopedTlds.length) {
    const registrarRequired = new Set(
      (registrarAvailability.registrarRequiredAvailableTlds || [])
        .map(tld => String(tld || '').toLowerCase())
    );
    const blockedTlds = scopedTlds.filter(tld => registrarRequired.has(tld));
    if (blockedTlds.length) {
      return res.status(409).json({
        ok: false,
        error: `Registrar credentials required before refreshing ${blockedTlds.join(', ')}`,
        blockedTlds,
        missingOrBlankEnv: registrarAvailability.missingOrBlankEnv || [],
      });
    }
  }

  let duePreview = null;
  if (!readActiveExpiredAvailabilityLock() && !readActiveScrapeLock()) {
    try {
      const allCooldowns = getAvailabilityCooldowns();
      const cooldowns = scopedCooldowns(allCooldowns, scopedTlds);
      const previewRows = selectAvailabilityCandidates(options);
      const previewLimit = options.limit || null;
      duePreview = {
        limit: previewLimit,
        count: previewRows.length,
        saturated: previewLimit != null ? previewRows.length >= previewLimit : false,
        cooldowns,
        ...summarizeCandidateRows(previewRows),
      };
      if (previewRows.length === 0) {
        const pausedScopedTlds = scopedTlds.length
          ? scopedTlds.filter(tld => cooldowns[tld])
          : Object.keys(cooldowns);
        const pausedUntil = pausedScopedTlds
          .map(tld => cooldowns[tld]?.until)
          .filter(Boolean)
          .sort()[0] || null;
        return res.json({
          ok: true,
          started: false,
          noop: true,
          scopedTlds,
          limit: options.limit || null,
          duePreview,
          message: pausedScopedTlds.length
            ? `Expired availability refresh is paused for ${pausedScopedTlds.join(', ')} by registry cooldown${pausedUntil ? ` until ${pausedUntil}` : ''}`
            : scopedTlds.length
            ? `No due expired availability candidates for ${scopedTlds.join(', ')}`
            : 'No due expired availability candidates',
        });
      }
    } catch (err) {
      duePreview = {
        error: err.message || String(err),
      };
    }
  }

  const reason = scopedTlds.length
    ? `manual-${scopedTlds.join(',')}`
    : 'manual';
  const result = startExpiredAvailabilityWorker(reason, options);
  res.json({
    ...result,
    scopedTlds,
    limit: options.limit || null,
    duePreview,
    message: result.ok
      ? 'Expired availability refresh started in background'
      : result.message,
  });
});

app.get('/api/expired-availability-refresh', (_req, res) => {
  res.json({
    running: !!readActiveExpiredAvailabilityLock(),
    active: readActiveExpiredAvailabilityLock(),
  });
});

app.get('/api/expired-availability-backlog', (req, res) => {
  const force = req.query.force === '1';
  const scopedTlds = parseScopedTlds(req.query.tlds || req.query.tld);
  if (scopedTlds.length) {
    const started = Date.now();
    try {
      const estimate = {
        ...estimateAvailabilityBacklog({ tlds: scopedTlds }),
        computedAt: new Date().toISOString(),
      };
      return res.json({
        ...estimate,
        cached: false,
        scopedTlds,
        ageMs: 0,
        maxAgeMs: 0,
        elapsedMs: Date.now() - started,
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message || String(err),
        cached: false,
        scopedTlds,
      });
    }
  }
  const maxAgeMs = getExpiredBacklogCacheMaxAgeMs(req.query.maxAgeMs);
  const signature = getAvailabilityBacklogSignature();
  const cached = getPersistentCache('expired-availability-backlog');
  const cachedAgeMs = cached ? persistentCacheAgeMs(cached.updatedAt) : Infinity;
  if (
    !force &&
    cached &&
    isExpiredBacklogCacheShapeCurrent(cached.value) &&
    cached.value?.signature === signature &&
    cachedAgeMs <= maxAgeMs
  ) {
    return res.json({
      ...withFreshAvailabilityCooldowns(cached.value),
      cached: true,
      cachedAt: cached.updatedAt,
      ageMs: cachedAgeMs,
      maxAgeMs,
    });
  }

  const started = Date.now();
  try {
    const estimate = {
      ...estimateAvailabilityBacklog(),
      computedAt: new Date().toISOString(),
    };
    setPersistentCache('expired-availability-backlog', estimate);
    expiredAvailabilityStatusCache = null;
    res.json({
      ...estimate,
      cached: false,
      ageMs: 0,
      maxAgeMs,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || String(err),
      cached: false,
    });
  }
});

app.get('/api/expired-dogfood', (_req, res) => {
  res.json(getExpiredDogfoodStatus());
});

app.post('/api/expired-dogfood', (_req, res) => {
  const result = startExpiredDogfood('manual');
  if (!result.ok) {
    return res.status(result.running ? 409 : 503).json({
      ...result,
      status: getExpiredDogfoodStatus(),
      message: result.disabled
        ? 'Expired dogfood is disabled'
        : 'Expired dogfood is already running',
    });
  }
  res.json({
    ...result,
    status: getExpiredDogfoodStatus(),
    message: 'Expired dogfood started in background',
  });
});

// ── POST /api/godaddy-refresh ───────────────────────────────────────────────
// Lightweight live refresh for GoDaddy price/bid/end fields only.
app.post('/api/godaddy-refresh', (req, res) => {
  const result = startGoDaddyRefreshWorker('manual-live-refresh', { force: true });
  res.json({
    ...result,
    message: result.started ? 'GoDaddy live inventory refresh started' : 'GoDaddy live inventory already fresh',
  });
});

app.get('/api/godaddy-refresh', (_req, res) => {
  res.json({
    running: !!readActiveGoDaddyRefreshLock(),
    refreshMaxAgeMs: GODADDY_REFRESH_MAX_AGE_MS,
    inventory: goDaddyInventoryMeta(),
  });
});

app.get('/api/tld-accuracy-status', (_req, res) => {
  const universe = getSupportedTldUniverse();
  const scopeWhere = `
    d.base_name IS NOT NULL
    AND d.base_name != ''
    AND d.stream IN ('godaddy-auction', 'godaddy-closeout', 'namecheap-auction')
    AND (
      d.stream NOT IN ('godaddy-auction', 'namecheap-auction')
      OR d.auction_end IS NULL
      OR datetime(d.auction_end) > datetime('now')
    )
  `;
  const total = db.prepare(`
    SELECT COUNT(*) AS n
    FROM (SELECT d.base_name FROM domains d WHERE ${scopeWhere} GROUP BY d.base_name)
  `).get().n;
  const verified = db.prepare(`
    SELECT COUNT(*) AS n
    FROM (
      SELECT d.base_name
      FROM domains d
      JOIN tld_check_cache tc
        ON tc.base_name = d.base_name
       AND tc.all_count = @allCount
       AND tc.source = @source
      WHERE ${scopeWhere}
      GROUP BY d.base_name
    )
  `).get({ allCount: universe.count, source: universe.source }).n;
  res.json({
    running: !!readActiveTldAccuracyLock(),
    allCount: universe.count,
    universe,
    scope: 'auction',
    total,
    verified,
    remaining: Math.max(0, total - verified),
    lock: readActiveTldAccuracyLock(),
  });
});

// ── GET /api/scrape-log ─────────────────────────────────────────────────────
app.get('/api/scrape-log', (req, res) => {
  const rows = db.prepare('SELECT * FROM scrape_log ORDER BY ran_at DESC LIMIT 50').all();
  res.json(rows);
});

// ── GET /api/tlds-check?baseName=botfuel ────────────────────────────────────
// On-demand TLD coverage check — runs DNS NS lookups across all ~160 TLDs,
// returns which are taken, updates tlds_taken in the DB for this base name.
app.get('/api/tlds-check', async (req, res) => {
  const raw = normalizeBaseNameInput(req.query.baseName || req.query.domain || '');
  if (!raw || !/^[a-z0-9-]+$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid baseName' });
  }
  try {
    res.json(await runHybridTldCheck(raw, { force: !!req.query.force }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sedo keyword search ──────────────────────────────────────────────────────
// Searches Sedo's marketplace for domains containing a keyword.
// Returns an array of { base_name, com: {price, url}|null, ai: {price, url}|null }
async function searchSedoKeyword(keyword, mode = 'prefix') {
  const partnerId = process.env.SEDO_PARTNER_ID;
  const signKey   = process.env.SEDO_SIGN_KEY;
  if (!partnerId || !signKey) return { results: [], configured: false };

  const axios = require('axios');
  const cheerio = require('cheerio');
  const allResults = {};   // base_name → { com, ai }

  // Search .com and .ai (the two TLDs we care about for this tool)
  const extensions = ['.com', '.ai', '.io', '.net', '.org', '.app', '.dev'];

  for (const ext of extensions) {
    let offset = 0;
    const loadsize = 200;

    // One page per TLD (Sedo can be slow — keep it targeted)
    const soap = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://sedo.com/namespaces/">
  <SOAP-ENV:Header>
    <ns1:Security>
      <ns1:UserAuth>
        <ns1:partnerid>${partnerId}</ns1:partnerid>
        <ns1:signkey>${signKey}</ns1:signkey>
      </ns1:UserAuth>
    </ns1:Security>
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <ns1:DomainSearch>
      <ns1:keyword>${keyword}</ns1:keyword>
      <ns1:minimum_price>0</ns1:minimum_price>
      <ns1:maximum_price>10000000</ns1:maximum_price>
      <ns1:available_extensions>${ext}</ns1:available_extensions>
      <ns1:language>us</ns1:language>
      <ns1:sortby>domainalph</ns1:sortby>
      <ns1:offset>${offset}</ns1:offset>
      <ns1:loadsize>${loadsize}</ns1:loadsize>
    </ns1:DomainSearch>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

    try {
      const resp = await axios.post('https://api.sedo.com/api/v1/', soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': 'DomainSearch' },
        timeout: 20000,
      });
      const $ = cheerio.load(resp.data, { xmlMode: true });
      $('domain').each((_, el) => {
        const domainText = $(el).find('domainname').text().toLowerCase().trim();
        if (!domainText) return;
        const dotIdx = domainText.lastIndexOf('.');
        if (dotIdx < 0) return;
        const baseName = domainText.slice(0, dotIdx);
        const tld = domainText.slice(dotIdx);
        const cleanKeyword = keyword.toLowerCase();
        const matches = mode === 'suffix'
          ? baseName.endsWith(cleanKeyword)
          : mode === 'contains'
            ? baseName.includes(cleanKeyword)
            : baseName.startsWith(cleanKeyword);
        if (!matches) return;
        if (!allResults[baseName]) allResults[baseName] = { com: null, ai: null };
        const price = parseFloat($(el).find('price').text()) || null;
        const url = $(el).find('domainlink').text().trim() || `https://sedo.com/search/details/?domain=${domainText}`;
        const info = { exists: true, price, url, stream: 'marketplace', source: 'Sedo' };
        if (tld === '.com') allResults[baseName].com = info;
        else if (tld === '.ai') allResults[baseName].ai = info;
      });
    } catch (_) { /* skip failed TLD */ }

    await new Promise(r => setTimeout(r, 400));
  }

  return { results: allResults, configured: true };
}

function parseResearchTerms(raw) {
  return [...new Set(
    String(raw || '')
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2 && t !== 'or' && t !== 'and')
  )].slice(0, 6);
}

function nextPrefix(s) {
  if (!s) return '\uffff';
  const chars = s.split('');
  chars[chars.length - 1] = String.fromCharCode(chars[chars.length - 1].charCodeAt(0) + 1);
  return chars.join('');
}

function getCachedTldCheck(baseName) {
  const row = db.prepare(`
    SELECT base_name, count, taken_json, all_count, source, checked_at
    FROM tld_check_cache
    WHERE base_name = ?
  `).get(baseName);
  if (!row) return null;
  let taken = [];
  try { taken = JSON.parse(row.taken_json) || []; } catch (_) {}
  return {
    baseName: row.base_name,
    count: row.count,
    taken,
    allCount: row.all_count,
    source: row.source || 'cache',
    checkedAt: row.checked_at,
  };
}

const upsertTldCheckCache = db.prepare(`
  INSERT INTO tld_check_cache (base_name, count, taken_json, all_count, source, checked_at)
  VALUES (@baseName, @count, @takenJson, @allCount, @source, datetime('now'))
  ON CONFLICT(base_name) DO UPDATE SET
    count = excluded.count,
    taken_json = excluded.taken_json,
    all_count = excluded.all_count,
    source = excluded.source,
    checked_at = excluded.checked_at
`);

const upsertBaseTldCount = db.prepare(`
  INSERT INTO base_tld_counts (base_name, tld_count, source, updated_at)
  VALUES (@baseName, @count, @source, datetime('now'))
  ON CONFLICT(base_name) DO UPDATE SET
    tld_count = excluded.tld_count,
    source = excluded.source,
    updated_at = excluded.updated_at
`);

function storeTldCheck(baseName, taken, allCount, source) {
  const cleanTaken = [...new Set(taken || [])].sort();
  upsertTldCheckCache.run({
    baseName,
    count: cleanTaken.length,
    takenJson: JSON.stringify(cleanTaken),
    allCount,
    source,
  });
  upsertBaseTldCount.run({
    baseName,
    count: cleanTaken.length,
    source: source || 'hybrid-cache',
  });
  db.prepare(`UPDATE domains SET tlds_taken = ?, tlds_checked_at = datetime('now')
              WHERE base_name = ?`).run(cleanTaken.length, baseName);
  return cleanTaken;
}

const researchHydrationQueue = new Set();
function queueResearchHydration(baseName) {
  const cleanBase = normalizeBaseNameInput(baseName);
  if (!cleanBase || researchHydrationQueue.has(cleanBase)) return false;
  researchHydrationQueue.add(cleanBase);
  setImmediate(async () => {
    try {
      await runHybridTldCheck(cleanBase);
    } catch (err) {
      console.warn(`[Research] background hydration failed for ${cleanBase}:`, err.message);
    } finally {
      researchHydrationQueue.delete(cleanBase);
    }
  });
  return true;
}

async function runHybridTldCheck(baseName, { force = false } = {}) {
  const cleanBase = normalizeBaseNameInput(baseName);
  if (!cleanBase) throw new Error('baseName required');

  const universe = getSupportedTldUniverse();
  const allTlds = universe.tlds;
  const universeSet = new Set(allTlds);
  const zoneTlds = getNameTlds(cleanBase).filter(tld => universeSet.has(tld));
  const cached = force ? null : getCachedTldCheck(cleanBase);
  if (cached && cached.allCount === universe.count && cached.source === universe.source) {
    const taken = [...new Set([...zoneTlds, ...cached.taken])].sort();
    if (taken.length !== cached.taken.length) {
      storeTldCheck(cleanBase, taken, universe.count, universe.source);
    }
    return {
      baseName: cleanBase,
      zone: zoneTlds,
      live: taken.filter(tld => !zoneTlds.includes(tld)),
      taken,
      count: taken.length,
      gapChecked: 0,
      zoneCoversAll: true,
      all: allTlds,
      allCount: universe.count,
      cached: true,
      checkedAt: cached.checkedAt,
      tldUniverse: universe,
    };
  }

  const gapTlds = universe.dnsTlds;
  if (gapTlds.length === 0) {
    const checkedAt = new Date().toISOString();
    const taken = storeTldCheck(cleanBase, zoneTlds, universe.count, universe.source);
    return {
      baseName: cleanBase,
      zone: zoneTlds,
      live: [],
      taken,
      count: taken.length,
      gapChecked: 0,
      zoneCoversAll: true,
      all: allTlds,
      allCount: universe.count,
      cached: false,
      checkedAt,
      tldUniverse: universe,
    };
  }

  const dns = require('dns').promises;
  const resolveNs = async (domain, timeoutMs = 1800) => {
    try {
      await Promise.race([
        dns.resolveNs(domain),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), timeoutMs)),
      ]);
      return true;
    } catch (_) {
      return false;
    }
  };

  const results = [];
  const CONCURRENCY = 120;
  for (let i = 0; i < gapTlds.length; i += CONCURRENCY) {
    const batch = gapTlds.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async tld =>
      (await resolveNs(cleanBase + tld)) ? tld : null
    ));
    results.push(...batchResults);
  }

  const live = results.filter(Boolean).sort();
  const checkedAt = new Date().toISOString();
  const taken = storeTldCheck(cleanBase, [...zoneTlds, ...live], universe.count, universe.source);
  bustCache();

  return {
    baseName: cleanBase,
    zone: zoneTlds,
    live,
    taken,
    count: taken.length,
    gapChecked: gapTlds.length,
    zoneCoversAll: false,
    all: allTlds,
    allCount: universe.count,
    cached: false,
    checkedAt,
    tldUniverse: universe,
  };
}

// ── GET /api/name-research ──────────────────────────────────────────────────
// Returns unique base names matching a prefix, sorted by tlds_taken DESC NULLS LAST.
// Sources: zone index (pre-built from CZDS files) + internal DB + Sedo (if configured).
app.get('/api/name-research', async (req, res) => {
  try {
  const prefix = req.query.prefix ?? req.query.term ?? '';
  const rawMode = String(req.query.mode || 'prefix').toLowerCase();
  const modeAliases = {
    start: 'prefix',
    starts: 'prefix',
    startswith: 'prefix',
    prefix: 'prefix',
    contains: 'contains',
    contain: 'contains',
    suffix: 'suffix',
    ends: 'suffix',
    endswith: 'suffix',
  };
  const searchMode = modeAliases[rawMode] || 'prefix';
  const includeMarket = ['1', 'true', 'yes'].includes(String(req.query.market || req.query.includeMarket || req.query.sedo || '').toLowerCase());
  const includeTldLists = ['1', 'true', 'yes'].includes(String(req.query.tldLists || req.query.includeTldLists || '').toLowerCase());
  const terms = parseResearchTerms(prefix);
  if (!terms.length) {
    return res.status(400).json({ error: 'enter at least one term with 2+ characters' });
  }
  const resultLimit = parseBoundedPositiveInt(
    req.query.resultLimit || req.query.limit,
    1000,
    50,
    5000,
  );

  // ── Marketplace search is intentionally opt-in ────────────────────────────
  // The research view's critical path is the local zone/cache index. Sedo is
  // network-bound and can add seconds to every query, so only run it when the
  // caller explicitly asks for marketplace enrichment.
  const sedoPromise = includeMarket
    ? Promise.all(terms.map(term => searchSedoKeyword(term, searchMode)))
    : Promise.resolve([]);

  // ── Zone index query — full universe ──
  const zoneRows = [];
  for (const term of terms) {
    zoneRows.push(...queryZoneIndex(term, searchMode, {
      includeTldList: includeTldLists,
      limit: resultLimit,
    }));
  }

  // Build resultMap from zone index first (most comprehensive tld_count source)
  const resultMap = {};
  for (const row of zoneRows) {
    const tldList = row.tld_list ? row.tld_list.split(',').sort() : undefined;
    resultMap[row.base_name] = {
      base_name:  row.base_name,
      tlds_taken: row.tld_count,
      tld_list:   tldList,
      com: null,
      ai:  null,
    };
  }

  const mergeTldCoverage = (baseName, tldCount, tldList = []) => {
    const incoming = [...new Set(tldList || [])].sort();
    if (!resultMap[baseName]) {
      resultMap[baseName] = {
        base_name: baseName,
        tlds_taken: incoming.length || tldCount || null,
        tld_list: incoming,
        com: null,
        ai: null,
      };
      return;
    }
    const existing = resultMap[baseName].tld_list || [];
    const merged = [...new Set([...existing, ...incoming])].sort();
    if (merged.length) resultMap[baseName].tld_list = merged;
    resultMap[baseName].tlds_taken = Math.max(
      resultMap[baseName].tlds_taken || 0,
      tldCount || 0,
      merged.length || 0,
    );
  };

  // ── Internal DB: all base names matching prefix ──
  // Adds names not yet in zone index (expiring/auction domains), and enriches
  // tlds_taken where the DNS-checked value exceeds the zone index count.
  const dbWhere = terms.map((_, i) => searchMode === 'prefix'
    ? `(base_name >= @term${i}Lo AND base_name < @term${i}Hi)`
    : `base_name LIKE @term${i}`
  ).join(' OR ');
  const dbParams = {};
  terms.forEach((term, i) => {
    if (searchMode === 'prefix') {
      dbParams[`term${i}Lo`] = term;
      dbParams[`term${i}Hi`] = nextPrefix(term);
    } else if (searchMode === 'suffix') {
      dbParams[`term${i}`] = `%${term}`;
    } else {
      dbParams[`term${i}`] = `%${term}%`;
    }
  });
  const dbNames = db.prepare(`
    SELECT
      base_name,
      MAX(tlds_taken) as tlds_taken,
      COUNT(*) as domain_count
    FROM domains
    WHERE base_name IS NOT NULL
      AND base_name != ''
      AND (${dbWhere})
    GROUP BY base_name
    ORDER BY tlds_taken DESC NULLS LAST, domain_count DESC
    LIMIT @resultLimit
  `).all({ ...dbParams, resultLimit });

  // Track which names came from the internal DB (always shown regardless of tld_count)
  const dbNameSet = new Set();
  for (const n of dbNames) {
    dbNameSet.add(n.base_name);
    if (!resultMap[n.base_name]) {
      resultMap[n.base_name] = { base_name: n.base_name, tlds_taken: n.tlds_taken, com: null, ai: null };
    } else if (n.tlds_taken != null &&
               (resultMap[n.base_name].tlds_taken == null || n.tlds_taken > resultMap[n.base_name].tlds_taken)) {
      resultMap[n.base_name].tlds_taken = n.tlds_taken;
    }
  }

  // ── Cached exact TLD checks ───────────────────────────────────────────────
  // This is the ExpiredDomains-style fast path: research should sort from a
  // persisted index/cache, not live-check every row in the browser.
  const cacheWhere = terms.map((_, i) => searchMode === 'prefix'
    ? `(base_name >= @term${i}Lo AND base_name < @term${i}Hi)`
    : `base_name LIKE @term${i}`
  ).join(' OR ');
  const cacheNameSet = new Set();
  const universe = getSupportedTldUniverse();
  const cachedRows = db.prepare(`
    SELECT base_name, count, taken_json, all_count, checked_at
    FROM tld_check_cache
    WHERE ${cacheWhere}
      AND all_count = @universeCount
      AND source = @universeSource
    ORDER BY count DESC, base_name ASC
    LIMIT @resultLimit
  `).all({ ...dbParams, universeCount: universe.count, universeSource: universe.source, resultLimit });
  for (const row of cachedRows) {
    cacheNameSet.add(row.base_name);
    let tldList = [];
    try { tldList = JSON.parse(row.taken_json) || []; } catch (_) {}
    const shouldIncludeTldList = includeTldLists || terms.includes(row.base_name);
    if (!resultMap[row.base_name]) {
      resultMap[row.base_name] = {
        base_name: row.base_name,
        tlds_taken: row.count,
        tld_list: shouldIncludeTldList ? tldList : undefined,
        com: null,
        ai: null,
      };
    } else {
      resultMap[row.base_name].tlds_taken = row.count;
      if (shouldIncludeTldList) resultMap[row.base_name].tld_list = tldList;
      resultMap[row.base_name].tlds_checked_at = row.checked_at;
    }
  }

  // Keep single-TLD names. Research is a universe view; ranking/filtering can
  // happen in the UI, but the API should not hide real registered names.

  // Exact terms should be definitive immediately. Prefix/contains searches can
  // render from the zone index first, but if the user searches "agenttools",
  // returning only the partial zone count is misleading while CZDS is still
  // building. Hydrate exact matches through the hybrid zone+DNS gap checker.
  const exactHydrated = [];
  const exactQueued = [];
  for (const baseName of terms.filter(t => resultMap[t]).slice(0, 3)) {
    const cached = getCachedTldCheck(baseName);
    const needsHydration = !cached || cached.allCount !== universe.count || cached.source !== universe.source;
    if (!needsHydration) continue;
    if (queueResearchHydration(baseName)) exactQueued.push(baseName);
  }

  // ── .com / .ai enrichment — single prefix query per TLD (fast: uses tld index) ──
  // All names in resultMap share the same prefix, so one LIKE query covers everything.
  const domainWhere = terms.map((_, i) => searchMode === 'prefix'
    ? `(base_name >= ? AND base_name < ?)`
    : `base_name LIKE ?`
  ).join(' OR ');
  const domainPatterns = terms.flatMap(term => {
    if (searchMode === 'prefix') return [term, nextPrefix(term)];
    if (searchMode === 'suffix') return [`%${term}`];
    return [`%${term}%`];
  });
  for (const row of db.prepare(`
    SELECT base_name,
           domain, auction_price, auction_url, stream, source
    FROM domains WHERE tld='.com' AND (${domainWhere})
  `).all(...domainPatterns)) {
    const e = resultMap[row.base_name];
    if (e && (!e.com || (row.auction_price && !e.com.price)))
      e.com = { exists: true, price: row.auction_price, url: row.auction_url, stream: row.stream, source: row.source };
  }
  for (const row of db.prepare(`
    SELECT base_name,
           domain, auction_price, auction_url, stream, source
    FROM domains WHERE tld='.ai' AND (${domainWhere})
  `).all(...domainPatterns)) {
    const e = resultMap[row.base_name];
    if (e && (!e.ai || (row.auction_price && !e.ai.price)))
      e.ai = { exists: true, price: row.auction_price, url: row.auction_url, stream: row.stream, source: row.source };
  }

  // ── Merge Sedo results ──
  const sedoResponses = await sedoPromise;
  const sedoConfigured = sedoResponses.some(r => r.configured);
  const sedoResults = {};
  for (const response of sedoResponses) {
    for (const [baseName, info] of Object.entries(response.results || {})) {
      if (!sedoResults[baseName]) sedoResults[baseName] = { com: null, ai: null };
      if (info.com && (!sedoResults[baseName].com || (!sedoResults[baseName].com.price && info.com.price))) {
        sedoResults[baseName].com = info.com;
      }
      if (info.ai && (!sedoResults[baseName].ai || (!sedoResults[baseName].ai.price && info.ai.price))) {
        sedoResults[baseName].ai = info.ai;
      }
    }
  }
  for (const [baseName, info] of Object.entries(sedoResults)) {
    if (!resultMap[baseName]) {
      resultMap[baseName] = { base_name: baseName, tlds_taken: null, com: null, ai: null };
    }
    const e = resultMap[baseName];
    if (info.com && (!e.com || (!e.com.price && info.com.price))) e.com = info.com;
    if (info.ai  && (!e.ai  || (!e.ai.price  && info.ai.price)))  e.ai  = info.ai;
  }

  // Sort: tlds_taken DESC NULLS LAST, then alphabetically
  const sortedAll = Object.values(resultMap).sort((a, b) => {
    if (a.tlds_taken != null && b.tlds_taken != null) return b.tlds_taken - a.tlds_taken;
    if (a.tlds_taken != null) return -1;
    if (b.tlds_taken != null) return 1;
    return a.base_name.localeCompare(b.base_name);
  });
  const sorted = sortedAll.slice(0, resultLimit);

  // Feed-based sale info is instant + authoritative (DomainScout's own aftermarket
  // streams). Do NOT block the response on slow HTTP lander checks here — the client
  // runs those progressively in the background per visible page so the table is
  // usable immediately and slow marketplace landers still get caught.
  enrichResearchSaleInfo(sorted, { limit: sorted.length });

  const zoneStats = getZoneIndexStats();
  res.json({
    names: sorted,
    total: sorted.length,
    available: sortedAll.length,
    limited: sortedAll.length > sorted.length || zoneRows.length >= resultLimit,
    resultLimit,
    sedoConfigured,
    sedoCount:       Object.keys(sedoResults).length,
    zoneIndexedTlds: zoneStats.tlds,
    zoneIndexedNames: zoneStats.names,
    zoneAuthoritative: zoneStats.tlds > 0 && zoneStats.names > 0,
    summaryNames: zoneStats.summaryNames,
    summaryHits: zoneStats.summaryHits,
    zoneResultCount: zoneRows.length,
    exactHydrated,
    exactQueued,
    saleChecked: sorted.length,
    terms,
    tldUniverse: universe,
  });
  } catch (err) {
    console.error('[Research] handler error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

app.post('/api/research-sale-info', express.json(), async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.baseNames) ? req.body.baseNames : [];
    const baseNames = [...new Set(raw
      .map(v => String(v || '').toLowerCase().trim())
      .map(v => v.replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean)
    )].slice(0, 200);
    const names = baseNames.map(baseName => ({ base_name: baseName, com: null, ai: null }));
    await hydrateResearchSaleInfo(names, { limit: names.length, timeoutMs: 9000, concurrency: 40 });
    res.json({
      names,
      count: names.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/zone-tlds ──────────────────────────────────────────────────────
// Returns all TLDs a base name is registered in (from zone index).
app.get('/api/zone-tlds', (req, res) => {
  const baseName = normalizeBaseNameInput(req.query.baseName || req.query.domain || '');
  if (!baseName) return res.status(400).json({ error: 'baseName required' });
  const tlds = getNameTlds(baseName);
  res.json({ baseName, tlds });
});

// ── GET /api/tlds-check-hybrid ───────────────────────────────────────────────
// Live DNS check for consequential TLDs not yet covered by the zone index.
// Indexed zones are authoritative and instant; DNS is only the gap filler.
app.get('/api/tlds-check-hybrid', async (req, res) => {
  const baseName = normalizeBaseNameInput(req.query.baseName || req.query.domain || '');
  if (!baseName) return res.status(400).json({ error: 'baseName required' });
  try {
    res.json(await runHybridTldCheck(baseName, { force: !!req.query.force }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tlds-lookup-full ────────────────────────────────────────────────
// Exact one-name lookup across the full current IANA ASCII TLD universe.
// This intentionally bypasses the auction/research cache; Lookup should answer
// "what is this name taken in right now?", not "what did we score it as".
app.get('/api/tlds-lookup-full', async (req, res) => {
  const baseName = normalizeBaseNameInput(req.query.baseName || req.query.domain || '');
  if (!baseName) return res.status(400).json({ error: 'baseName required' });
  const started = Date.now();
  try {
    const zoneTlds = getNameTlds(baseName);
    const result = await checkTldsTakenFull(baseName, {
      concurrency: parseBoundedPositiveInt(req.query.concurrency, 120, 20, 250),
      timeoutMs: parseBoundedPositiveInt(req.query.timeoutMs, 3500, 1000, 8000),
    });
    const taken = [...new Set([...(result.taken || []), ...zoneTlds])].sort();
    const zoneSet = new Set(zoneTlds);
    res.json({
      baseName,
      taken,
      count: taken.length,
      zone: taken.filter(tld => zoneSet.has(tld)),
      live: taken.filter(tld => !zoneSet.has(tld)),
      all: result.all,
      allCount: result.all.length,
      cached: false,
      source: 'fresh-iana-dns',
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/bulk-availability ─────────────────────────────────────────────
// Batch check domain availability via GoDaddy API. Returns available + price
// for each domain in one call, so frontend can skip lander checks for unregistered names.
app.post('/api/bulk-availability', express.json(), async (req, res) => {
  const domains = req.body;
  if (!Array.isArray(domains) || !domains.length) return res.json({ domains: [] });
  const registrarConfig = getRegistrarAvailabilityConfig();
  const apiKey    = String(process.env.GODADDY_API_KEY || '').trim();
  const apiSecret = String(process.env.GODADDY_API_SECRET || '').trim();
  if (!registrarConfig.configured) {
    return res.status(503).json({
      error: 'GoDaddy API not configured',
      missingOrBlankEnv: registrarConfig.missingOrBlankEnv,
    });
  }

  // Sanitize — only valid-looking domain strings, max 500
  const clean = domains
    .filter(d => typeof d === 'string' && /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(d))
    .slice(0, 500);
  if (!clean.length) return res.json({ domains: [] });

  try {
    const axios = require('axios');
    const resp = await axios.post(
      'https://api.godaddy.com/v1/domains/available?checkType=FAST',
      clean,
      {
        headers: {
          Authorization: `sso-key ${apiKey}:${apiSecret}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data?.message || err.message });
  }
});

// ── GET /api/lander-check ───────────────────────────────────────────────────
// Check if a domain is listed for sale via HTTP lander detection.
// Checks internal DB first, then makes an HTTP request to detect landers.
const landerCache = new Map();
const LANDER_CACHE_TTL = 30 * 60 * 1000; // 30 min

const LANDER_PLATFORMS = [
  ['afternic', 'Afternic'],
  ['sedo.com', 'Sedo'],
  ['sedo.de', 'Sedo'],
  ['dan.com', 'Dan.com'],
  ['efty.com', 'Efty'],
  ['undeveloped.com', 'Undeveloped'],
  ['squadhelp', 'Squadhelp'],
  ['hugedomains', 'HugeDomains'],
  ['brandpa', 'Brandpa'],
  ['cashparking', 'GoDaddy Parking'],
  ['uniregistry', 'Uniregistry'],
  ['bolddomains', 'BoldDomains'],
  ['atom.com', 'Atom'],
  ['brandroot', 'Brandroot'],
  ['saw.com', 'Saw.com'],
  ['namerific', 'Namerific'],
  ['domainsbot', 'DomainsBOT'],
  ['epik.com', 'Epik'],
  ['namecheap.com/market', 'Namecheap Market'],
];

const FOR_SALE_PHRASES = [
  'for sale', 'buy this domain', 'purchase this domain',
  'make an offer', 'domain for sale', 'buy domain', 'acquire this domain',
  'buy now', 'buy this domain name', 'lease to own', 'own this domain',
  'this domain is available', 'domain is for sale', 'inquire about this domain',
];

async function checkLander(domain, options = {}) {
  const axios = require('axios');
  const timeoutMs = Number(options.timeoutMs || 7000);
  const maxRedirects = Number(options.maxRedirects ?? 5);
  const opts = {
    timeout: timeoutMs,
    maxRedirects,
    signal: options.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DomainResearch/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    responseType: 'text',
    // Real marketplace landers are often 50-150KB; a tight cap made axios throw
    // ERR_BAD_RESPONSE on them and report not-for-sale. We only analyze the first
    // 40KB (bodyLow below), but axios must accept the full response first.
    maxContentLength: 5_000_000,
    maxBodyLength: 5_000_000,
    validateStatus: () => true,
  };

  const tryCheck = async (url) => {
    const resp = await axios.get(url, opts);
    const body = typeof resp.data === 'string' ? resp.data : '';
    const bodyLow = body.toLowerCase().slice(0, 40000);
    const finalUrl = ((resp.request && resp.request.res && resp.request.res.responseUrl) || url).toLowerCase();

    // If the domain redirected to a completely different hostname, it's a marketplace lander
    const origHost = url.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').toLowerCase();
    const finalHost = finalUrl.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').toLowerCase();
    const wasRedirected = finalHost && origHost && finalHost !== origHost;

    let platform = null;
    for (const [kw, name] of LANDER_PLATFORMS) {
      if (finalUrl.includes(kw) || bodyLow.includes(kw)) { platform = name; break; }
    }
    // If redirected to an unrecognised marketplace, label it by the destination hostname
    if (!platform && wasRedirected) platform = finalHost.replace(/^www\./, '');

    const isForSale = !!platform || wasRedirected || FOR_SALE_PHRASES.some(p => bodyLow.includes(p));

    let price = null;
    if (isForSale) {
      // HugeDomains-specific: fetch their profile page directly for accurate price
      if (platform === 'HugeDomains' && finalUrl.includes('hugedomains')) {
        try {
          const hdResp = await axios.get(finalUrl, { ...opts, maxRedirects: 2 });
          const hdBody = typeof hdResp.data === 'string' ? hdResp.data : '';
          // Try JSON-in-HTML patterns first (e.g. data attributes, embedded JSON)
          const jsonPrice = hdBody.match(/"(?:price|listPrice|buyPrice|salePrice)"\s*:\s*(\d+)/i);
          if (jsonPrice) {
            const v = parseInt(jsonPrice[1]);
            if (v >= 100 && v <= 50000000) price = v;
          }
          // Fallback: dollar-amount regex on their page
          if (!price) {
            const matches = hdBody.match(/\$\s*([\d,]{3,})/g) || [];
            for (const m of matches) {
              const v = parseInt(m.replace(/[^\d]/g, ''));
              if (v >= 100 && v <= 50000000) { price = v; break; }
            }
          }
        } catch (_) {}
      }

      // Generic price extraction — tries multiple sources in order of reliability

      // 1. JSON-LD structured data (present in initial HTML even on React SPAs)
      if (!price) {
        const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let ldm;
        while ((ldm = ldRe.exec(body)) !== null && !price) {
          const pm = ldm[1].match(/"price"\s*:\s*"?([\d.]+)"?/i);
          if (pm) { const v = parseFloat(pm[1]); if (v >= 100 && v <= 50000000) price = Math.round(v); }
        }
      }

      // 2. JSON-embedded price in script tags / data blobs
      if (!price) {
        const jsonPrice = body.match(/"(?:price|listPrice|buyPrice|salePrice|buyNowPrice|askingPrice)"\s*:\s*"?([\d.]+)"?/i);
        if (jsonPrice) { const v = parseFloat(jsonPrice[1]); if (v >= 100 && v <= 50000000) price = Math.round(v); }
      }

      // 3. Meta tags — og:description / name="description" (SPAs put price here for SEO)
      if (!price) {
        const metaRe = /<meta[^>]+content=["']([^"']{0,400})["'][^>]*>/gi;
        let mm;
        while ((mm = metaRe.exec(body)) !== null && !price) {
          const pm = mm[1].match(/\$([\d,]+)/);
          if (pm) { const v = parseInt(pm[1].replace(/,/g, '')); if (v >= 100 && v <= 50000000) price = v; }
        }
      }

      // 4. Dollar-amount anywhere in the body
      if (!price) {
        const matches = body.match(/\$\s*([\d,]{3,})/g) || [];
        for (const m of matches) {
          const val = parseInt(m.replace(/[^\d]/g, ''));
          if (val >= 500 && val <= 50000000) { price = val; break; }
        }
      }
    }

    return { forSale: isForSale, price, platform, url: isForSale ? finalUrl : null };
  };

  // Try HTTP first, fall back to HTTPS
  try {
    return await tryCheck(`http://${domain}/`);
  } catch (err) {
    try {
      return await tryCheck(`https://${domain}/`);
    } catch (err2) {
      const msg = err2.code || err2.message || 'error';
      if (msg === 'ENOTFOUND') return { forSale: false, error: 'not resolving' };
      if (msg.includes('TIMEOUT') || msg === 'ETIMEDOUT') return { forSale: false, error: 'timeout' };
      return { forSale: false, error: msg.slice(0, 40) };
    }
  }
}

app.get('/api/lander-check', async (req, res) => {
  const { domain } = req.query;
  if (!domain || !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain' });
  }
  const d = domain.toLowerCase().trim();

  // Memory cache
  const cached = landerCache.get(d);
  if (cached && Date.now() - cached.ts < LANDER_CACHE_TTL) {
    return res.json(cached.data);
  }

  // Internal DB check first
  const dbRow = db.prepare(`
    SELECT domain, auction_price, auction_url, stream, source
    FROM domains WHERE domain = ? LIMIT 1
  `).get(d);

  if (dbRow && (dbRow.auction_price || dbRow.stream === 'marketplace' || dbRow.stream === 'godaddy-premium')) {
    const result = {
      domain: d, forSale: true, source: 'db',
      price: dbRow.auction_price, url: dbRow.auction_url,
      platform: dbRow.source || dbRow.stream,
    };
    landerCache.set(d, { data: result, ts: Date.now() });
    return res.json(result);
  }

  try {
    const result = await checkLander(d);
    result.domain = d;
    result.source = 'http';
    landerCache.set(d, { data: result, ts: Date.now() });
    res.json(result);
  } catch (err) {
    res.json({ domain: d, forSale: false, error: err.message });
  }
});

// ── GET /api/config-status ──────────────────────────────────────────────────
app.get('/api/config-status', (req, res) => {
  const zoneStats = getZoneIndexStats();
  const expiredAvailability = getExpiredAvailabilityStatus();
  const registrarAvailability = {
    ...getRegistrarAvailabilityConfig(),
    registrarBlockedBacklogTotal: expiredAvailability.dueEstimate?.blockedTotal ?? 0,
    registrarBlockedBacklogByTld: expiredAvailability.dueEstimate?.blockedByTld || {},
    registrarBlockedBacklogByBucket: expiredAvailability.dueEstimate?.blockedByBucket || {},
  };
  const expiredVisibility = getExpiredVisibilityStatus(90);
  const expiredCandidateSupply = getExpiredCandidateSupplyStatus();
  const expiredDogfood = getExpiredDogfoodStatus();
  res.json({
    czdsConfigured: !!(process.env.CZDS_USER && process.env.CZDS_PASS),
    czdsSyncRunning,
    czdsWorkerPid: czdsChild?.pid || null,
    prefixScanRunning,
    prefixScanPrefix,
    prefixScanPid: prefixScanChild?.pid || null,
    envFile: require('fs').existsSync(path.join(__dirname, '../.env')),
    registrarAvailability,
    expiredAvailability,
    expiredVisibility,
    expiredCandidateSupply,
    expiredDogfood,
    tldUniverse: getSupportedTldUniverse(),
    zoneIndex: zoneStats,
  });
});

let czdsSyncRunning = false;
let czdsChild = null;
let prefixScanRunning = false;
let prefixScanChild = null;
let prefixScanPrefix = null;
function startCzdsSync(reason = 'manual', options = {}) {
  if (czdsSyncRunning) {
    console.log(`[CZDS] ${reason} sync skipped - already running`);
    return false;
  }
  if (!process.env.CZDS_USER || !process.env.CZDS_PASS) {
    console.warn(`[CZDS] ${reason} sync skipped - CZDS_USER and CZDS_PASS are required`);
    return false;
  }
  czdsSyncRunning = true;
  const script = path.join(__dirname, 'czds-sync.js');
  const childArgs = [script, options.includeHeavy ? '--full' : '--fast'];
  if (options.maxTlds) childArgs.push(`--max-tlds=${options.maxTlds}`);
  if (options.maxZoneMb) childArgs.push(`--max-zone-mb=${options.maxZoneMb}`);
  if (options.tlds) childArgs.push(`--tlds=${options.tlds}`);

  let command = process.execPath;
  let args = childArgs;
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/nice')) {
    command = '/usr/bin/nice';
    args = ['-n', '10', process.execPath, ...childArgs];
  }

  console.log(`[CZDS] Starting ${reason} sync in worker process...`);
  czdsChild = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      CZDS_TARGET_TLDS: options.tlds || process.env.CZDS_TARGET_TLDS || '',
    },
    stdio: 'inherit',
  });
  czdsChild.on('exit', (code, signal) => {
    czdsSyncRunning = false;
    czdsChild = null;
    bustCache();
    invalidateStatsCache();
    const stats = getZoneIndexStats();
    setImmediate(() => syncBaseTldCounts({ force: true, reason: 'CZDS worker completion' }));
    setImmediate(() => runCzdsDropImportMaintenance('czds-completion'));
    console.log(`[CZDS] Worker finished (${signal || code}); ${stats.tlds} TLDs, ${stats.names.toLocaleString()} names indexed`);
  });
  czdsChild.on('error', (err) => {
    czdsSyncRunning = false;
    czdsChild = null;
    console.error('[CZDS] Worker failed to start:', err.message);
  });
  return true;
}

function importedDropTlds(summary) {
  return Object.entries(summary?.byTld || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .map(([tld]) => tld);
}

function runCzdsDropImportMaintenance(reason = 'scheduled', options = {}) {
  let importedDrops;
  try {
    importedDrops = importCzdsDropCandidates({ limit: options.importLimit });
  } catch (err) {
    console.warn(`[CZDS] Drop candidate import skipped (${reason}):`, err.message);
    return { ok: false, error: err.message };
  }

  if (!importedDrops.selected) {
    return { ok: true, imported: 0, selected: 0 };
  }

  const byTldText = Object.entries(importedDrops.byTld || {})
    .map(([tld, n]) => `${tld}:${n}`)
    .join(', ') || 'no tld summary';
  console.log(`[CZDS] Imported ${importedDrops.selected.toLocaleString()} dropped candidate rows (${byTldText})`);
  bustCache();
  invalidateStatsCache();

  if (options.triggerAvailability === false) return { ok: true, ...importedDrops };

  const result = startExpiredAvailabilityWorker(`czds-drop-import-${reason}`, {
    tlds: importedDropTlds(importedDrops),
    limit: options.availabilityLimit || process.env.DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_LIMIT || 2000,
    concurrency: options.concurrency || process.env.DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_CONCURRENCY || 2,
    delayMs: options.delayMs ?? process.env.DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_DELAY_MS ?? 1000,
  });
  if (!result.ok) {
    console.log(`[ExpiredAvailability] CZDS drop refresh skipped: ${result.message}`);
  }
  return { ok: true, ...importedDrops, availability: result };
}

app.post('/api/czds-sync', requireAuth, async (req, res) => {
  if (czdsSyncRunning) return res.status(409).json({ error: 'CZDS sync already running' });
  if (!process.env.CZDS_USER || !process.env.CZDS_PASS) {
    return res.status(400).json({ error: 'CZDS_USER and CZDS_PASS are required in .env' });
  }
  const full = req.query.full === '1' || req.body?.full === true;
  const tlds = String(req.query.tlds || req.body?.tlds || '').trim();
  startCzdsSync(full ? 'manual full' : 'manual fast', {
    fast: !full,
    includeHeavy: full,
    tlds,
  });
  res.json({
    ok: true,
    mode: full ? 'full' : 'fast',
    tlds: tlds || null,
    message: full
      ? 'Full CZDS sync started. This includes heavyweight zones and can run for hours.'
      : 'Fast CZDS sync started. Heavyweight zones are deferred; research fills from smaller zones first.',
  });
});

function startPrefixScan(prefix, { force = false } = {}) {
  const cleanPrefix = normalizePrefix(prefix);
  if (!cleanPrefix || cleanPrefix.length < 2) return { ok: false, error: 'Enter a prefix with 2+ characters' };
  if (prefixScanRunning) {
    return { ok: false, error: `Deep prefix scan already running for "${prefixScanPrefix}"` };
  }
  if (!process.env.CZDS_USER || !process.env.CZDS_PASS) {
    return { ok: false, error: 'CZDS_USER and CZDS_PASS are required in .env' };
  }

  const script = path.join(__dirname, 'czds-prefix-scan.js');
  const childArgs = [script, `--prefix=${cleanPrefix}`];
  if (force) childArgs.push('--force');

  let command = process.execPath;
  let args = childArgs;
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/nice')) {
    command = '/usr/bin/nice';
    args = ['-n', '10', process.execPath, ...childArgs];
  }

  prefixScanRunning = true;
  prefixScanPrefix = cleanPrefix;
  console.log(`[PrefixScan] Starting deep prefix scan for "${cleanPrefix}" in worker process...`);
  prefixScanChild = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  });
  prefixScanChild.on('exit', (code, signal) => {
    console.log(`[PrefixScan] Worker finished for "${cleanPrefix}" (${signal || code})`);
    prefixScanRunning = false;
    prefixScanChild = null;
    prefixScanPrefix = null;
    bustCache();
  });
  prefixScanChild.on('error', (err) => {
    console.error('[PrefixScan] Worker failed to start:', err.message);
    prefixScanRunning = false;
    prefixScanChild = null;
    prefixScanPrefix = null;
  });
  return { ok: true, prefix: cleanPrefix };
}

app.post('/api/research-prefix-sync', requireAuth, async (req, res) => {
  const prefix = req.query.prefix || req.body?.prefix || '';
  const force = req.query.force === '1' || req.body?.force === true;
  const result = startPrefixScan(prefix, { force });
  if (!result.ok) return res.status(409).json(result);
  res.json({
    ok: true,
    prefix: result.prefix,
    message: `Deep prefix scan started for "${result.prefix}". Research will fill as each TLD is streamed.`,
  });
});

// ── Cron: auctions/market/expiry every 6h, CZDS zone universe daily ─────────
cron.schedule('0 */6 * * *', () => {
  const result = startScrapeWorker('scheduled', { includeCZDS: false });
  if (!result.ok) {
    console.log(`[Cron] Skipping — ${result.message}${result.pid ? ` (pid ${result.pid})` : ''}`);
  }
});

cron.schedule(EXPIRED_AVAILABILITY_CRON, () => {
  const result = startExpiredAvailabilityWorkerIfDue('scheduled-hourly', {
    limit: process.env.DOMAINSCOUT_SCHEDULED_EXPIRED_AVAILABILITY_LIMIT || 1000,
  });
  if (!result.ok) {
    console.log(`[ExpiredAvailability] Scheduled refresh skipped: ${result.message}${result.pid ? ` (pid ${result.pid})` : ''}`);
  } else if (result.noop) {
    console.log(`[ExpiredAvailability] Scheduled refresh skipped: ${result.message}`);
  }
});

cron.schedule(EXPIRED_DOGFOOD_CRON, () => {
  const result = startExpiredDogfood('scheduled-hourly');
  if (!result.ok && !result.disabled && !result.running) {
    console.log('[Dogfood] Scheduled expired verifier skipped');
  }
});

cron.schedule('*/10 * * * *', () => {
  refreshStatsCache({ force: true });
});

cron.schedule('*/15 * * * *', () => {
  runCzdsDropImportMaintenance('scheduled');
});

cron.schedule('15 2 * * *', () => {
  startCzdsSync('daily full', { fast: false, includeHeavy: true });
});

const OBSERVED_TREND_DAYS = Math.max(7, parseInt(process.env.DOMAINSCOUT_OBSERVED_TREND_DAYS || '45', 10));
const OBSERVED_ACTIVITY_DAYS = Math.max(1, parseInt(process.env.DOMAINSCOUT_OBSERVED_ACTIVITY_DAYS || '10', 10));
const TREND_CACHE_TTL_MS = 5 * 60 * 1000;
const trendCache = new Map();

function cachedTrend(key, build) {
  const hit = trendCache.get(key);
  if (hit && Date.now() - hit.ts < TREND_CACHE_TTL_MS) return hit.value;
  const value = build();
  trendCache.set(key, { ts: Date.now(), value });
  return value;
}

function normalizeTrendTld(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean) return '';
  return clean.startsWith('.') ? clean : `.${clean}`;
}

function normalizeTrendBaseName(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 80);
}

function parseTrendTlds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(normalizeTrendTld).filter(Boolean))].sort();
  return [...new Set(String(value || '')
    .split(',')
    .map(normalizeTrendTld)
    .filter(Boolean)
  )].sort();
}

function getObservedTldTrends(limit = 150, { excludeTlds = new Set(), days = OBSERVED_TREND_DAYS, activityDays = OBSERVED_ACTIVITY_DAYS } = {}) {
  const cacheKey = `observed-tlds:${limit}:${days}:${activityDays}:${[...excludeTlds].sort().join(',')}`;
  return cachedTrend(cacheKey, () => {
    try {
      const rows = db.prepare(`
        WITH first_seen AS (
          SELECT
            LOWER(tld) AS tld,
            LOWER(domain) AS domain,
            MIN(date(discovered_at)) AS first_date
          FROM domains
          WHERE discovered_at IS NOT NULL
            AND discovered_at >= date('now', ?)
            AND tld IS NOT NULL
            AND tld != ''
          GROUP BY LOWER(tld), LOWER(domain)
        )
        SELECT
          tld,
          COUNT(*) AS observed_total,
          SUM(CASE WHEN first_date >= date('now', ?) THEN 1 ELSE 0 END) AS activity_count,
          MAX(first_date) AS stat_date
        FROM first_seen
        GROUP BY tld
        HAVING observed_total > 0
        ORDER BY activity_count DESC, observed_total DESC, tld ASC
      `).all(`-${days} days`, `-${activityDays} days`);

      return rows
        .map(row => ({
          tld: normalizeTrendTld(row.tld).slice(1),
          today_total: row.observed_total || 0,
          yesterday_total: null,
          new_count: row.activity_count || 0,
          dropped_count: null,
          growth_pct: null,
          stat_date: row.stat_date,
          comparison_date: null,
          baseline: 0,
          source: 'observed-activity',
          sourceLabel: `observed feed activity (${activityDays}d)`,
          metric: 'observed-activity',
          activityWindowDays: activityDays,
          observed: true,
        }))
        .filter(row => row.tld && !excludeTlds.has(`.${row.tld}`))
        .slice(0, limit);
    } catch (err) {
      console.warn('[Trends] observed TLD trends unavailable:', err.message);
      return [];
    }
  });
}

function mergeTldTrendRows(zoneRows, observedRows, limit) {
  const byTld = new Map();
  for (const row of [...zoneRows, ...observedRows]) {
    const tld = normalizeTrendTld(row.tld).slice(1);
    if (!tld) continue;
    const normalized = {
      ...row,
      tld,
      source: row.source || 'zone',
      sourceLabel: row.sourceLabel || 'zone file',
      metric: row.metric || (row.observed ? 'observed-activity' : row.baseline ? 'zone-baseline' : 'zone-growth'),
      observed: !!row.observed,
    };
    const existing = byTld.get(tld);
    if (!existing || (existing.observed && !normalized.observed)) byTld.set(tld, normalized);
  }
  const metricRank = (row) => {
    if (row.metric === 'zone-growth') return 0;
    if (row.metric === 'observed-activity') return 1;
    return 2;
  };
  return [...byTld.values()]
    .sort((a, b) =>
      (metricRank(a) - metricRank(b)) ||
      (Number(b.growth_pct ?? -Infinity) - Number(a.growth_pct ?? -Infinity)) ||
      (Number(b.new_count || 0) - Number(a.new_count || 0)) ||
      (Number(b.today_total || 0) - Number(a.today_total || 0)) ||
      String(a.tld).localeCompare(String(b.tld))
    )
    .slice(0, limit);
}

function summarizeTldMetrics(tlds) {
  return {
    zoneGrowth: tlds.filter(t => t.metric === 'zone-growth').length,
    observedActivity: tlds.filter(t => t.metric === 'observed-activity').length,
    baseline: tlds.filter(t => t.metric === 'zone-baseline').length,
  };
}

function getObservedKeywordTrends(limit = 300, { days = OBSERVED_TREND_DAYS } = {}) {
  const cacheKey = `observed-keywords:${limit}:${days}`;
  return cachedTrend(cacheKey, () => {
    try {
      return db.prepare(`
        WITH first_seen AS (
          SELECT
            LOWER(base_name) AS base_name,
            LOWER(tld) AS tld,
            MIN(date(discovered_at)) AS first_date
          FROM domains
          WHERE discovered_at IS NOT NULL
            AND discovered_at >= date('now', ?)
            AND base_name IS NOT NULL
            AND base_name != ''
            AND LENGTH(base_name) BETWEEN 2 AND 48
            AND base_name NOT LIKE '%--%'
          GROUP BY LOWER(base_name), LOWER(tld)
        ),
        totals AS (
          SELECT base_name, COUNT(*) AS total_tlds, GROUP_CONCAT(tld) AS all_tlds
          FROM first_seen
          GROUP BY base_name
        ),
        daily AS (
          SELECT
            base_name,
            first_date AS trend_date,
            COUNT(*) AS new_tld_count,
            GROUP_CONCAT(tld) AS tlds_csv
          FROM first_seen
          GROUP BY base_name, first_date
        ),
        latest AS (
          SELECT base_name, MAX(trend_date) AS trend_date
          FROM daily
          GROUP BY base_name
        )
        SELECT
          d.base_name AS keyword,
          d.trend_date,
          totals.total_tlds AS tld_count,
          d.new_tld_count,
          d.tlds_csv,
          'observed-feeds' AS source
        FROM daily d
        JOIN latest l ON l.base_name = d.base_name AND l.trend_date = d.trend_date
        JOIN totals ON totals.base_name = d.base_name
        WHERE totals.total_tlds >= 2
        ORDER BY d.trend_date DESC, d.new_tld_count DESC, totals.total_tlds DESC, d.base_name ASC
        LIMIT ?
      `).all(`-${days} days`, limit).map(row => ({
        ...row,
        tlds: parseTrendTlds(row.tlds_csv),
      }));
    } catch (err) {
      console.warn('[Trends] observed keyword trends unavailable:', err.message);
      return [];
    }
  });
}

function mergeKeywordTrendRows(zoneRows, observedRows, limit) {
  const byKeyword = new Map();
  for (const row of [...observedRows, ...zoneRows]) {
    const keyword = normalizeTrendBaseName(row.keyword);
    if (!keyword) continue;
    const incoming = {
      ...row,
      keyword,
      tld_count: Number(row.tld_count || row.new_tld_count || 0),
      new_tld_count: Number(row.new_tld_count || row.tld_count || 0),
      source: row.source || 'daily-diff',
    };
    const existing = byKeyword.get(keyword);
    if (!existing) {
      byKeyword.set(keyword, incoming);
      continue;
    }
    const incomingDate = String(incoming.trend_date || '');
    const existingDate = String(existing.trend_date || '');
    existing.source = [...new Set([existing.source, incoming.source].join('+').split('+'))].join('+');
    existing.tld_count = Math.max(existing.tld_count || 0, incoming.tld_count || 0);
    existing.new_tld_count = Math.max(existing.new_tld_count || 0, incoming.new_tld_count || 0);
    if (incomingDate > existingDate) {
      existing.trend_date = incoming.trend_date;
      existing.tlds = incoming.tlds || existing.tlds;
    }
  }
  return [...byKeyword.values()]
    .sort((a, b) =>
      String(b.trend_date || '').localeCompare(String(a.trend_date || '')) ||
      (Number(b.new_tld_count || 0) - Number(a.new_tld_count || 0)) ||
      (Number(b.tld_count || 0) - Number(a.tld_count || 0)) ||
      String(a.keyword).localeCompare(String(b.keyword))
    )
    .slice(0, limit);
}

function getObservedKeywordTrendHistory(baseName, { days = 365 } = {}) {
  const clean = normalizeTrendBaseName(baseName);
  if (!clean) return { dates: [], currentTlds: [], localTlds: [] };
  try {
    const dates = db.prepare(`
      WITH first_seen AS (
        SELECT
          LOWER(tld) AS tld,
          MIN(date(discovered_at)) AS first_date
        FROM domains
        WHERE base_name = ?
          AND discovered_at IS NOT NULL
          AND discovered_at >= date('now', ?)
          AND tld IS NOT NULL
          AND tld != ''
        GROUP BY LOWER(tld)
      )
      SELECT
        first_date AS trend_date,
        COUNT(*) AS new_tld_count,
        GROUP_CONCAT(tld) AS tlds_csv
      FROM first_seen
      GROUP BY first_date
      ORDER BY first_date DESC
    `).all(clean, `-${days} days`).map(row => ({
      trend_date: row.trend_date,
      tld_count: row.new_tld_count,
      new_tld_count: row.new_tld_count,
      tlds: parseTrendTlds(row.tlds_csv),
      source: 'observed-feeds',
      hasTldList: true,
    }));

    const localTlds = db.prepare(`
      SELECT
        LOWER(tld) AS tld,
        MIN(domain) AS domain,
        MIN(discovered_at) AS first_seen,
        MIN(CASE WHEN auction_price IS NOT NULL THEN auction_price END) AS price,
        MAX(auction_url) AS url,
        GROUP_CONCAT(DISTINCT stream) AS streams
      FROM domains
      WHERE base_name = ?
      GROUP BY LOWER(tld)
      ORDER BY LOWER(tld)
    `).all(clean).map(row => ({
      tld: normalizeTrendTld(row.tld),
      domain: row.domain,
      first_seen: row.first_seen,
      price: row.price,
      url: row.url,
      streams: String(row.streams || '').split(',').filter(Boolean),
    }));

    return {
      dates,
      localTlds,
      currentTlds: localTlds.map(row => row.tld),
    };
  } catch (err) {
    console.warn('[Trends] observed keyword detail unavailable:', err.message);
    return { dates: [], currentTlds: [], localTlds: [] };
  }
}

function buildKeywordTrendDetail(keyword, requestedDate) {
  const clean = normalizeTrendBaseName(keyword);
  const zone = getKeywordTrendHistory(clean);
  const observed = getObservedKeywordTrendHistory(clean);
  const byDate = new Map();

  const mergeDate = (row) => {
    const date = row.trend_date;
    if (!date) return;
    if (!byDate.has(date)) {
      byDate.set(date, {
        trend_date: date,
        tld_count: 0,
        new_tld_count: 0,
        tlds: [],
        sources: [],
        hasTldList: false,
      });
    }
    const target = byDate.get(date);
    const tlds = parseTrendTlds(row.tlds || []);
    target.tlds = [...new Set([...target.tlds, ...tlds])].sort();
    target.tld_count = Math.max(target.tld_count || 0, Number(row.tld_count || tlds.length || 0));
    target.new_tld_count = Math.max(target.new_tld_count || 0, Number(row.new_tld_count || tlds.length || 0));
    target.hasTldList = target.hasTldList || row.hasTldList || tlds.length > 0;
    if (row.source) target.sources = [...new Set([...target.sources, row.source])];
  };

  for (const row of zone.dates || []) mergeDate(row);
  for (const row of observed.dates || []) mergeDate(row);

  const localByTld = new Map((observed.localTlds || []).map(row => [row.tld, row]));
  const currentTlds = parseTrendTlds([...(zone.currentTlds || []), ...(observed.currentTlds || [])]);
  const localTlds = currentTlds.map(tld => localByTld.get(tld) || {
    tld,
    domain: `${clean}${tld}`,
    first_seen: null,
    price: null,
    url: `https://${clean}${tld}/`,
    streams: ['zone'],
  });

  if (!byDate.size && currentTlds.length) {
    const today = new Date().toISOString().slice(0, 10);
    byDate.set(today, {
      trend_date: today,
      tld_count: currentTlds.length,
      new_tld_count: currentTlds.length,
      tlds: currentTlds,
      sources: ['current-coverage'],
      hasTldList: true,
    });
  }

  const dates = [...byDate.values()]
    .map(row => ({
      ...row,
      source: row.sources.join('+') || 'trend',
    }))
    .sort((a, b) => String(b.trend_date).localeCompare(String(a.trend_date)));
  const selectedDate = requestedDate && byDate.has(requestedDate)
    ? requestedDate
    : dates[0]?.trend_date || null;
  const selected = selectedDate ? byDate.get(selectedDate) : null;

  return {
    keyword: clean,
    selectedDate,
    selected: selected ? {
      ...selected,
      source: selected.sources.join('+') || 'trend',
    } : null,
    dates,
    currentTlds,
    localTlds,
    sourceNote: 'zone rows are registry zone-file backed; observed rows come from DomainScout feeds such as auctions, pending delete, and certificates',
  };
}

// ── GET /api/trends ──────────────────────────────────────────────────────────
// Returns real zone growth, observed activity, baseline TLD coverage, and keywords.
app.get('/api/trends', requireAuth, (req, res) => {
  const tldLimit = Math.min(1000, Math.max(1, parseInt(req.query.tldLimit || 500)));
  const keywordLimit = Math.min(1000, Math.max(1, parseInt(req.query.keywordLimit || 300)));
  const zoneTlds = getTldTrends(tldLimit);
  const observedTlds = getObservedTldTrends(tldLimit, { excludeTlds: getIndexedTldSet() });
  const tlds = mergeTldTrendRows(zoneTlds, observedTlds, tldLimit);
  const zoneKeywords = getKeywordTrends(keywordLimit);
  const observedKeywords = getObservedKeywordTrends(keywordLimit);
  const keywords = mergeKeywordTrendRows(zoneKeywords, observedKeywords, keywordLimit);
  res.json({
    hasData:  hasTrendData() || tlds.length > 0 || keywords.length > 0,
    tlds,
    keywords,
    tldMode: tlds.some(t => t.metric === 'zone-growth') ? 'mixed' : 'baseline',
    tldMetrics: summarizeTldMetrics(tlds),
    keywordMode: keywords.some(k => String(k.source || '').includes('observed-feeds')) ? 'mixed' :
      keywords.some(k => k.source === 'coverage-baseline') ? 'coverage-baseline' : 'daily-diff',
    observedWindowDays: OBSERVED_TREND_DAYS,
    observedActivityDays: OBSERVED_ACTIVITY_DAYS,
  });
});

app.get('/api/tld-trends', requireAuth, (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || 500)));
  const zoneTlds = getTldTrends(limit);
  const observedTlds = getObservedTldTrends(limit, { excludeTlds: getIndexedTldSet() });
  const tlds = mergeTldTrendRows(zoneTlds, observedTlds, limit);
  res.json({
    hasData: tlds.length > 0,
    mode: tlds.some(t => t.metric === 'zone-growth') ? 'mixed' : 'baseline',
    metrics: summarizeTldMetrics(tlds),
    observedActivityDays: OBSERVED_ACTIVITY_DAYS,
    tlds,
  });
});

app.get('/api/keyword-trends', requireAuth, (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || 300)));
  const keywords = mergeKeywordTrendRows(
    getKeywordTrends(limit),
    getObservedKeywordTrends(limit),
    limit,
  );
  res.json({
    hasData: keywords.length > 0,
    mode: keywords.some(k => String(k.source || '').includes('observed-feeds')) ? 'mixed' :
      keywords.some(k => k.source === 'coverage-baseline') ? 'coverage-baseline' : 'daily-diff',
    keywords,
  });
});

app.get('/api/trend-keyword', requireAuth, (req, res) => {
  const keyword = normalizeTrendBaseName(req.query.keyword || req.query.term || '');
  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  const date = String(req.query.date || '').slice(0, 10);
  res.json(buildKeywordTrendDetail(keyword, date));
});

// ── GET /api/zone-index-status ──────────────────────────────────────────────
// Returns how many TLDs and names are currently in the zone index.
app.get('/api/zone-index-status', requireAuth, (req, res) => {
  const stats = getZoneIndexStats();
  res.json(stats);
});

// ── POST /api/zone-index-rebuild ─────────────────────────────────────────────
// Trigger a background rebuild of the zone index from downloaded zone files.
app.post('/api/zone-index-rebuild', requireAuth, (req, res) => {
  indexAllPendingZoneFiles().catch(err => console.error('[ZoneIndex rebuild]', err.message));
  res.json({ ok: true, message: 'Zone index rebuild started in background' });
});

// ── Serve frontend ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🔭 DomainScout running at http://localhost:${PORT} [build:godaddy-split]`);
  console.log('Scrape schedule: every 6 hours');
  console.log('Run manual scrape: POST /api/scrape\n');

  // Keep quality scores fresh across ALL streams (not just confirmed-available) so
  // the "Best quality" sort stays correct as scrapers add new auction names. Run as
  // a detached child so a large stale set never blocks the server event loop.
  setImmediate(() => {
    try {
      const child = require('child_process').spawn(
        process.execPath,
        [path.join(__dirname, 'quality-backfill.js'), '--all'],
        { cwd: path.join(__dirname, '..'), stdio: 'ignore', detached: true }
      );
      child.on('error', (err) => console.warn('[Quality] Backfill failed to start:', err.message));
      child.on('close', () => bustCache());
      child.unref();
    } catch (err) {
      console.warn('[Quality] Backfill skipped:', err.message);
    }
  });

  refreshLogicalTlds()
    .then(info => console.log(`[TLDs] ${info.count} logical TLDs loaded from ${info.source}${info.error ? ` (refresh error: ${info.error})` : ''}`))
    .catch(err => console.warn('[TLDs] refresh failed:', err.message));

  // Auto-scrape on startup if the database is empty
  const domainCount = db.prepare('SELECT COUNT(*) as n FROM domains').get().n;
  if (domainCount === 0) {
    const result = startScrapeWorker('startup-empty-db', { includeCZDS: false });
    if (!result.ok) console.log(`[Startup] Initial scrape skipped — ${result.message}`);
  }

  setTimeout(() => {
    runCzdsDropImportMaintenance('startup');
  }, 30_000);

  setTimeout(() => {
    startExpiredDogfood('startup');
  }, 45_000);

  setTimeout(() => {
    scheduleExpiredAvailabilityCooldownRetry('startup');
  }, 50_000);

  setTimeout(() => {
    refreshStatsCache({ force: true });
  }, 60_000);

  // Accurate TLD counts are produced by a separate background process. The UI
  // reads only full-universe tld_check_cache results as final counts.
  if (process.env.DOMAINSCOUT_TLD_ACCURACY_WORKER === '1') {
    startTldAccuracyWorkerProcess('startup');
  } else if (process.env.ENABLE_TLDS_WORKER === '1') {
    startWorker();
  } else {
    console.log('[TLDs Worker] Disabled (set DOMAINSCOUT_TLD_ACCURACY_WORKER=1 to enable accurate backfill)');
  }

  // Startup zone indexing can run for a long time and uses synchronous SQLite
  // work, so keep it out of the web process unless explicitly enabled.
  setTimeout(() => {
    if (STARTUP_ZONE_INDEX_ENABLED) {
      indexAllPendingZoneFiles().catch(err => console.error('[ZoneIndex startup]', err.message));
    } else {
      console.log('[ZoneIndex] Startup indexing disabled; set DOMAINSCOUT_STARTUP_ZONE_INDEX_ENABLED=1 for maintenance');
    }
    attachZoneIndex(); // attach for cross-DB filtering (zone_index.db created by zone-indexer)
    if (process.env.ENABLE_STARTUP_TLD_COUNT_SYNC === '1') {
      setImmediate(() => syncBaseTldCounts({ reason: 'startup' }));
    } else {
      console.log('[TLDCounts] Startup sync disabled; set ENABLE_STARTUP_TLD_COUNT_SYNC=1 for maintenance');
    }
  }, 8000);

  // Run migrations + rescrape after server is healthy (non-blocking)
  setTimeout(async () => {
    if (!STARTUP_MAINTENANCE_ENABLED) {
      console.log('[Migration] Startup maintenance disabled; set DOMAINSCOUT_STARTUP_MAINTENANCE_ENABLED=1 for maintenance');
      return;
    }

    try {
      const c1 = db.prepare(`UPDATE domains SET stream = 'godaddy-closeout' WHERE source = 'GoDaddy Closeout' AND stream = 'godaddy-auction'`).run();
      console.log(`[Migration] closeout re-tag: ${c1.changes} rows`);
      // Remove duplicate GoDaddy rows: if a domain exists in both streams, keep the closeout row only
      const c3 = db.prepare(`DELETE FROM domains WHERE stream = 'godaddy-auction' AND saved = 0 AND skipped = 0 AND domain IN (SELECT domain FROM domains WHERE stream = 'godaddy-closeout')`).run();
      console.log(`[Migration] GoDaddy dedup: removed ${c3.changes} auction rows that also had a closeout row`);
      const c4 = purgeEndedAuctions(db);
      console.log(`[Migration] ended auction purge: removed ${c4} rows`);
      if (c1.changes || c3.changes || c4) {
        bustCache();
        invalidateStatsCache();
      }
    } catch (err) {
      console.error('[Migration error]', err.message);
    }
    // Re-scrape if closeout stream is empty (first deploy after split)
    const closeoutCount = db.prepare(`SELECT COUNT(*) as n FROM domains WHERE stream = 'godaddy-closeout'`).get().n;
    if (closeoutCount === 0) {
      const result = startScrapeWorker('startup-empty-closeout', { includeCZDS: false });
      if (!result.ok) console.log(`[Startup] closeout scrape skipped — ${result.message}`);
    }
  }, 5000);
});
