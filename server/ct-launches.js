'use strict';

/**
 * Near-live launch detector (Certificate Transparency).
 *
 * Runs in its own child process (server/ct-launch-worker.js, supervised by
 * createCtLaunchSupervisor) next to the daily live-sites stage, so certificate
 * parsing and homepage fetches never load the API event loop or the zone-diff
 * stage.
 *
 *   CT logs (ct-log.js) -> DNS SANs -> registrable domains -> launch rule ->
 *   bounded site observer (live-sites fetchSite/classifyObservation) ->
 *   <universeDir>/<UTC day>/sites/ct-launches.jsonl (this process is its only
 *   writer; the daily stage never touches it, and the public feed merges it
 *   with the day's observations).
 *
 * Launch rule (each registrable domain emitted at most once):
 *   (a) the domain was added in the universe zone tapes (tape/adds.tsv) within
 *       the launch window (default 14 days), or is a went-live row of a recent
 *       movement tape (ns/movement.jsonl, ns-observed/<tld>/movement.jsonl);
 *       a domain of a zone WITH zone data that is not recent (a renewal) is
 *       never a launch;
 *   (b) for configured zone-less zones (default ai, io, sh, si) the domain is
 *       seen in CT for the first time, once 7 days of tailing have warmed up
 *       the first-seen store.
 *
 * State on the data volume (<dataDir>/universe/ct/): positions.json (per-log
 * next index), state.json (accumulated tailing time for the warm-up),
 * launches.db (sqlite: recent-add index, first-seen store, emitted set),
 * health.json (read by GET /api/universe/health and the public feed).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const ctLog = require('./ct-log');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const JOURNAL_FILE = 'ct-launches.jsonl';
const HEALTH_SCHEMA = 'domainscout.ct-launches-health/v1';
const SOURCE = 'ct';

function defaultSleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

function num(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

const csv = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
function shiftDay(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const lastLabel = domain => String(domain).slice(String(domain).lastIndexOf('.') + 1);

/** Same gate as the live-sites stage, plus DOMAINSCOUT_CT_LAUNCHES_ENABLED (0 = off, 1 = force on). */
function ctEnabled(env = process.env) {
  if (env.DOMAINSCOUT_CT_LAUNCHES_ENABLED === '0' || env.DOMAINSCOUT_LIVE_SITES_ENABLED === '0') return false;
  return env.DOMAINSCOUT_UNIVERSE_PULL_ENABLED === '1' || env.DOMAINSCOUT_LIVE_SITES_ENABLED === '1' || env.DOMAINSCOUT_CT_LAUNCHES_ENABLED === '1';
}

function resolveCtConfig(env = process.env) {
  return {
    enabled: ctEnabled(env),
    logListUrl: String(env.DOMAINSCOUT_CT_LOG_LIST_URL || '').trim() || ctLog.LOG_LIST_URL,
    logs: csv(env.DOMAINSCOUT_CT_LOGS),
    operators: env.DOMAINSCOUT_CT_OPERATORS ? csv(env.DOMAINSCOUT_CT_OPERATORS) : ctLog.DEFAULT_OPERATORS,
    maxLogs: Math.trunc(num(env, 'DOMAINSCOUT_CT_MAX_LOGS', 6, 1, 32)),
    // Shards are split by certificate EXPIRY; a cert issued today expires
    // ~47-90 days out, so the shard covering now+offset receives today's certs.
    shardOffsetDays: num(env, 'DOMAINSCOUT_CT_SHARD_OFFSET_DAYS', 60, 0, 800),
    logListRefreshMs: num(env, 'DOMAINSCOUT_CT_LOG_LIST_REFRESH_MS', DAY_MS, 60000, 30 * DAY_MS),
    batch: Math.trunc(num(env, 'DOMAINSCOUT_CT_BATCH', 256, 1, 1024)),
    requestIntervalMs: num(env, 'DOMAINSCOUT_CT_REQUEST_INTERVAL_MS', 250, 0, 60000),
    pollMs: num(env, 'DOMAINSCOUT_CT_POLL_MS', 10000, 10, 600000),
    maxEntriesPerSec: num(env, 'DOMAINSCOUT_CT_MAX_ENTRIES_PER_SEC', 400, 1, 100000),
    maxLag: Math.trunc(num(env, 'DOMAINSCOUT_CT_MAX_LAG', 1000000, 256, 1e12)),
    backoffMs: num(env, 'DOMAINSCOUT_CT_BACKOFF_MS', 5000, 1, 600000),
    backoffMaxMs: num(env, 'DOMAINSCOUT_CT_BACKOFF_MAX_MS', 300000, 1, 3600000),
    timeoutMs: num(env, 'DOMAINSCOUT_CT_TIMEOUT_MS', 20000, 100, 120000),
    windowDays: Math.trunc(num(env, 'DOMAINSCOUT_CT_LAUNCH_WINDOW_DAYS', 14, 1, 90)),
    warmupDays: num(env, 'DOMAINSCOUT_CT_WARMUP_DAYS', 7, 0, 365),
    zonelessZones: (env.DOMAINSCOUT_CT_ZONELESS_ZONES === undefined ? ['ai', 'io', 'sh', 'si'] : csv(env.DOMAINSCOUT_CT_ZONELESS_ZONES))
      .map(zone => zone.toLowerCase().replace(/^\.+/, '')),
    firstSeenMax: Math.trunc(num(env, 'DOMAINSCOUT_CT_FIRST_SEEN_MAX', 3000000, 10, 1e9)),
    emittedRetentionDays: Math.trunc(num(env, 'DOMAINSCOUT_CT_EMITTED_RETENTION_DAYS', 30, 1, 3650)),
    concurrency: Math.trunc(num(env, 'DOMAINSCOUT_CT_OBSERVE_CONCURRENCY', 8, 1, 64)),
    maxQueue: Math.trunc(num(env, 'DOMAINSCOUT_CT_MAX_QUEUE', 5000, 1, 1e6)),
    recheckMs: num(env, 'DOMAINSCOUT_CT_RECHECK_MS', 20 * 60000, 0, DAY_MS),
    maxRechecks: Math.trunc(num(env, 'DOMAINSCOUT_CT_MAX_RECHECKS', 5000, 0, 1e6)),
    indexRefreshMs: num(env, 'DOMAINSCOUT_CT_INDEX_REFRESH_MS', 10 * 60000, 100, DAY_MS),
    healthEveryMs: num(env, 'DOMAINSCOUT_CT_HEALTH_EVERY_MS', 15000, 10, 600000),
    memoSize: Math.trunc(num(env, 'DOMAINSCOUT_CT_MEMO_SIZE', 100000, 0, 5e6)),
    userAgent: String(env.DOMAINSCOUT_CT_USER_AGENT || '').trim() || ctLog.DEFAULT_USER_AGENT,
  };
}

