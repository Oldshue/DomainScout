'use strict';

// My names: authoritative-DNS stage for extensions that publish no zone file.
//
// Once a day, for every watched label (owner .com/.ai names), each extension
// that no universe tape covers is asked through its OWN authoritative servers
// (server/authoritative-dns.js: per-server TokenBucket, dns-wire
// classification) whether label.tld is delegated:
//   referral / exact NS      -> delegated
//   authoritative NXDOMAIN   -> not_delegated
//   anything else            -> unknown (never a change)
// Durable per-(label, tld) state lives in <data>/owner-names/dns-state.db. The
// first known answer for a pair is its baseline and is never reported; only a
// not_delegated -> delegated transition is a new registration, dated that day
// and written to <data>/owner-names/dns/<day>/adds.tsv (label\ttld\tday). The
// main lane (server/owner-names.js) ingests that file as source
// 'authoritative-dns'. DNS only: no RDAP/WHOIS. Runs in a child process
// (server/owner-names-dns-worker.js) under a refresh lease; progress persists
// per label chunk, so a killed run resumes where it stopped.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { openSqlite } = require('./ct-launches');

const DNS_SOURCE = 'authoritative-dns';
const LANE = 'owner-names-dns';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const WATCH_TLDS = ['com', 'ai'];

function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function dayDiff(from, to) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS); }
function num(env, name, fallback, min, max) {
  const value = Number(env[name]);
  if (env[name] === undefined || env[name] === '' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function dnsEnabled(env = process.env) {
  return env.DOMAINSCOUT_OWNER_NAMES_ENABLED !== '0' && env.DOMAINSCOUT_OWNER_NAMES_DNS_ENABLED !== '0';
}

function dnsPaths(dataDir) {
  const root = path.join(dataDir, 'owner-names');
  return { root, state: path.join(root, 'dns-state.db'), health: path.join(root, 'dns-health.json'), out: path.join(root, 'dns'), names: path.join(root, 'owner-names.db') };
}

function normalizeTldValue(value) {
  const tld = String(value || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  return /^[a-z0-9-]+$/.test(tld) ? tld : null;
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

/** Zones a universe tape already covers: the newest CZDS zones.json plus every observed-zone fragment retained. */
async function tapeCoveredZones(universeDir) {
  const covered = new Set();
  if (!universeDir) return covered;
  let entries = [];
  try { entries = await fsp.readdir(universeDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return covered; throw error; }
  const days = entries.filter(e => e.isDirectory() && DAY_PATTERN.test(e.name)).map(e => e.name).sort().reverse();
  let czdsFound = false;
  for (const day of days) {
    if (!czdsFound) {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(universeDir, day, 'tape', 'zones.json'), 'utf8'));
        const zones = Array.isArray(raw) ? raw : Array.isArray(raw?.zones) ? raw.zones : Object.keys(raw || {});
        for (const zone of zones) { const tld = normalizeTldValue(zone?.zone || zone?.tld || zone); if (tld) covered.add(tld); }
        czdsFound = true;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    try {
      for (const name of await fsp.readdir(path.join(universeDir, day, 'ns-observed'))) { const tld = normalizeTldValue(name); if (tld) covered.add(tld); }
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  return covered;
}

/** IANA root extensions (server/tld-universe.js) minus tape-covered zones, minus xyz. */
function dnsExtensions({ allTlds, covered = new Set() }) {
  const out = new Set();
  for (const value of allTlds || []) {
    const tld = normalizeTldValue(value);
    if (!tld || tld === 'xyz' || covered.has(tld)) continue;
    out.add(tld);
  }
  return [...out].sort();
}

function ianaTlds() {
  try {
    const universe = require('./tld-universe').getSupportedTldUniverse();
    return { tlds: universe.tlds, source: universe.identity, authoritative: universe.authoritative, version: universe.version };
  } catch (error) {
    const list = require('./tlds-list');
    const source = list.getTldSource();
    return { tlds: list.getCheckTlds(), source: source.identity, authoritative: !!source.authoritative, version: source.version, fallbackReason: error.message };
  }
}

/** Owner store -> Map<label, Set<owned tld>> for labels held as .com or .ai. */
function loadWatchedLabels(storePath) {
  if (!fs.existsSync(storePath)) return new Map();
  const { db } = openSqlite(storePath, { readonly: true });
  try {
    const rows = db.prepare('SELECT label, tld FROM owner_names').all();
    const watched = new Map();
    for (const row of rows) if (WATCH_TLDS.includes(row.tld)) watched.set(row.label, new Set());
    for (const row of rows) if (watched.has(row.label)) watched.get(row.label).add(row.tld);
    return watched;
  } finally { db.close(); }
}

function openDnsState(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const { db } = openSqlite(file);
  for (const pragma of ['journal_mode = WAL', 'synchronous = NORMAL', 'busy_timeout = 5000']) {
    try { db.exec(`PRAGMA ${pragma}`); } catch { /* :memory: */ }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pair_state (label TEXT NOT NULL, tld TEXT NOT NULL, state TEXT NOT NULL, since_day TEXT NOT NULL, checked_day TEXT NOT NULL,
      PRIMARY KEY (label, tld)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS events (label TEXT NOT NULL, tld TEXT NOT NULL, day TEXT NOT NULL, recorded_at TEXT NOT NULL,
      PRIMARY KEY (label, tld, day)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS events_day ON events(day);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
  `);
  const q = {
    forLabel: db.prepare('SELECT tld, state, since_day, checked_day FROM pair_state WHERE label = ?'),
    put: db.prepare(`INSERT INTO pair_state (label, tld, state, since_day, checked_day) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(label, tld) DO UPDATE SET state = excluded.state, since_day = excluded.since_day, checked_day = excluded.checked_day`),
    touch: db.prepare('UPDATE pair_state SET checked_day = ? WHERE label = ? AND tld = ?'),
    event: db.prepare('INSERT OR IGNORE INTO events (label, tld, day, recorded_at) VALUES (?, ?, ?, ?)'),
    dayEvents: db.prepare('SELECT label, tld FROM events WHERE day = ? ORDER BY label, tld'),
    metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
    metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };
  return { db, q };
}

function inTransaction(db, fn) {
  db.exec('BEGIN');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* none */ } throw error; }
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await fn(items[index]); }
  }));
  return out;
}

function defaultProbe(db, env, concurrency) {
  const { createAuthoritativeResolver } = require('./authoritative-dns');
  const qps = num(env, 'DOMAINSCOUT_OWNER_NAMES_DNS_PER_SERVER_QPS', 10, 0.1, 1000);
  const resolver = createAuthoritativeResolver({
    enabled: true, database: db,
    retries: Math.trunc(num(env, 'DOMAINSCOUT_OWNER_NAMES_DNS_RETRIES', 1, 0, 5)),
    timeoutMs: Math.trunc(num(env, 'DOMAINSCOUT_OWNER_NAMES_DNS_TIMEOUT_MS', 2000, 200, 30000)),
    perServerQps: qps, perServerBurst: Math.max(1, Math.ceil(qps)), maxInFlight: Math.max(64, concurrency * 4),
  });
  return { probe: name => resolver.probe(name), close: () => resolver.close() };
}

function classify(result) {
  if (result?.status === 'taken') return { status: 'delegated' };
  if (result?.status === 'not_taken') return { status: 'not_delegated' };
  return { status: 'unknown', reason: String(result?.reason || 'unknown').split(':')[0] };
}

/**
 * One daily sweep. Options are injectable for tests: probe (async name ->
 * { status: 'taken'|'not_taken'|'unknown' }), allTlds, watched, statePath.
 */
async function runOwnerNamesDnsSweep(options = {}) {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const log = options.log || console;
  const paths = dnsPaths(options.dataDir || '.');
  const statePath = options.statePath || paths.state;
  const healthPath = options.healthPath || paths.health;
  const outRoot = options.outRoot || paths.out;
  const day = options.day || utcDay(now());
  if (!DAY_PATTERN.test(day)) throw new Error(`Invalid sweep day ${day}`);
  const force = !!options.force;
  const concurrency = Math.trunc(options.concurrency || num(env, 'DOMAINSCOUT_OWNER_NAMES_DNS_CONCURRENCY', 32, 1, 512));
  const chunkLabels = Math.trunc(options.chunkLabels || num(env, 'DOMAINSCOUT_OWNER_NAMES_DNS_CHUNK_LABELS', 16, 1, 10000));
  const isoNow = () => new Date(now()).toISOString();
  const { db, q } = openDnsState(statePath);
  let prober = null;
  let progress = null;
  const writeHealth = async patch => {
    const previous = (await readJson(healthPath).catch(() => null)) || {};
    await atomicWrite(healthPath, JSON.stringify({ ...previous, ...patch, updatedAt: isoNow() }, null, 1));
  };
  const writeDayFile = async () => {
    const rows = q.dayEvents.all(day);
    await atomicWrite(path.join(outRoot, day, 'adds.tsv'), rows.map(r => `${r.label}\t${r.tld}\t${day}\n`).join(''));
    return rows.length;
  };
  try {
    if (!force && q.metaGet.get('last_complete_day')?.value === day) return { skipped: 'complete', day };
    const watched = options.watched || loadWatchedLabels(options.storePath || paths.names);
    const iana = options.allTlds ? { tlds: options.allTlds, source: 'injected', authoritative: true } : ianaTlds();
    const covered = options.covered || await tapeCoveredZones(options.universeDir);
    const tlds = dnsExtensions({ allTlds: iana.tlds, covered });
    const labels = [...watched.keys()].sort();
    let total = 0;
    for (const label of labels) total += tlds.filter(tld => !watched.get(label).has(tld)).length;
    let stored = null;
    try { stored = JSON.parse(q.metaGet.get('progress')?.value || 'null'); } catch { stored = null; }
    progress = stored && stored.day === day && !force ? stored
      : { day, done: 0, delegated: 0, nxdomain: 0, unknown: 0, reported: 0, baselined: 0, reasons: {}, startedAt: isoNow() };
    Object.assign(progress, { total, labels: labels.length, tlds: tlds.length, coveredByTapes: covered.size, tldSource: iana.source, tldSourceAuthoritative: !!iana.authoritative });
    const healthBase = () => ({
      ...progress, status: 'running', phase: 'probing', error: null, source: DNS_SOURCE,
      unknownShare: progress.done ? progress.unknown / progress.done : 0,
      firstPassComplete: !!q.metaGet.get('first_complete_day')?.value,
      lastCompleteDay: q.metaGet.get('last_complete_day')?.value || null,
    });
    await writeHealth({ ...healthBase(), finishedAt: null });
    prober = options.probe ? { probe: options.probe, close() {} } : defaultProbe(db, env, concurrency);
    for (let start = 0; start < labels.length; start += chunkLabels) {
      const tasks = [];
      for (const label of labels.slice(start, start + chunkLabels)) {
        const owned = watched.get(label);
        const prior = new Map(q.forLabel.all(label).map(row => [row.tld, row]));
        for (const tld of tlds) {
          if (owned.has(tld)) continue;
          const prev = prior.get(tld) || null;
          if (!force && prev && prev.checked_day === day) continue; // done by an interrupted run of this day
          tasks.push({ label, tld, prev });
        }
      }
      if (!tasks.length) continue;
      const results = await pool(tasks, concurrency, async task => {
        try { return classify(await prober.probe(`${task.label}.${task.tld}`)); }
        catch (error) { return { status: 'unknown', reason: `probe-error` }; }
      });
      let reportedNow = 0;
      const at = isoNow();
      inTransaction(db, () => {
        tasks.forEach((task, index) => {
          const { status, reason } = results[index];
          const { label, tld, prev } = task;
          progress.done += 1;
          if (status === 'unknown') {
            progress.unknown += 1;
            progress.reasons[reason] = (progress.reasons[reason] || 0) + 1;
            if (prev) q.touch.run(day, label, tld); else q.put.run(label, tld, 'unknown', day, day);
            return;
          }
          if (status === 'delegated') progress.delegated += 1; else progress.nxdomain += 1;
          if (!prev || prev.state === 'unknown') { q.put.run(label, tld, status, day, day); progress.baselined += 1; return; }
          if (prev.state === status) { q.touch.run(day, label, tld); return; }
          q.put.run(label, tld, status, day, day);
          if (prev.state === 'not_delegated' && status === 'delegated') {
            reportedNow += q.event.run(label, tld, day, at).changes;
          }
        });
        progress.reported += reportedNow;
        q.metaSet.run('progress', JSON.stringify(progress));
      });
      if (reportedNow) await writeDayFile();
      await writeHealth(healthBase());
    }
    const reported = await writeDayFile();
    inTransaction(db, () => {
      q.metaSet.run('last_complete_day', day);
      if (!q.metaGet.get('first_complete_day')?.value) q.metaSet.run('first_complete_day', day);
      q.metaSet.run('progress', JSON.stringify(progress));
    });
    const finishedAt = isoNow();
    await writeHealth({ ...healthBase(), status: 'ok', phase: 'complete', firstPassComplete: true, lastCompleteDay: day, finishedAt, reportedToday: reported });
    log.log?.(`[OwnerNamesDns] ${day}: ${progress.done}/${progress.total} probed, ${progress.unknown} unknown, ${reported} new registrations`);
    return { day, complete: true, ...progress, reportedToday: reported, finishedAt };
  } catch (error) {
    await writeHealth({ status: 'failed', phase: 'failed', day, error: error.message, finishedAt: isoNow() }).catch(() => {});
    throw error;
  } finally {
    try { prober?.close?.(); } catch { /* closed */ }
    try { db.close(); } catch { /* closed */ }
  }
}

// ── Supervisor (main process): spawns the worker under a refresh lease ──

function createOwnerNamesDnsSupervisor(options = {}) {
  const env = options.env || process.env;
  const dataDir = options.dataDir;
  const universeDir = options.universeDir;
  const now = options.now || Date.now;
  const log = options.log || console;
  const spawnImpl = options.spawnImpl || require('child_process').spawn;
  const killImpl = options.killImpl || process.kill.bind(process);
  const enabled = options.enabled !== undefined ? !!options.enabled : dnsEnabled(env);
  const paths = dnsPaths(dataDir);
  let leases = options.leaseManager || null;
  const leaseManager = () => (leases ||= require('./refresh-lease').createRefreshLeaseManager({ root: path.join(dataDir, 'refresh-leases') }));
  const runTimeoutMs = num(env, 'DOMAINSCOUT_OWNER_NAMES_DNS_RUN_TIMEOUT_MS', 20 * 3600000, 60000, 7 * DAY_MS);
  const policy = { maxHeartbeatAgeMs: 5 * 60000, terminationGraceMs: 10000, maxRunAgeMs: runTimeoutMs + 60000 };
  const unknownAlertShare = num(env, 'DOMAINSCOUT_OWNER_NAMES_DNS_UNKNOWN_ALERT', 0.25, 0, 1);

  async function start({ day = utcDay(now()), force = false } = {}) {
    if (!enabled) return { skipped: 'disabled' };
    const health = await readJson(paths.health).catch(() => null);
    if (!force && health?.status === 'ok' && health.lastCompleteDay === day) return { skipped: 'complete', day };
    let lease;
    try { lease = leaseManager().reserve(LANE, { day }); }
    catch (error) { if (error.code === 'EEXIST') return { skipped: 'running', day }; throw error; }
    try {
      const child = spawnImpl(process.execPath, [path.join(__dirname, 'owner-names-dns-worker.js'), day, force ? 'force' : ''], {
        detached: true,
        env: { ...env, DOMAINSCOUT_DATA_DIR: dataDir, DOMAINSCOUT_UNIVERSE_DIR: universeDir, DOMAINSCOUT_REFRESH_LEASE_PATH: lease.filePath, DOMAINSCOUT_REFRESH_LEASE_TOKEN: lease.token },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      leaseManager().activate(LANE, lease.token, child.pid, { processGroup: true });
      const timer = setTimeout(() => { try { killImpl(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, runTimeoutMs);
      timer.unref?.();
      let finished = false;
      const finish = async error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) {
          log.error?.(`[OwnerNamesDns] ${error}`);
          const h = (await readJson(paths.health).catch(() => null)) || {};
          if (h.status !== 'failed') await atomicWrite(paths.health, JSON.stringify({ ...h, status: 'failed', error, finishedAt: new Date(now()).toISOString() }, null, 1)).catch(() => {});
        }
        leaseManager().release(LANE, lease.token);
        if (typeof options.onComplete === 'function' && !error) {
          try { options.onComplete({ day }); } catch (e) { log.error?.(`[OwnerNamesDns] onComplete failed: ${e.message}`); }
        }
      };
      child.once('error', error => finish(error.message));
      child.once('exit', (code, signal) => finish(code === 0 ? null : `DNS sweep worker exited ${signal || code}; it resumes on the next run`));
      return { started: true, day, pid: child.pid };
    } catch (error) {
      leaseManager().release(LANE, lease.token);
      throw error;
    }
  }

  async function health() {
    if (!enabled) return { enabled: false, status: 'disabled', source: DNS_SOURCE, alerts: [] };
    const h = (await readJson(paths.health).catch(error => ({ status: 'failed', error: `health unreadable: ${error.message}` }))) || { status: 'idle' };
    let lease = null;
    try { lease = leaseManager().inspect(LANE, policy); } catch { lease = null; }
    const today = utcDay(now());
    const alerts = [];
    let status = h.status || 'idle';
    if (status === 'running' && !lease) { status = 'failed'; alerts.push('My names DNS sweep was interrupted; it resumes from saved progress on the next run'); }
    if (status === 'failed' && h.error) alerts.push(`My names DNS sweep failed: ${h.error}`);
    const behindDays = h.lastCompleteDay ? Math.max(0, dayDiff(h.lastCompleteDay, today)) : (h.startedAt ? Math.max(0, dayDiff(String(h.startedAt).slice(0, 10), today)) : 0);
    if (behindDays > 1 && (h.labels || 0) > 0) alerts.push(`My names DNS sweep is ${behindDays} days behind (last complete ${h.lastCompleteDay || 'never'})`);
    const unknownShare = h.done ? h.unknown / h.done : 0;
    if (h.done >= 20 && unknownShare > unknownAlertShare) alerts.push(`My names DNS sweep unknown share ${(unknownShare * 100).toFixed(1)}% exceeds ${(unknownAlertShare * 100).toFixed(0)}%`);
    return { enabled: true, source: DNS_SOURCE, ...h, status, unknownShare, behindDays, progressShare: h.total ? Math.min(1, (h.done || 0) / h.total) : null,
      worker: lease ? { pid: lease.pid, heartbeatAt: lease.heartbeatAt } : null, alerts };
  }

  return { enabled, start, health, paths };
}

module.exports = {
  DNS_SOURCE, LANE, dnsEnabled, dnsPaths, tapeCoveredZones, dnsExtensions, loadWatchedLabels, openDnsState,
  runOwnerNamesDnsSweep, createOwnerNamesDnsSupervisor,
};
