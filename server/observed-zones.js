'use strict';

// Observed zones: a delegation snapshot for TLDs whose registry publishes no
// zone file (ccTLDs such as .si). For each name in the zone's durable roster we
// ask the TLD's OWN authoritative servers for the NS delegation (referral =
// delegated with that NS set; authoritative NXDOMAIN = not delegated; anything
// else = unknown) and write the answers as canonical zone lines
// (`name.\t<ttl>\tin\tns\t<host>.`, byte-ordered by owner name). The snapshot
// is then handed to the SAME captureZone/diffZoneDelegations path as a CZDS
// download, so movement, tapes and Sale Watch ingestion are shared.
//
// Unknown answers never fabricate movement: the previous day's NS lines for
// that name are carried forward, and a day whose unknown share exceeds the
// configured ratio is a failed capture that publishes nothing.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const { PREFIX, getJson, putJson, restoreFile, captureZone } = require('./universe-snapshots');
const { delegations } = require('./zone-ns-movement');
const { TokenBucket } = require('./authoritative-dns');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST = /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9])?$/;
const ROSTER_SCHEMA = 'domainscout.observed-roster/v1';
const RUN_SCHEMA = 'domainscout.observed-zone/v1';
const SNAPSHOT_TTL = 86400;
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function expectedDay(now = new Date()) {
  return require('./universe-puller').expectedDay(now);
}

function num(env, name, fallback, min) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function normalizeTld(value) {
  const tld = String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9-]+$/.test(tld) ? tld : null;
}

function observedZones(env = process.env) {
  const raw = env.DOMAINSCOUT_OBSERVED_ZONES === undefined ? 'si' : env.DOMAINSCOUT_OBSERVED_ZONES;
  return [...new Set(String(raw).split(',').map(normalizeTld).filter(Boolean))];
}

function observedConfig(env = process.env) {
  return {
    zones: observedZones(env),
    qps: num(env, 'DOMAINSCOUT_OBSERVED_QPS', 40, 0.1),
    concurrency: Math.floor(num(env, 'DOMAINSCOUT_OBSERVED_CONCURRENCY', 16, 1)),
    retries: Math.floor(num(env, 'DOMAINSCOUT_OBSERVED_RETRIES', 2, 0)),
    backoffMs: num(env, 'DOMAINSCOUT_OBSERVED_BACKOFF_MS', 500, 0),
    timeoutMs: Math.floor(num(env, 'DOMAINSCOUT_OBSERVED_TIMEOUT_MS', 2000, 200)),
    maxUnknownRatio: num(env, 'DOMAINSCOUT_OBSERVED_MAX_UNKNOWN_RATIO', 0.05, 0),
    retireAfterDays: Math.floor(num(env, 'DOMAINSCOUT_OBSERVED_RETIRE_NXDOMAIN_DAYS', 30, 1)),
    maxRoster: Math.floor(num(env, 'DOMAINSCOUT_OBSERVED_MAX_ROSTER', 2000000, 1)),
    ctWindowDays: Math.floor(num(env, 'DOMAINSCOUT_OBSERVED_CT_WINDOW_DAYS', 7, 1)),
    ctMaxWindows: Math.floor(num(env, 'DOMAINSCOUT_OBSERVED_CT_MAX_WINDOWS', 8, 0)),
    ctBackfillDays: Math.floor(num(env, 'DOMAINSCOUT_OBSERVED_CT_BACKFILL_DAYS', 400, 0)),
    ctPaceMs: num(env, 'DOMAINSCOUT_OBSERVED_CT_PACE_MS', 5000, 0),
    runTimeoutMs: num(env, 'DOMAINSCOUT_OBSERVED_RUN_TIMEOUT_MS', 4 * 3600000, 60000),
  };
}

// `label.tld` only (the delegation level the TLD servers answer for).
function normalizeRosterName(value, tld) {
  const name = String(value || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.+$/, '');
  if (!name.endsWith('.' + tld)) return null;
  const label = name.slice(0, -tld.length - 1);
  return LABEL.test(label) ? name : null;
}