function ctPaths(dataDir) {
  const dir = path.join(dataDir, 'universe', 'ct');
  return {
    dir,
    positions: path.join(dir, 'positions.json'),
    state: path.join(dir, 'state.json'),
    db: path.join(dir, 'launches.db'),
    health: path.join(dir, 'health.json'),
    lock: path.join(dir, 'tailer.lock'),
  };
}

function readJsonSync(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

let atomicSeq = 0;
async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  atomicSeq += 1;
  const part = `${file}.${process.pid}.${atomicSeq}.part`;
  await fsp.writeFile(part, JSON.stringify(value));
  await fsp.rename(part, file);
}

// ── Store (sqlite on the data volume) ───────────────────────────────────────

/**
 * Opens sqlite through the repo's better-sqlite3 when its native binding is
 * available, else Node's built-in node:sqlite (no new dependency). Only the
 * common prepare/get/all/run/exec surface is used; transactions are explicit.
 */
function openSqlite(file) {
  try {
    const Database = require('better-sqlite3');
    return { db: new Database(file), driver: 'better-sqlite3' };
  } catch (error) {
    const { DatabaseSync } = require('node:sqlite');
    return { db: new DatabaseSync(file), driver: 'node:sqlite', fallbackReason: String(error?.message || error).split('\n')[0] };
  }
}

function openLaunchStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const { db, driver } = openSqlite(file);
  for (const pragma of ['journal_mode = WAL', 'synchronous = NORMAL', 'busy_timeout = 5000', 'cache_size = -16000', 'wal_autocheckpoint = 2000']) {
    try { db.exec(`PRAGMA ${pragma}`); } catch { /* best effort (e.g. WAL on :memory:) */ }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent (domain TEXT PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS recent_day ON recent(day);
    CREATE TABLE IF NOT EXISTS zone_data (zone TEXT PRIMARY KEY, last_day TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS imported (file TEXT PRIMARY KEY, day TEXT NOT NULL, size INTEGER, mtime REAL, rows INTEGER, at TEXT) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS first_seen (domain TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS first_seen_at ON first_seen(at);
    CREATE TABLE IF NOT EXISTS emitted (domain TEXT PRIMARY KEY, at INTEGER NOT NULL, state TEXT NOT NULL, job TEXT) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS emitted_at ON emitted(at);
    CREATE INDEX IF NOT EXISTS emitted_state ON emitted(state);
  `);
  const q = {
    recent: db.prepare('SELECT day, kind FROM recent WHERE domain = ?'),
    upsertRecent: db.prepare(`INSERT INTO recent (domain, day, kind) VALUES (?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET day = MAX(day, excluded.day), kind = CASE WHEN excluded.kind = 'went-live' THEN 'went-live' ELSE kind END`),
    zone: db.prepare('SELECT last_day FROM zone_data WHERE zone = ?'),
    upsertZone: db.prepare('INSERT INTO zone_data (zone, last_day) VALUES (?, ?) ON CONFLICT(zone) DO UPDATE SET last_day = MAX(last_day, excluded.last_day)'),
    imported: db.prepare('SELECT size, mtime FROM imported WHERE file = ?'),
    markImported: db.prepare('INSERT OR REPLACE INTO imported (file, day, size, mtime, rows, at) VALUES (?, ?, ?, ?, ?, ?)'),
    pruneRecent: db.prepare('DELETE FROM recent WHERE day < ?'),
    pruneImported: db.prepare('DELETE FROM imported WHERE day < ?'),
    firstSeen: db.prepare('INSERT OR IGNORE INTO first_seen (domain, at) VALUES (?, ?)'),
    firstSeenCount: db.prepare('SELECT COUNT(*) AS n FROM first_seen'),
    firstSeenTrim: db.prepare('DELETE FROM first_seen WHERE domain IN (SELECT domain FROM first_seen ORDER BY at LIMIT ?)'),
    emitted: db.prepare('SELECT state FROM emitted WHERE domain = ?'),
    claim: db.prepare("INSERT OR IGNORE INTO emitted (domain, at, state, job) VALUES (?, ?, 'pending', ?)"),
    finish: db.prepare('UPDATE emitted SET state = ?, at = ?, job = NULL WHERE domain = ?'),
    pending: db.prepare("SELECT domain, job FROM emitted WHERE state = 'pending' ORDER BY at LIMIT ?"),
    pruneEmitted: db.prepare("DELETE FROM emitted WHERE at < ? AND state != 'pending'"),
    counts: db.prepare(`SELECT (SELECT COUNT(*) FROM recent) AS recent, (SELECT COUNT(*) FROM zone_data) AS zones,
      (SELECT COUNT(*) FROM first_seen) AS firstSeen, (SELECT COUNT(*) FROM emitted) AS emitted,
      (SELECT COUNT(*) FROM emitted WHERE state = 'pending') AS pending`),
  };
  const insertMany = (rows, day) => {
    db.exec('BEGIN');
    try {
      for (const [domain, kind, zone] of rows) {
        q.upsertRecent.run(domain, day, kind);
        if (zone) q.upsertZone.run(zone, day);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* none open */ }
      throw error;
    }
  };
  return {
    db, driver,
    recentOf: domain => q.recent.get(domain) || null,
    hasZoneData: zone => !!q.zone.get(zone),
    isImported: (file, size, mtime) => { const row = q.imported.get(file); return !!row && row.size === size && row.mtime === mtime; },
    insertRecent: (rows, day) => insertMany(rows, day),
    markImported: (file, day, size, mtime, rows, at) => q.markImported.run(file, day, size, mtime, rows, at),
    pruneRecent: floorDay => { const r = q.pruneRecent.run(floorDay).changes; q.pruneImported.run(floorDay); return r; },
    /** True when this call recorded the first sighting. */
    markFirstSeen: (domain, at) => q.firstSeen.run(domain, at).changes === 1,
    trimFirstSeen: max => { const n = Number(q.firstSeenCount.get().n); return n > max ? Number(q.firstSeenTrim.run(n - max).changes) : 0; },
    isEmitted: domain => !!q.emitted.get(domain),
    /** Claims a domain for emission; false when it was already claimed or emitted (dedupe). */
    claim: (domain, at, job) => q.claim.run(domain, at, JSON.stringify(job)).changes === 1,
    finish: (domain, at, state = 'done') => q.finish.run(state, at, domain),
    pending: limit => q.pending.all(limit).map(row => { try { return JSON.parse(row.job); } catch { return { domain: row.domain }; } }),
    pruneEmitted: beforeMs => q.pruneEmitted.run(beforeMs).changes,
    counts: () => ({ ...q.counts.get(), driver }),
    close: () => { try { db.close(); } catch { /* closed */ } },
  };
}

// ── Recent-add / went-live index from the universe tapes ────────────────────

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));

async function importTape(store, file, day, kind, stat, now) {
  const rows = [];
  let total = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let domain = null;
    let zone = null;
    if (kind === 'added') {
      const [label, rawZone] = line.split('\t');
      zone = String(rawZone || '').toLowerCase().replace(/^\.+|\.+$/g, '');
      const name = `${String(label || '').toLowerCase()}.${zone}`;
      if (label && zone && /^[a-z0-9.-]+$/.test(name)) domain = name;
    } else {
      if (line.indexOf('went-live') === -1) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.selection !== 'went-live') continue;
      const name = String(row.domain || '').toLowerCase().replace(/\.+$/, '');
      if (/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(name)) domain = name;
    }
    if (!domain) continue;
    rows.push([domain, kind, zone]);
    total += 1;
    if (rows.length >= 5000) { store.insertRecent(rows.splice(0), day); await yieldLoop(); }
  }
  if (rows.length) store.insertRecent(rows, day);
  store.markImported(file, day, stat.size, stat.mtimeMs, total, new Date(now).toISOString());
  return total;
}

/** Imports new or changed tapes of the last windowDays days (idempotent by path+size+mtime) and prunes older rows. */
async function refreshRecentIndex({ store, universeDir, windowDays = 14, now = Date.now() }) {
  const today = utcDay(now);
  const floor = shiftDay(today, -windowDays);
  let entries = [];
  try { entries = await fsp.readdir(universeDir, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const days = entries.filter(e => e.isDirectory() && DAY_PATTERN.test(e.name) && e.name >= floor && e.name <= today).map(e => e.name).sort();
  let files = 0;
  let rows = 0;
  for (const day of days) {
    const candidates = [[path.join(universeDir, day, 'tape', 'adds.tsv'), 'added'], [path.join(universeDir, day, 'ns', 'movement.jsonl'), 'went-live']];
    try {
      for (const tld of await fsp.readdir(path.join(universeDir, day, 'ns-observed'))) {
        if (/^[a-z0-9-]+$/.test(tld)) candidates.push([path.join(universeDir, day, 'ns-observed', tld, 'movement.jsonl'), 'went-live']);
      }
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    for (const [file, kind] of candidates) {
      let stat;
      try { stat = await fsp.stat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (store.isImported(file, stat.size, stat.mtimeMs)) continue;
      rows += await importTape(store, file, day, kind, stat, now);
      files += 1;
    }
  }
  const pruned = store.pruneRecent(floor);
  return { days: days.length, files, rows, pruned, floor };
}

// ── Launch rule ─────────────────────────────────────────────────────────────

/**
 * { domain, zone } -> { launch, rule|reason }. Side effect: records the first
 * CT sighting of zone-less domains. Callers claim the domain (dedupe) on launch.
 */
function evaluateLaunch({ domain, zone }, { store, config, nowMs, warmedUp }) {
  if (store.isEmitted(domain)) return { launch: false, reason: 'duplicate' };
  const tld = lastLabel(domain);
  const zoneless = config.zonelessZones.includes('*') ? !store.hasZoneData(zone) : (config.zonelessZones.includes(zone) || config.zonelessZones.includes(tld));
  const firstSighting = zoneless ? store.markFirstSeen(domain, nowMs) : false;
  const recent = store.recentOf(domain);
  const floor = shiftDay(utcDay(nowMs), -config.windowDays);
  if (recent && recent.day >= floor) return { launch: true, rule: recent.kind === 'went-live' ? 'went-live' : 'recent-add', addedDay: recent.day };
  if (zoneless) {
    if (!firstSighting) return { launch: false, reason: 'seen-before' };
    if (!warmedUp) return { launch: false, reason: 'warming-up' };
    return { launch: true, rule: 'first-seen', addedDay: null };
  }
  if (store.hasZoneData(zone)) return { launch: false, reason: 'not-recently-added' };
  return { launch: false, reason: 'no-zone-data' };
}

// ── Bounded site observer + journal ─────────────────────────────────────────

function createLaunchObserver({ universeDir, store, config, siteConfig, fetchImpl, urlFor, clock = Date.now, log = console, onError = () => {} }) {
  const ls = require('./live-sites');
  const queue = [];
  const rechecks = [];
  const waiters = [];
  let inflight = 0;
  let stopped = false;
  let appendChain = Promise.resolve();
  const stats = { enqueued: 0, observed: 0, emitted: 0, publishable: 0, dropped: 0, rechecked: 0, errors: 0, classes: {} };
  const recentEmits = [];
  const recentPublishable = [];
  const hours = new Map();
  let lastLaunchAt = null;
  let lastPublishableAt = null;
  const timer = setInterval(() => {
    const t = clock();
    let moved = false;
    for (let i = rechecks.length - 1; i >= 0; i -= 1) if (rechecks[i].due <= t) { queue.unshift(rechecks.splice(i, 1)[0]); moved = true; }
    if (moved) pump();
  }, Math.max(50, Math.min(5000, config.recheckMs || 5000)));
  timer.unref?.();

  function settleWaiters() {
    if (queue.length || inflight) return;
    while (waiters.length) waiters.shift()();
  }

  function enqueue(job) {
    if (stopped) return false;
    if (queue.length >= config.maxQueue) {
      stats.dropped += 1;
      store.finish(job.domain, clock(), 'dropped');
      onError('observer', new Error(`launch queue full (${config.maxQueue}); dropped ${job.domain}`));
      return false;
    }
    queue.push({ attempt: 0, ...job });
    stats.enqueued += 1;
    pump();
    return true;
  }

  function pump() {
    while (!stopped && inflight < config.concurrency && queue.length) {
      const job = queue.shift();
      inflight += 1;
      run(job).catch(error => { stats.errors += 1; onError('observer', error); })
        .finally(() => { inflight -= 1; pump(); settleWaiters(); });
    }
    settleWaiters();
  }

  async function observeOne(domain) {
    const watchdogMs = siteConfig.timeoutMs * 2 + 4000;
    let timerId;
    const watchdog = new Promise(resolve => { timerId = setTimeout(() => resolve({ fetched: undefined, classified: { class: 'error', reason: 'watchdog_timeout', status: null } }), watchdogMs); });
    const work = (async () => {
      let fetched;
      try {
        fetched = await ls.fetchSite(domain, { fetchImpl, urlFor, timeoutMs: siteConfig.timeoutMs, maxBytes: siteConfig.maxBytes, maxRedirects: siteConfig.maxRedirects, userAgent: siteConfig.userAgent });
        return { fetched, classified: ls.classifyObservation({ domain, fetched, nameservers: [] }) };
      } catch (error) {
        return { fetched, classified: { class: 'error', reason: `classifier_failure:${String(error?.message || error).slice(0, 80)}`, status: fetched?.status ?? null } };
      }
    })();
    try { return await Promise.race([work, watchdog]); } finally { clearTimeout(timerId); }
  }

  async function run(job) {
    const { fetched, classified } = await observeOne(job.domain);
    stats.observed += 1;
    // CT often precedes the site: a non-built first look is retried once later.
    if (classified.class !== 'built' && job.attempt === 0 && config.recheckMs > 0 && rechecks.length < config.maxRechecks && !stopped) {
      stats.rechecked += 1;
      rechecks.push({ ...job, attempt: 1, due: clock() + config.recheckMs });
      return;
    }
    await emit(job, fetched, classified);
  }

  function emit(job, fetched, classified) {
    const nowMs = clock();
    const observedAt = new Date(nowMs).toISOString();
    const day = utcDay(nowMs);
    const record = {
      domain: job.domain, zone: lastLabel(job.domain), day,
      class: classified.class, reason: classified.reason, status: classified.status ?? null,
      url: fetched?.requestedUrl || `https://${job.domain}/`, finalUrl: classified.finalUrl || null,
      scheme: fetched?.scheme || null, redirects: fetched?.hops?.length || 0, bytes: fetched?.bytes || 0,
      title: classified.title || null, description: classified.description || null,
      titleReal: !!classified.titleReal, spam: !!classified.spam, fingerprint: classified.fingerprint || null,
      provider: null, kit: null, observedAt, version: ls.CLASSIFIER_VERSION,
      source: SOURCE, rule: job.rule, ctLog: job.ctLog || null, ctSeenAt: job.ctSeenAt || null, addedDay: job.addedDay || null,
      attempts: (job.attempt || 0) + 1,
    };
    const file = path.join(universeDir, day, 'sites', JOURNAL_FILE);
    const run = appendChain.then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, `${JSON.stringify(record)}\n`);
      store.finish(job.domain, nowMs, 'done');
      stats.emitted += 1;
      stats.classes[record.class] = (stats.classes[record.class] || 0) + 1;
      const publishable = record.class === 'built' && !record.spam && record.titleReal && !!record.title;
      lastLaunchAt = observedAt;
      recentEmits.push(nowMs);
      const hour = new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS).toISOString();
      const bucket = hours.get(hour) || { hour, launches: 0, publishable: 0 };
      bucket.launches += 1;
      if (publishable) { bucket.publishable += 1; stats.publishable += 1; lastPublishableAt = observedAt; recentPublishable.push(nowMs); }
      hours.set(hour, bucket);
      while (hours.size > 48) hours.delete(hours.keys().next().value);
      return record;
    });
    appendChain = run.catch(() => {});
    return run;
  }

  function snapshot() {
    const cutoff = clock() - HOUR_MS;
    for (const list of [recentEmits, recentPublishable]) { while (list.length && list[0] < cutoff) list.shift(); if (list.length > 200000) list.splice(0, list.length - 200000); }
    return {
      launches: {
        total: stats.emitted, publishable: stats.publishable, lastHour: recentEmits.length, publishableLastHour: recentPublishable.length,
        lastLaunchAt, lastPublishableAt, perHour: [...hours.values()].slice(-24),
      },
      observer: { queued: queue.length, inflight, rechecksWaiting: rechecks.length, concurrency: config.concurrency, maxQueue: config.maxQueue, ...stats, classes: { ...stats.classes } },
    };
  }

  return {
    enqueue, snapshot,
    idle: () => new Promise(resolve => { if (!queue.length && !inflight) resolve(); else waiters.push(resolve); }).then(() => appendChain),
    flushRechecks: () => { while (rechecks.length) queue.push(rechecks.shift()); pump(); },
    async stop() { stopped = true; clearInterval(timer); await appendChain; },
  };
}