function dayShift(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isMissing(error) {
  return error && (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.code === 'ENOENT'
    || error.$metadata?.httpStatusCode === 404);
}

// ── Roster (durable, object store) ──────────────────────────────────────────
function emptyRoster(tld) {
  return { schema: ROSTER_SCHEMA, tld, updatedAt: null, lastObservedDay: null, names: new Map(), retired: new Map(), feeders: {}, cursors: {} };
}

const rosterKey = (prefix, tld) => `${prefix}/observed/${tld}/roster.json.gz`;

async function loadRoster(store, prefix, tld) {
  let buffer;
  try { buffer = await store.get(rosterKey(prefix, tld)); }
  catch (error) { if (isMissing(error)) return emptyRoster(tld); throw error; }
  const raw = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'));
  if (raw.schema !== ROSTER_SCHEMA || raw.tld !== tld || !Array.isArray(raw.names)) throw new Error(`Invalid observed roster for .${tld}`);
  const roster = emptyRoster(tld);
  roster.updatedAt = raw.updatedAt || null;
  roster.lastObservedDay = raw.lastObservedDay || null;
  roster.feeders = raw.feeders || {};
  roster.cursors = raw.cursors || {};
  for (const [name, firstSeen, lastDelegated, nxStreak, sources] of raw.names) {
    roster.names.set(name, { firstSeen, lastDelegated: lastDelegated || null, nxStreak: Number(nxStreak) || 0, sources: sources || [] });
  }
  for (const [name, day] of raw.retired || []) roster.retired.set(name, day);
  return roster;
}

async function saveRoster(store, prefix, roster, now = () => new Date()) {
  roster.updatedAt = new Date(now()).toISOString();
  const names = [...roster.names.keys()].sort().map(name => {
    const e = roster.names.get(name);
    return [name, e.firstSeen, e.lastDelegated, e.nxStreak, e.sources];
  });
  const body = {
    schema: ROSTER_SCHEMA, tld: roster.tld, updatedAt: roster.updatedAt, lastObservedDay: roster.lastObservedDay,
    feeders: roster.feeders, cursors: roster.cursors, names, retired: [...roster.retired.entries()].sort(),
  };
  await store.put(rosterKey(prefix, roster.tld), zlib.gzipSync(JSON.stringify(body)), 'application/gzip');
}

// Merges one feeder's names. Names already present only gain the source tag;
// retired names come back only from feeders that report fresh evidence.
function mergeIntoRoster(roster, values, { source, day, maxRoster = Infinity, fresh = false } = {}) {
  let offered = 0, valid = 0, added = 0, skippedRetired = 0, capped = 0;
  for (const value of values || []) {
    offered += 1;
    const name = normalizeRosterName(value, roster.tld);
    if (!name) continue;
    valid += 1;
    const existing = roster.names.get(name);
    if (existing) {
      if (source && !existing.sources.includes(source) && existing.sources.length < 8) existing.sources.push(source);
      continue;
    }
    if (roster.retired.has(name) && !fresh) { skippedRetired += 1; continue; }
    if (roster.names.size >= maxRoster) { capped += 1; continue; }
    roster.retired.delete(name);
    roster.names.set(name, { firstSeen: day, lastDelegated: null, nxStreak: 0, sources: source ? [source] : [] });
    added += 1;
  }
  return { offered, valid, added, skippedRetired, capped };
}

// Feeders are { name, fresh?, collect(ctx) -> { names, cursor? } }. A feeder
// failure is recorded on the roster and never blocks the capture.
async function runFeeders(roster, feeders, ctx) {
  const report = {};
  for (const feeder of feeders) {
    const startedAt = Date.now();
    try {
      const result = await feeder.collect({ ...ctx, tld: roster.tld, cursor: roster.cursors[feeder.name] || null, roster });
      const merged = mergeIntoRoster(roster, result?.names || [], { source: feeder.name, day: ctx.day, maxRoster: ctx.maxRoster, fresh: !!feeder.fresh });
      if (result && result.cursor !== undefined) roster.cursors[feeder.name] = result.cursor;
      report[feeder.name] = { ...merged, at: new Date(ctx.now()).toISOString(), ms: Date.now() - startedAt, error: result?.error || null, detail: result?.detail || null };
    } catch (error) {
      report[feeder.name] = { offered: 0, valid: 0, added: 0, at: new Date(ctx.now()).toISOString(), ms: Date.now() - startedAt, error: error.message };
      ctx.log?.error?.(`[ObservedZones] feeder ${feeder.name} for .${roster.tld} failed: ${error.message}`);
    }
  }
  roster.feeders = report;
  return report;
}

// Feeder (a): names of the zone already present in DomainScout's stores on
// the data volume. Missing databases/tables are reported, not fatal.
const STORE_QUERIES = [
  ['domains.db', 'domains', "SELECT domain AS name FROM domains WHERE domain LIKE @like"],
  ['domains.db', 'sibling_tld_status', "SELECT base_name || '.' || @tld AS name FROM sibling_tld_status WHERE tld IN (@tld, @dotTld) AND status = 'taken'"],
  ['domains.db', 'cctld_taken_idx', "SELECT base_name || '.' || @tld AS name FROM cctld_taken_idx WHERE tld IN (@tld, @dotTld)"],
  ['sale_watch.db', 'sale_watch_candidates', "SELECT domain AS name FROM sale_watch_candidates WHERE domain LIKE @like"],
  ['sale_watch.db', 'sale_watch_observations', "SELECT DISTINCT domain AS name FROM sale_watch_observations WHERE domain LIKE @like"],
  ['sale_watch.db', 'site_evidence', "SELECT domain AS name FROM site_evidence WHERE domain LIKE @like"],
  ['zone_index.db', 'research_prefix_hits', "SELECT DISTINCT base_name || '.' || @tld AS name FROM research_prefix_hits WHERE tld IN (@tld, @dotTld)"],
];

function createStoreFeeder({ dataDir, queries = STORE_QUERIES } = {}) {
  return {
    name: 'stores',
    async collect({ tld }) {
      const Database = require('better-sqlite3');
      const names = new Set();
      const detail = {};
      const byFile = new Map();
      for (const [file, label, sql] of queries) {
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push([label, sql]);
      }
      for (const [file, list] of byFile) {
        const full = path.join(dataDir, file);
        if (!fs.existsSync(full)) { for (const [label] of list) detail[label] = 'missing-database'; continue; }
        let db;
        try {
          db = new Database(full, { readonly: true, fileMustExist: true });
          db.pragma('busy_timeout = 10000');
          for (const [label, sql] of list) {
            try {
              let count = 0;
              for (const row of db.prepare(sql).iterate({ like: `%.${tld}`, tld, dotTld: '.' + tld })) { names.add(row.name); count += 1; }
              detail[label] = count;
            } catch (error) { detail[label] = `error: ${error.message}`; }
          }
        } catch (error) {
          for (const [label] of list) detail[label] = `error: ${error.message}`;
        } finally { try { db?.close(); } catch (_) {} }
      }
      return { names, detail };
    },
  };
}

// Feeder (b): certificate transparency through the existing crt.sh discovery
// code, walked in dated windows. The cursor only advances past a window that
// crt.sh actually answered, so outages resume where they stopped.
function createCtFeeder({ config, fetchWindow, sleep = defaultSleep } = {}) {
  const fetcher = fetchWindow || (async (tld, from, to) => {
    const { fetchDiscoveryForTLD } = require('../scrapers/crtsh');
    const rows = await fetchDiscoveryForTLD('.' + tld, { notBefore: from, notAfter: to, tlds: ['.' + tld], throwOnError: true });
    return rows.map(row => row.domain);
  });
  return {
    name: 'crt.sh',
    fresh: true,
    async collect({ tld, cursor, now }) {
      const today = new Date(now()).toISOString().slice(0, 10);
      const floor = dayShift(today, -config.ctBackfillDays);
      const next = { ...(cursor || {}) };
      const names = [];
      const windows = [];
      let error = null;
      while (windows.length < config.ctMaxWindows) {
        let from, to, direction;
        if (!next.newest || next.newest < today) {
          from = next.newest || dayShift(today, -config.ctWindowDays);
          to = dayShift(from, config.ctWindowDays) < today ? dayShift(from, config.ctWindowDays) : today;
          direction = 'forward';
        } else if ((next.oldest || today) > floor) {
          to = next.oldest || today;
          from = dayShift(to, -config.ctWindowDays) > floor ? dayShift(to, -config.ctWindowDays) : floor;
          direction = 'backfill';
        } else break;
        if (windows.length) await sleep(config.ctPaceMs);
        try {
          const found = await fetcher(tld, from, to);
          names.push(...found);
          windows.push({ from, to, direction, names: found.length });
        } catch (e) {
          error = `crt.sh ${from}..${to}: ${e.message}`;
          break;
        }
        if (direction === 'forward') { next.newest = to; if (!next.oldest || next.oldest > from) next.oldest = from; }
        else next.oldest = from;
      }
      return { names, cursor: next, error, detail: { windows } };
    },
  };
}

// ── Authoritative observation ───────────────────────────────────────────────
function createRateLimiter(qps, { now = Date.now, sleep = defaultSleep } = {}) {
  const bucket = new TokenBucket(qps, Math.max(1, Math.ceil(qps)), now);
  return async () => {
    for (;;) {
      const wait = bucket.tryTake();
      if (wait === 0) return;
      await sleep(Math.min(wait, 1000));
    }
  };
}

// Default probe: authoritative-direct NS queries via server/authoritative-dns.js
// (raw UDP, dns-wire classification). TLD servers are discovered from DNS at
// run time and load is spread round-robin across them; the observed run adds
// its own global rate limit and retries, so the resolver itself never retries
// or degrades the TLD.
function createAuthoritativeProbe(config) {
  const { createAuthoritativeResolver } = require('./authoritative-dns');
  const resolver = createAuthoritativeResolver({
    enabled: true, retries: 0, timeoutMs: config.timeoutMs,
    perServerQps: config.qps, perServerBurst: Math.max(1, Math.ceil(config.qps)),
    healthMaxUnknownRatio: 1.01, maxInFlight: Math.max(64, config.concurrency * 4),
  });
  return {
    probe: name => resolver.probe(name),
    async servers(tld) { return (await resolver.serversFor(tld)).servers.length; },
    close: () => resolver.close(),
  };
}

function cleanHosts(values) {
  return [...new Set((values || []).map(v => String(v || '').trim().toLowerCase().replace(/\.+$/, '')).filter(h => HOST.test(h)))].sort();
}

async function observeNames({ names, probe, config, limiter, sleep = defaultSleep, onProgress = () => {} }) {
  const results = new Array(names.length);
  const counts = { queried: names.length, delegated: 0, nxdomain: 0, unknown: 0, retried: 0, reasons: {} };
  let next = 0, done = 0;
  async function worker() {
    while (next < names.length) {
      const index = next++;
      let result;
      for (let attempt = 0; attempt <= config.retries; attempt += 1) {
        if (attempt) { counts.retried += 1; await sleep(config.backoffMs * 2 ** (attempt - 1)); }
        if (limiter) await limiter();
        try { result = await probe(names[index]); }
        catch (error) { result = { status: 'unknown', reason: `probe-error:${error.message}` }; }
        if (!result || !['taken', 'not_taken', 'unknown'].includes(result.status)) result = { status: 'unknown', reason: result?.reason || 'invalid-probe-result' };
        if (result.status === 'taken') {
          const hosts = cleanHosts(result.nameservers);
          result = hosts.length ? { status: 'taken', nameservers: hosts } : { status: 'unknown', reason: 'referral-without-ns' };
        }
        if (result.status !== 'unknown') break;
      }
      results[index] = result;
      if (result.status === 'taken') counts.delegated += 1;
      else if (result.status === 'not_taken') counts.nxdomain += 1;
      else {
        counts.unknown += 1;
        const reason = String(result.reason || 'unknown').split(':')[0];
        counts.reasons[reason] = (counts.reasons[reason] || 0) + 1;
      }
      done += 1;
      if (done % 1000 === 0) onProgress({ phase: 'observing', done, total: names.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.concurrency, Math.max(1, names.length)) }, worker));
  return { results, counts };
}

// Canonical zone text in owner byte order. Unknown answers carry the previous
// day's NS set forward so the diff records no change for them.
function synthesizeSnapshot({ names, results, previous = new Map() }) {
  const order = names.map((name, index) => [name, index]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let text = '', carriedForward = 0, lines = 0;
  for (const [name, index] of order) {
    const result = results[index];
    let hosts = [];
    if (result.status === 'taken') hosts = result.nameservers;
    else if (result.status === 'unknown' && previous.has(name)) { hosts = previous.get(name); carriedForward += 1; }
    for (const host of hosts) { text += `${name}.\t${SNAPSHOT_TTL}\tin\tns\t${host}.\n`; lines += 1; }
  }
  return { text, carriedForward, lines };
}

async function readPreviousDelegations(file, tld) {
  const map = new Map();
  for await (const entry of delegations(file, { zone: tld })) map.set(entry.name, entry.ns);
  return map;
}

function applyObservationToRoster(roster, names, results, { day, retireAfterDays }) {
  let retired = 0;
  if (roster.lastObservedDay === day) return { retired, alreadyApplied: true };
  names.forEach((name, index) => {
    const entry = roster.names.get(name);
    const result = results[index];
    if (!entry || !result) return;
    if (result.status === 'taken') { entry.lastDelegated = day; entry.nxStreak = 0; }
    else if (result.status === 'not_taken') {
      entry.nxStreak += 1;
      if (entry.nxStreak >= retireAfterDays) { roster.names.delete(name); roster.retired.set(name, day); retired += 1; }
    }
  });
  roster.lastObservedDay = day;
  return { retired, alreadyApplied: false };
}

// ── Health ──────────────────────────────────────────────────────────────────
const healthDir = dataDir => path.join(dataDir, 'universe', 'observed');
const healthFile = (dataDir, tld) => path.join(healthDir(dataDir), `${tld}.health.json`);

async function readJsonFile(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeJsonFile(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.part`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}

async function observedHealth({ dataDir, env = process.env, now = () => new Date() } = {}) {
  const day = expectedDay(new Date(now()));
  const zones = {};
  const alerts = [];
  for (const tld of observedZones(env)) {
    const record = await readJsonFile(healthFile(dataDir, tld)).catch(error => ({ status: 'failed', failureReason: `health unreadable: ${error.message}` }));
    zones[tld] = record || { tld, status: 'missing', lastGoodDay: null };
    const lastGood = zones[tld].lastGoodDay || null;
    zones[tld].stale = lastGood !== day;
    if (lastGood !== day) {
      const reason = zones[tld].status === 'failed' && zones[tld].failureReason ? ` (${zones[tld].failureReason})` : zones[tld].status === 'running' ? ' (capture running)' : '';
      alerts.push(`Observed zone .${tld}: no good observed day for ${day}; latest ${lastGood || 'none'}${reason}`);
    }
  }
  return { expectedDay: day, zones, alerts };
}

// ── Runner (one TLD, one day) ───────────────────────────────────────────────
function createObservedZoneRunner(options = {}) {
  const env = options.env || process.env;
  const now = options.now || (() => new Date());
  const log = options.log || console;
  const sleep = options.sleep || defaultSleep;
  const dataDir = options.dataDir;
  const universeDir = options.universeDir;
  const store = options.objectStore === undefined ? require('./recent-registration-corpus').createS3ObjectStore(env) : options.objectStore;
  const prefix = env.DOMAINSCOUT_UNIVERSE_S3_PREFIX || PREFIX;
  const config = { ...observedConfig(env), ...(options.config || {}) };
  const capture = options.captureZone || captureZone;
  const scratchRoot = env.DOMAINSCOUT_UNIVERSE_SCRATCH_DIR || path.join(os.tmpdir(), 'domainscout-universe-v2');

  async function runZone({ tld: rawTld, day = expectedDay(new Date(now())), force = false } = {}) {
    const tld = normalizeTld(rawTld);
    if (!tld || !config.zones.includes(tld)) throw Object.assign(new Error(`Not a configured observed zone: ${rawTld || ''}`), { statusCode: 400 });
    if (!DAY.test(day)) throw Object.assign(new Error('Invalid observed day'), { statusCode: 400 });
    const started = Date.now();
    const startedAt = new Date(now()).toISOString();
    const previousHealth = await readJsonFile(healthFile(dataDir, tld)).catch(() => null);
    const health = {
      schema: 'domainscout.observed-zone-health/v1', tld, day, status: 'running', phase: 'starting',
      lastGoodDay: previousHealth?.lastGoodDay || null, startedAt, finishedAt: null,
      attempts: previousHealth?.day === day ? (previousHealth.attempts || 0) + 1 : 1,
      rosterSize: null, queried: 0, delegated: 0, nxdomain: 0, unknown: 0, unknownRatio: null, carriedForward: 0,
      retired: 0, rosterAdded: 0, durationMs: null, failureReason: null, baseline: null, movement: null, feeders: null,
      config: { qps: config.qps, concurrency: config.concurrency, retries: config.retries, maxUnknownRatio: config.maxUnknownRatio },
    };
    const writeHealth = patch => { Object.assign(health, patch); return writeJsonFile(healthFile(dataDir, tld), health); };
    const scratch = path.join(scratchRoot, `observed-${tld}-${day}`);
    let prober = null;
    try {
      await writeHealth({});
      if (!store) throw new Error('Evidence object storage is required for observed zones');
      const latestKey = `${prefix}/observed/${tld}/latest.json`;
      const latest = await getJson(store, latestKey);
      if (latest?.complete && latest.day === day && !force) {
        await publishLocal(tld, latest);
        await writeHealth({ ...(latest.health || {}), status: 'ok', phase: 'complete', lastGoodDay: day, finishedAt: new Date(now()).toISOString(), failureReason: null });
        return { tld, day, complete: true, skipped: 'complete' };
      }
      if (latest?.day > day) throw new Error(`Observed .${tld} already has a later day ${latest.day}`);
      const previous = latest?.complete ? (latest.day < day ? { receipt: latest.receipt, day: latest.day } : latest.previous || null) : null;

      await writeHealth({ phase: 'roster' });
      const roster = await loadRoster(store, prefix, tld);
      const before = roster.names.size;
      const feeders = options.feeders || [createStoreFeeder({ dataDir }), createCtFeeder({ config, sleep })];
      const feederReport = await runFeeders(roster, feeders, { day, now, env, log, dataDir, maxRoster: config.maxRoster });
      await saveRoster(store, prefix, roster, now);
      const names = [...roster.names.keys()].sort();
      await writeHealth({ rosterSize: names.length, rosterAdded: roster.names.size - before, feeders: feederReport });
      if (!names.length) throw new Error(`Observed .${tld} roster is empty; no names to observe`);

      await fsp.rm(scratch, { recursive: true, force: true });
      await fsp.mkdir(scratch, { recursive: true });
      let previousMap = new Map();
      if (previous?.receipt?.snapshot) {
        await writeHealth({ phase: 'previous' });
        const priorPath = path.join(scratch, 'previous-delegations.gz');
        await restoreFile(store, previous.receipt.snapshot, priorPath, AbortSignal.timeout(30 * 60000));
        previousMap = await readPreviousDelegations(priorPath, tld);
      }

      await writeHealth({ phase: 'observing' });
      prober = options.probe ? { probe: options.probe } : (options.probeFactory || createAuthoritativeProbe)(config);
      const limiter = options.limiter || createRateLimiter(config.qps, { sleep });
      const { results, counts } = await observeNames({
        names, probe: prober.probe, config, limiter, sleep,
        onProgress: progress => { health.progress = progress; writeJsonFile(healthFile(dataDir, tld), health).catch(() => {}); },
      });
      const unknownRatio = counts.unknown / counts.queried;
      const snapshot = synthesizeSnapshot({ names, results, previous: previousMap });
      await writeHealth({
        queried: counts.queried, delegated: counts.delegated, nxdomain: counts.nxdomain, unknown: counts.unknown,
        unknownReasons: counts.reasons, retried: counts.retried, unknownRatio, carriedForward: snapshot.carriedForward,
      });
      if (unknownRatio > config.maxUnknownRatio) {
        throw new Error(`Unknown share ${(unknownRatio * 100).toFixed(2)}% exceeds ${(config.maxUnknownRatio * 100).toFixed(2)}% (${counts.unknown}/${counts.queried}); capture not published`);
      }

      await writeHealth({ phase: 'capturing' });
      const gz = zlib.gzipSync(snapshot.text);
      const runId = crypto.randomUUID();
      const receipt = await capture({
        store, prefix: `${prefix}/observed`, runId, day, zone: tld, scratch,
        previous: previous ? { ...previous.receipt, day: previous.day } : null,
        onProgress: progress => { health.progress = progress; },
        signal: AbortSignal.timeout(config.runTimeoutMs),
        openSource: async () => ({ body: Readable.from([gz]), lastModified: null }),
      });
      const applied = applyObservationToRoster(roster, names, results, { day, retireAfterDays: config.retireAfterDays });
      await saveRoster(store, prefix, roster, now);
      const stats = {
        rosterSize: names.length, queried: counts.queried, delegated: counts.delegated, nxdomain: counts.nxdomain,
        unknown: counts.unknown, unknownRatio, carriedForward: snapshot.carriedForward, retired: applied.retired,
      };
      const manifest = {
        schema: RUN_SCHEMA, tld, day, runId, complete: true, baseline: !receipt.diff,
        receipt, previous, stats, observedAt: new Date(now()).toISOString(),
        movement: receipt.diff ? { prevDay: receipt.diff.prevDay, departures: receipt.diff.departures, wentLive: receipt.diff.wentLive, listed: receipt.diff.listed, counts: receipt.diff.counts } : null,
      };
      await putJson(store, `${prefix}/observed/${tld}/runs/${day}/${runId}/manifest.json`, manifest);
      await putJson(store, latestKey, manifest);
      await writeHealth({ phase: 'publishing', baseline: manifest.baseline, movement: manifest.movement, retired: applied.retired });
      await publishLocal(tld, manifest);
      await writeHealth({ status: 'ok', phase: 'complete', lastGoodDay: day, finishedAt: new Date(now()).toISOString(), durationMs: Date.now() - started, failureReason: null });
      manifest.health = { ...health };
      if (options.onPublished) {
        try { await options.onPublished({ day, tld, directory: universeDir }); }
        catch (error) { log.error?.(`[ObservedZones] .${tld} Sale Watch ingest failed: ${error.message}`); await writeHealth({ ingestError: error.message }); }
      }
      return { tld, day, complete: true, baseline: manifest.baseline, stats, movement: manifest.movement };
    } catch (error) {
      await writeHealth({ status: 'failed', finishedAt: new Date(now()).toISOString(), durationMs: Date.now() - started, failureReason: error.message }).catch(() => {});
      log.error?.(`[ObservedZones] .${tld} ${day} failed: ${error.message}`);
      return { tld, day, complete: false, error: error.message };
    } finally {
      try { prober?.close?.(); } catch (_) {}
      await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Local fragment beside the CZDS tape: <universeDir>/<day>/ns-observed/<tld>/.
  async function publishLocal(tld, manifest) {
    const target = path.join(universeDir, manifest.day, 'ns-observed', tld);
    const staged = `${target}.staging-${manifest.runId}`;
    await fsp.rm(staged, { recursive: true, force: true });
    await fsp.mkdir(staged, { recursive: true });
    const diff = manifest.receipt.diff;
    for (const [key, file] of [['movement', 'movement.jsonl'], ['adds', 'adds.tsv'], ['drops', 'drops.tsv']]) {
      if (diff?.[key]) await restoreFile(store, diff[key], path.join(staged, file), AbortSignal.timeout(10 * 60000));
      else await fsp.writeFile(path.join(staged, file), '');
    }
    await writeJsonFile(path.join(staged, 'summary.json'), {
      day: manifest.day, runId: manifest.runId, tld, source: 'observed-zone', zones: 1,
      prevDay: manifest.movement?.prevDay || null, baseline: manifest.baseline, complete: true,
      departures: manifest.movement?.departures || 0, wentLive: manifest.movement?.wentLive || 0, listed: manifest.movement?.listed || 0,
      totals: manifest.movement?.counts || {}, observed: manifest.stats,
    });
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(staged, target);
  }

  return { runZone, config };
}

// ── Supervisor: one leased child process per TLD, isolated from CZDS ───────
function createObservedZoneSupervisor({ dataDir, universeDir, env = process.env, spawnImpl = spawn, leaseManager, now = () => new Date(), killImpl = (pid, signal) => process.kill(pid, signal), log = console } = {}) {
  const { createRefreshLeaseManager } = require('./refresh-lease');
  const leases = leaseManager || createRefreshLeaseManager({ root: path.join(dataDir, 'refresh-leases') });
  const config = observedConfig(env);
  const policy = { maxHeartbeatAgeMs: 5 * 60000, terminationGraceMs: 10000, maxRunAgeMs: config.runTimeoutMs };
  const lane = tld => `observed-zone-${tld}`;

  function running(tld) { return !!leases.inspect(lane(tld), policy); }

  async function runZone({ tld: rawTld, force = false } = {}) {
    const tld = normalizeTld(rawTld);
    if (!tld || !config.zones.includes(tld)) throw Object.assign(new Error(`Not a configured observed zone: ${rawTld || ''}`), { statusCode: 400 });
    const day = expectedDay(new Date(now()));
    if (running(tld)) return { skipped: 'running', tld, day };
    const health = await readJsonFile(healthFile(dataDir, tld)).catch(() => null);
    if (!force && health?.status === 'ok' && health.lastGoodDay === day) return { skipped: 'complete', tld, day };
    let lease;
    try { lease = leases.reserve(lane(tld), { day }); }
    catch (error) { if (error.code === 'EEXIST') return { skipped: 'running', tld, day }; throw error; }
    try {
      const child = spawnImpl(process.execPath, [path.join(__dirname, 'observed-zone-worker.js'), tld, day, force ? 'force' : ''], {
        detached: true,
        env: { ...env, DOMAINSCOUT_DATA_DIR: dataDir, DOMAINSCOUT_UNIVERSE_DIR: universeDir, DOMAINSCOUT_REFRESH_LEASE_PATH: lease.filePath, DOMAINSCOUT_REFRESH_LEASE_TOKEN: lease.token },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      leases.activate(lane(tld), lease.token, child.pid, { processGroup: true });
      const timer = setTimeout(() => { try { killImpl(-child.pid, 'SIGKILL'); } catch (_) {} }, config.runTimeoutMs + 60000);
      timer.unref?.();
      let finished = false;
      const finish = async (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) {
          const h = (await readJsonFile(healthFile(dataDir, tld)).catch(() => null)) || { tld };
          if (h.status !== 'failed') await writeJsonFile(healthFile(dataDir, tld), { ...h, status: 'failed', failureReason: error, finishedAt: new Date(now()).toISOString() }).catch(() => {});
        }
        leases.release(lane(tld), lease.token);
      };
      child.once('error', error => finish(error.message));
      child.once('exit', (code, signal) => finish(code === 0 ? null : `Observed zone worker exited ${signal || code}`));
      return { started: true, tld, day, pid: child.pid };
    } catch (error) {
      leases.release(lane(tld), lease.token);
      throw error;
    }
  }

  async function status(rawTld) {
    const tld = normalizeTld(rawTld);
    if (!tld || !config.zones.includes(tld)) throw Object.assign(new Error(`Not a configured observed zone: ${rawTld || ''}`), { statusCode: 400 });
    const record = await readJsonFile(healthFile(dataDir, tld));
    return { tld, expectedDay: expectedDay(new Date(now())), running: running(tld), health: record || null };
  }

  async function runAll() {
    const results = [];
    for (const tld of config.zones) {
      try { results.push(await runZone({ tld })); }
      catch (error) { log.error?.(`[ObservedZones] .${tld} failed to start: ${error.message}`); results.push({ tld, error: error.message }); }
    }
    return results;
  }

  return { runZone, runAll, status, health: () => observedHealth({ dataDir, env, now }), isRunning: running, zones: config.zones };
}

// ── Routes ──────────────────────────────────────────────────────────────────
function registerObservedZoneRoutes(app, supervisor, { env = process.env } = {}) {
  const { importAuthorized } = require('./universe-lane');
  const guard = (handler) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      if (!importAuthorized(req, env)) return res.status(401).json({ error: 'Unauthorized observed-zone request' });
      await handler(req, res);
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || 'Observed-zone request failed' });
    }
  };
  app.post('/api/universe/observed/run', guard(async (req, res) => {
    const force = ['1', 'true'].includes(String(req.query?.force || ''));
    const result = await supervisor.runZone({ tld: req.query?.tld, force });
    if (result.skipped === 'running') return res.status(409).json({ error: 'already running', ...result });
    if (result.skipped === 'complete') return res.json({ complete: true, ...result });
    res.status(202).json(result);
  }));
  app.get('/api/universe/observed/status', guard(async (req, res) => {
    res.json(await supervisor.status(req.query?.tld));
  }));
}

module.exports = {
  ROSTER_SCHEMA, RUN_SCHEMA, STORE_QUERIES,
  observedZones, observedConfig, normalizeRosterName,
  emptyRoster, loadRoster, saveRoster, mergeIntoRoster, runFeeders,
  createStoreFeeder, createCtFeeder, createRateLimiter, createAuthoritativeProbe,
  observeNames, synthesizeSnapshot, applyObservationToRoster, readPreviousDelegations,
  observedHealth, healthFile, createObservedZoneRunner, createObservedZoneSupervisor, registerObservedZoneRoutes,
};