// ── Detector (tailer + rule + observer + health) ────────────────────────────

function retryAfterMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : null;
  const at = Date.parse(String(value));
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : null;
}

function createCtLaunchDetector(options = {}) {
  const env = options.env || process.env;
  const config = { ...resolveCtConfig(env), ...(options.config || {}) };
  const siteConfig = { ...require('./live-sites').resolveLiveSitesConfig(env), ...(options.siteConfig || {}) };
  const { dataDir, universeDir } = options;
  if (!dataDir || !universeDir) throw new Error('dataDir and universeDir are required');
  const clock = options.clock || Date.now;
  const sleep = options.sleep || defaultSleep;
  const log = options.log || console;
  const paths = ctPaths(dataDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  const store = options.store || openLaunchStore(paths.db);
  const httpOpts = { fetchImpl: options.fetchImpl || globalThis.fetch, timeoutMs: config.timeoutMs, userAgent: config.userAgent };
  const savedPositions = readJsonSync(paths.positions)?.logs || {};
  const savedState = readJsonSync(paths.state) || {};
  let tailedMs = Number(savedState.tailedMs) || 0;
  const firstStartedAt = savedState.firstStartedAt || new Date(clock()).toISOString();
  const startedAt = new Date(clock()).toISOString();
  let lastTick = clock();
  let running = false;
  const controller = new AbortController();
  const errors = [];
  const counters = { entries: 0, parseErrors: 0, domains: 0, candidates: 0, duplicates: 0, reasons: {} };
  const ruleCounts = {};
  const memo = new Map();
  const tails = new Map();
  const timers = [];
  let index = { lastRefreshAt: null, error: null };
  let logList = { fetchedAt: null, error: null, source: null };
  let lastPositionWrite = 0;
  let positionChain = Promise.resolve();

  function recordError(where, error) {
    const message = String(error?.message || error).slice(0, 300);
    errors.push({ at: new Date(clock()).toISOString(), where, message });
    if (errors.length > 20) errors.shift();
    log.error?.(`[CtLaunches] ${where}: ${message}`);
  }

  const observer = options.observer || createLaunchObserver({
    universeDir, store, config, siteConfig, fetchImpl: options.siteFetchImpl, urlFor: options.urlFor, clock, log, onError: recordError,
  });

  const warmedUp = () => tailedMs >= config.warmupDays * DAY_MS;
  function tick() {
    const t = clock();
    if (running) tailedMs += Math.max(0, t - lastTick);
    lastTick = t;
  }

  function remember(domain) {
    if (!config.memoSize) return false;
    if (memo.has(domain)) { memo.delete(domain); memo.set(domain, 1); return true; }
    memo.set(domain, 1);
    if (memo.size > config.memoSize) memo.delete(memo.keys().next().value);
    return false;
  }

  /** Applies the launch rule to one entry's registrable domains; returns the launches claimed. */
  function processDomains(domains, { ctLog: logName = null, ctSeenAt = null } = {}) {
    const launches = [];
    const nowMs = clock();
    for (const { domain, zone } of domains) {
      counters.domains += 1;
      if (remember(domain)) { counters.duplicates += 1; continue; }
      const verdict = evaluateLaunch({ domain, zone }, { store, config, nowMs, warmedUp: warmedUp() });
      if (!verdict.launch) { counters.reasons[verdict.reason] = (counters.reasons[verdict.reason] || 0) + 1; continue; }
      const job = { domain, zone, rule: verdict.rule, addedDay: verdict.addedDay, ctLog: logName, ctSeenAt: ctSeenAt ? new Date(ctSeenAt).toISOString() : null };
      if (!store.claim(domain, nowMs, job)) { counters.duplicates += 1; continue; }
      counters.candidates += 1;
      ruleCounts[verdict.rule] = (ruleCounts[verdict.rule] || 0) + 1;
      launches.push(job);
      observer.enqueue(job);
    }
    return launches;
  }

  function processEntries(tail, entries) {
    const launches = [];
    for (const entry of entries) {
      counters.entries += 1;
      if (tail) tail.entries += 1;
      if (entry.error) { counters.parseErrors += 1; if (tail) tail.parseErrors += 1; continue; }
      let domains;
      try { domains = ctLog.entryDomains(entry); }
      catch { counters.parseErrors += 1; if (tail) tail.parseErrors += 1; continue; }
      launches.push(...processDomains(domains, { ctLog: tail?.name || null, ctSeenAt: entry.timestamp || null }));
    }
    return launches;
  }

  function positionsBody() {
    const logs = { ...savedPositions };
    for (const tail of tails.values()) {
      if (tail.position === null) continue;
      logs[tail.id] = { name: tail.name, api: tail.api, url: tail.url, position: tail.position, treeSize: tail.treeSize, updatedAt: new Date(clock()).toISOString() };
    }
    return { schema: 'domainscout.ct-positions/v1', logs };
  }

  function persistPositions(force = false) {
    const t = clock();
    if (!force && t - lastPositionWrite < 2000) return positionChain;
    lastPositionWrite = t;
    const body = positionsBody();
    positionChain = positionChain.then(() => atomicJson(paths.positions, body)).catch(error => recordError('positions', error));
    return positionChain;
  }

  function newTail(entry) {
    const saved = savedPositions[entry.id];
    return {
      ...entry,
      client: (options.clientFactory || ctLog.createLogClient)(entry, httpOpts),
      position: Number.isSafeInteger(saved?.position) ? saved.position : null,
      resumed: Number.isSafeInteger(saved?.position),
      treeSize: Number.isSafeInteger(saved?.treeSize) ? saved.treeSize : null,
      entries: 0, parseErrors: 0, requests: 0, errors: 0, consecutiveErrors: 0, skipped: 0,
      lastError: null, lastErrorAt: null, lastHeadAt: null, lastReadAt: null, retired: false, controller: new AbortController(),
    };
  }

  /** One pass of a log: refresh the head when caught up, else read one batch/tile. Returns the delay before the next step. */
  async function stepTail(tail) {
    try {
      if (tail.position === null || tail.treeSize === null || tail.position >= tail.treeSize) {
        tail.requests += 1;
        const head = await tail.client.head();
        tail.treeSize = head.treeSize;
        tail.lastHeadAt = new Date(clock()).toISOString();
        if (tail.position === null) { tail.position = head.treeSize; persistPositions(true); }
        if (tail.position > tail.treeSize) {
          recordError(`log ${tail.name}`, new Error(`stored position ${tail.position} beyond tree size ${tail.treeSize}; restarting at head`));
          tail.position = tail.treeSize;
        }
        if (tail.treeSize - tail.position > config.maxLag) {
          const skip = tail.treeSize - tail.position;
          tail.skipped += skip;
          recordError(`log ${tail.name}`, new Error(`lag ${skip} exceeds ${config.maxLag}; skipped to head (no historical replay)`));
          tail.position = tail.treeSize;
          persistPositions(true);
        }
        tail.consecutiveErrors = 0;
        if (tail.position >= tail.treeSize) return config.pollMs;
      }
      tail.requests += 1;
      const entries = await tail.client.read(tail.position, tail.treeSize, config.batch);
      if (!entries.length) return config.pollMs;
      processEntries(tail, entries);
      tail.position = entries[entries.length - 1].index + 1;
      tail.lastReadAt = new Date(clock()).toISOString();
      tail.consecutiveErrors = 0;
      persistPositions();
      return Math.max(config.requestIntervalMs, (entries.length * 1000) / config.maxEntriesPerSec);
    } catch (error) {
      tail.errors += 1;
      tail.consecutiveErrors += 1;
      tail.lastError = String(error?.message || error).slice(0, 300);
      tail.lastErrorAt = new Date(clock()).toISOString();
      recordError(`log ${tail.name}`, error);
      const hinted = retryAfterMs(error?.retryAfter);
      const backoff = Math.min(config.backoffMaxMs, config.backoffMs * 2 ** Math.min(10, tail.consecutiveErrors - 1));
      return Math.min(config.backoffMaxMs, hinted !== null ? Math.max(hinted, backoff) : backoff);
    }
  }

  async function runTail(tail) {
    while (!controller.signal.aborted && !tail.controller.signal.aborted) {
      const delay = await stepTail(tail);
      await sleep(delay, tail.controller.signal);
    }
  }

  const explicitOnly = () => config.logs.length > 0 && config.logs.every(v => /^(?:rfc6962:|static:)?https?:\/\//i.test(v));

  async function selectCurrentLogs() {
    let list = options.logList || null;
    if (!list && !explicitOnly()) {
      try {
        list = await ctLog.httpGet(config.logListUrl, httpOpts);
        logList = { fetchedAt: new Date(clock()).toISOString(), error: null, source: config.logListUrl };
      } catch (error) {
        logList = { ...logList, error: String(error.message || error) };
        recordError('log list', error);
        return null;
      }
    } else logList = { fetchedAt: new Date(clock()).toISOString(), error: null, source: options.logList ? 'injected' : 'DOMAINSCOUT_CT_LOGS' };
    return ctLog.selectLogs(list || {}, { operators: config.operators, max: config.maxLogs, now: clock() + config.shardOffsetDays * DAY_MS, include: config.logs });
  }

  async function syncLogs() {
    const selected = await selectCurrentLogs();
    if (!selected) return;
    if (!selected.length) recordError('log list', new Error('no usable CT logs selected'));
    const ids = new Set(selected.map(entry => entry.id));
    for (const tail of tails.values()) {
      if (!ids.has(tail.id) && !tail.retired) { tail.retired = true; tail.controller.abort(); }
    }
    for (const entry of selected) {
      if (tails.has(entry.id) && !tails.get(entry.id).retired) continue;
      const tail = newTail(entry);
      tails.set(entry.id, tail);
      tail.loop = runTail(tail).catch(error => recordError(`log ${tail.name}`, error));
    }
  }

  async function refreshIndex() {
    try {
      const result = await refreshRecentIndex({ store, universeDir, windowDays: config.windowDays, now: clock() });
      store.trimFirstSeen(config.firstSeenMax);
      store.pruneEmitted(clock() - config.emittedRetentionDays * DAY_MS);
      index = { ...result, lastRefreshAt: new Date(clock()).toISOString(), error: null };
    } catch (error) {
      index = { ...index, error: String(error.message || error), lastErrorAt: new Date(clock()).toISOString() };
      recordError('zone index', error);
    }
    return index;
  }

  function health() {
    tick();
    const obs = observer.snapshot();
    let storeCounts = null;
    try { storeCounts = store.counts(); } catch (error) { recordError('store', error); }
    return {
      schema: HEALTH_SCHEMA, pid: process.pid, startedAt, firstStartedAt, updatedAt: new Date(clock()).toISOString(),
      tailedMs, warmup: { days: config.warmupDays, complete: warmedUp(), remainingMs: Math.max(0, config.warmupDays * DAY_MS - tailedMs) },
      config: { windowDays: config.windowDays, zonelessZones: config.zonelessZones, batch: config.batch, pollMs: config.pollMs, maxEntriesPerSec: config.maxEntriesPerSec, concurrency: config.concurrency, maxLag: config.maxLag },
      logList,
      logs: [...tails.values()].filter(tail => !tail.retired).map(tail => ({
        id: tail.id, name: tail.name, operator: tail.operator, api: tail.api, url: tail.url,
        position: tail.position, treeSize: tail.treeSize, lag: tail.position !== null && tail.treeSize !== null ? Math.max(0, tail.treeSize - tail.position) : null,
        resumed: tail.resumed, entries: tail.entries, parseErrors: tail.parseErrors, requests: tail.requests, errors: tail.errors,
        consecutiveErrors: tail.consecutiveErrors, skipped: tail.skipped, lastError: tail.lastError, lastErrorAt: tail.lastErrorAt,
        lastHeadAt: tail.lastHeadAt, lastReadAt: tail.lastReadAt,
      })),
      counters: { ...counters, reasons: { ...counters.reasons }, rules: { ...ruleCounts } },
      ...obs,
      index, store: storeCounts,
      memory: { rssMb: Math.round(process.memoryUsage().rss / 1048576), heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576), memo: memo.size },
      errors: errors.slice(),
    };
  }

  async function writeHealth() {
    try {
      const body = health();
      await atomicJson(paths.health, body);
      await atomicJson(paths.state, { firstStartedAt, tailedMs, updatedAt: body.updatedAt });
    } catch (error) { log.error?.(`[CtLaunches] health write failed: ${error.message}`); }
  }

  function every(ms, fn) { const t = setInterval(fn, ms); t.unref?.(); timers.push(t); }

  async function start() {
    running = true;
    lastTick = clock();
    await refreshIndex();
    for (const job of store.pending(config.maxQueue)) if (job?.domain) observer.enqueue(job);
    await syncLogs();
    await writeHealth();
    every(config.healthEveryMs, () => { writeHealth(); });
    every(config.indexRefreshMs, () => { refreshIndex(); });
    every(config.logListRefreshMs, () => { syncLogs().catch(error => recordError('log list', error)); });
    return health();
  }

  async function stop() {
    if (controller.signal.aborted) return;
    tick();
    running = false;
    controller.abort();
    for (const tail of tails.values()) tail.controller.abort();
    for (const t of timers) clearInterval(t);
    await Promise.all([...tails.values()].map(tail => tail.loop).filter(Boolean));
    await persistPositions(true);
    await observer.stop();
    await writeHealth();
    if (!options.store) store.close();
  }

  return { start, stop, health, writeHealth, refreshIndex, processEntries, processDomains, stepTail, newTail, syncLogs, tails, observer, store, config, paths, persistPositions };
}

// ── Server side: health read, public line, supervisor ──────────────────────

async function readCtHealth({ dataDir, env = process.env, now = Date.now, supervisor = null } = {}) {
  const config = resolveCtConfig(env);
  if (!config.enabled) return { status: 'disabled', enabled: false, alerts: [] };
  let record = null;
  try { record = JSON.parse(await fsp.readFile(ctPaths(dataDir).health, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') return { status: 'failed', enabled: true, alerts: [`CT launch health unreadable: ${error.message}`] };
  }
  const worker = supervisor?.state?.() || null;
  const alerts = [];
  if (worker && !worker.running && worker.lastExit) alerts.push(`CT launch worker exited (${worker.lastExit.error || worker.lastExit.signal || `code ${worker.lastExit.code}`}); restart ${worker.nextRestartAt ? `at ${worker.nextRestartAt}` : 'pending'}`);
  if (!record) {
    if (!worker?.running) alerts.push('CT launch detector has not reported health yet');
    return { status: worker?.running ? 'starting' : 'failed', enabled: true, worker, alerts };
  }
  const age = now() - Date.parse(record.updatedAt || 0);
  const staleMs = Math.max(120000, 4 * config.healthEveryMs);
  if (!(age <= staleMs)) alerts.push(`CT launch detector health is stale (${Math.round(age / 1000)}s old)`);
  if (!Array.isArray(record.logs) || !record.logs.length) alerts.push(`CT launch detector follows no logs${record.logList?.error ? `: ${record.logList.error}` : ''}`);
  for (const entry of record.logs || []) {
    if (entry.consecutiveErrors >= 3) alerts.push(`CT log ${entry.name}: ${entry.consecutiveErrors} consecutive errors (${entry.lastError})`);
    if (Number(entry.lag) > config.maxLag / 2) alerts.push(`CT log ${entry.name} is ${entry.lag} entries behind`);
    if (entry.skipped) alerts.push(`CT log ${entry.name} skipped ${entry.skipped} entries to stay near-live`);
  }
  if (record.observer?.dropped) alerts.push(`CT launch observer dropped ${record.observer.dropped} launches (queue full)`);
  if (record.index?.error) alerts.push(`CT launch zone index refresh failed: ${record.index.error}`);
  const status = !(age <= staleMs) ? 'stale' : alerts.length ? 'degraded' : 'ok';
  return { ...record, status, enabled: true, worker, alerts };
}

/** Compact public status for the feed: no domains, logs or errors. */
function publicLiveLine(health, now = Date.now()) {
  if (!health || health.status === 'disabled') return { status: 'off', lastLaunchAt: null, launchesLastHour: 0, warmingUp: false };
  const fresh = !!health.updatedAt && now - Date.parse(health.updatedAt) < 5 * 60000;
  const status = !fresh ? 'stale' : health.status === 'ok' ? 'live' : health.status === 'starting' ? 'starting' : 'degraded';
  return {
    status,
    lastLaunchAt: health.launches?.lastPublishableAt || null,
    launchesLastHour: Number(health.launches?.publishableLastHour) || 0,
    warmingUp: !!health.warmup && !health.warmup.complete,
  };
}

function createCtLaunchSupervisor({ dataDir, universeDir, env = process.env, spawnImpl = spawn, log = console, now = Date.now, restartBaseMs = 30000 } = {}) {
  const config = resolveCtConfig(env);
  let child = null;
  let stopped = false;
  let restarts = 0;
  let lastExit = null;
  let startedAtMs = null;
  let nextRestartAt = null;
  let timer = null;

  function schedule() {
    restarts += 1;
    const delay = Math.min(600000, restartBaseMs * 2 ** Math.min(5, restarts - 1));
    nextRestartAt = new Date(now() + delay).toISOString();
    timer = setTimeout(() => { timer = null; nextRestartAt = null; if (!stopped) launch(); }, delay);
    timer.unref?.();
  }

  function launch() {
    let proc;
    try {
      proc = spawnImpl(process.execPath, [path.join(__dirname, 'ct-launch-worker.js')], {
        env: { ...env, DOMAINSCOUT_DATA_DIR: dataDir, DOMAINSCOUT_UNIVERSE_DIR: universeDir },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (error) {
      lastExit = { error: `spawn failed: ${error.message}`, at: new Date(now()).toISOString() };
      log.error?.(`[CtLaunches] ${lastExit.error}`);
      schedule();
      return;
    }
    child = proc;
    startedAtMs = now();
    proc.once('error', error => { lastExit = { error: error.message, at: new Date(now()).toISOString() }; });
    proc.once('exit', (code, signal) => {
      if (child === proc) child = null;
      lastExit = { code, signal, at: new Date(now()).toISOString(), ...(code === 3 ? { error: 'another CT tailer holds the lock' } : {}) };
      if (stopped) return;
      log.error?.(`[CtLaunches] worker exited ${signal || code}; restarting with backoff`);
      if (now() - startedAtMs > 10 * 60000) restarts = 0;
      schedule();
    });
  }

  const api = {
    enabled: config.enabled,
    start() { if (!config.enabled || stopped || child || timer) return false; launch(); return true; },
    stop() { stopped = true; if (timer) clearTimeout(timer); try { child?.kill('SIGTERM'); } catch { /* gone */ } },
    state: () => ({ running: !!child, pid: child?.pid || null, startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null, restarts, lastExit, nextRestartAt }),
    health: () => readCtHealth({ dataDir, env, now, supervisor: api }),
  };
  return api;
}

module.exports = {
  JOURNAL_FILE, SOURCE, HEALTH_SCHEMA, ctEnabled, resolveCtConfig, ctPaths, openLaunchStore,
  refreshRecentIndex, evaluateLaunch, createLaunchObserver, createCtLaunchDetector,
  readCtHealth, publicLiveLine, createCtLaunchSupervisor, utcDay, shiftDay,
};
