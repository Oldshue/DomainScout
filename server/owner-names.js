'use strict';

// My names: new extensions.
//
// The owner's held .com/.ai names (one durable SQLite store on the data volume,
// <dataDir>/owner-names/owner-names.db) are matched against the registration
// universe the deployment already has. Nothing here polls RDAP/WHOIS per
// label x extension; every stage reads an existing lane's published output:
//
//   czds          <universeDir>/<day>/tape/adds.tsv (universe pull lane,
//                 server/universe-lane.js / universe-puller.js), label\tzone\tdate
//   observed:<tld> <universeDir>/<day>/ns-observed/<tld>/adds.tsv, located through
//                 universe-lane.dayMovementTapes (server/observed-zones.js)
//   nrd           zone_daily_new_names in zone_index.db for every day with an
//                 nrd_import_receipts row (server/nrd-importer.js, WhoisDS feed)
//   ct            <universeDir>/<UTC day>/sites/ct-launches.jsonl
//                 (server/ct-launches.js near-live first sightings)
//
// A match is a newly registered domain whose first label exactly equals a
// watched label (punycode, case-insensitive), in any extension other than .xyz
// and other than the extensions the owner holds for that label. Every source
// that saw a domain is recorded (match_sources); reads dedupe by domain and use
// the earliest day. Rows are never deleted when a source day ages out. Removing
// an owner name hides its matches at read time; adding one rescans every
// retained day (list_version).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { domainToASCII } = require('url');
const { dayMovementTapes } = require('./universe-lane');
const { JOURNAL_FILE, openSqlite } = require('./ct-launches');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WATCH_TLDS = Object.freeze(['com', 'ai']);
const EXCLUDED_TLDS = Object.freeze(['xyz']);
const MAX_NAMES = 100000;
const MAX_WINDOW_DAYS = 3650;
const DAY_MS = 86400000;
const LABEL_PART = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function ownerNamesEnabled(env = process.env) {
  return env.DOMAINSCOUT_OWNER_NAMES_ENABLED !== '0';
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function shiftDay(day, delta) { return utcDay(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS); }
function dayDiff(from, to) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS); }

function isExcludedTld(tld) {
  const value = String(tld || '');
  return EXCLUDED_TLDS.some(x => value === x || value.endsWith(`.${x}`));
}

function asciiLabel(label) {
  const value = String(label || '').trim().toLowerCase();
  if (!/[^\x00-\x7f]/.test(value)) return value;
  const ascii = domainToASCII(`${value}.com`);
  return ascii ? ascii.slice(0, -4) : '';
}

/** Any domain spelling (URL, www., unicode, trailing dot) -> { domain, label, tld } in punycode, or null. */
function normalizeDomain(raw) {
  let value = String(raw || '').trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
  if (value.startsWith('www.') && value.split('.').length > 2) value = value.slice(4);
  if (!value) return null;
  const ascii = domainToASCII(value);
  if (!ascii || ascii.length > 253) return null;
  const parts = ascii.split('.');
  if (parts.length < 2 || parts.some(part => !LABEL_PART.test(part)) || !/[a-z]/.test(parts.at(-1))) return null;
  return { domain: ascii, label: parts[0], tld: parts.slice(1).join('.') };
}

/** JSON array, { domains: [...] }, JSON text, or newline/comma/space separated text -> string[]. */
function parseNameInput(body) {
  if (Array.isArray(body)) return body.map(String);
  if (body && typeof body === 'object') {
    if (Array.isArray(body.domains)) return body.domains.map(String);
    if (typeof body.text === 'string') return parseNameInput(body.text);
    throw requestError('Send a JSON array of domains, { "domains": [...] }, or newline-separated text');
  }
  const text = String(body ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw requestError('Body looks like JSON but does not parse'); }
    return parseNameInput(parsed);
  }
  return text.split(/[\s,;]+/).filter(Boolean);
}

/** watched: Map<label, Set<owned tld>>. */
function isMatch(watched, label, tld) {
  const owned = watched.get(label);
  if (!owned || !tld || isExcludedTld(tld)) return false;
  return !owned.has(tld);
}

function splitDomain(raw) {
  const value = String(raw || '').trim().toLowerCase().replace(/\.+$/, '');
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  return { label: asciiLabel(value.slice(0, dot)), tld: value.slice(dot + 1) };
}

function clampInt(value, fallback, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || value === undefined || value === null || value === '') return fallback;
  return Math.max(min, Math.min(max, n));
}

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));

// Explicit transaction that works on both sqlite drivers openSqlite may return.
function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const { db } = openSqlite(file);
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* :memory: */ }
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_names (domain TEXT PRIMARY KEY, label TEXT NOT NULL, tld TEXT NOT NULL, added_at TEXT NOT NULL) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS owner_names_label ON owner_names(label);
    CREATE TABLE IF NOT EXISTS match_sources (
      domain TEXT NOT NULL, source TEXT NOT NULL, day TEXT NOT NULL, label TEXT NOT NULL, tld TEXT NOT NULL, recorded_at TEXT NOT NULL,
      PRIMARY KEY (domain, source, day)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS match_sources_label ON match_sources(label, day);
    CREATE INDEX IF NOT EXISTS match_sources_day ON match_sources(day);
    CREATE TABLE IF NOT EXISTS scans (
      source TEXT NOT NULL, day TEXT NOT NULL, signature TEXT NOT NULL, list_version INTEGER NOT NULL, matched INTEGER NOT NULL, scanned_at TEXT NOT NULL,
      PRIMARY KEY (source, day)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS stage_errors (
      source TEXT NOT NULL, day TEXT NOT NULL, error TEXT NOT NULL, at TEXT NOT NULL, attempts INTEGER NOT NULL,
      PRIMARY KEY (source, day)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
  `);
  const q = {
    metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
    metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    nameRows: db.prepare('SELECT label, tld FROM owner_names'),
    nameCount: db.prepare('SELECT COUNT(*) AS n FROM owner_names'),
    watchedCount: db.prepare(`SELECT COUNT(DISTINCT label) AS n FROM owner_names WHERE tld IN ('com','ai')`),
    nameGet: db.prepare('SELECT domain FROM owner_names WHERE domain = ?'),
    nameInsert: db.prepare('INSERT OR IGNORE INTO owner_names (domain, label, tld, added_at) VALUES (?, ?, ?, ?)'),
    nameDelete: db.prepare('DELETE FROM owner_names WHERE domain = ?'),
    allDomains: db.prepare('SELECT domain FROM owner_names'),
    listNames: db.prepare(`SELECT domain, label, tld, added_at FROM owner_names WHERE (@q = '' OR instr(domain, @q) > 0) ORDER BY domain LIMIT @limit OFFSET @offset`),
    countNames: db.prepare(`SELECT COUNT(*) AS n FROM owner_names WHERE (@q = '' OR instr(domain, @q) > 0)`),
    ownersByLabel: db.prepare(`SELECT label, domain FROM owner_names WHERE tld IN ('com','ai') ORDER BY domain`),
    scanGet: db.prepare('SELECT signature, list_version FROM scans WHERE source = ? AND day = ?'),
    scanPut: db.prepare('INSERT OR REPLACE INTO scans (source, day, signature, list_version, matched, scanned_at) VALUES (?, ?, ?, ?, ?, ?)'),
    matchPut: db.prepare('INSERT OR IGNORE INTO match_sources (domain, source, day, label, tld, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'),
    errorPut: db.prepare(`INSERT INTO stage_errors (source, day, error, at, attempts) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(source, day) DO UPDATE SET error = excluded.error, at = excluded.at, attempts = attempts + 1`),
    errorClear: db.prepare('DELETE FROM stage_errors WHERE source = ? AND day = ?'),
    errors: db.prepare('SELECT source, day, error, at, attempts FROM stage_errors ORDER BY at DESC LIMIT 50'),
    scannedBySource: db.prepare('SELECT source, MAX(day) AS day FROM scans WHERE list_version = ? GROUP BY source'),
    matchedBySource: db.prepare('SELECT source, MAX(day) AS day, COUNT(DISTINCT domain) AS n FROM match_sources GROUP BY source'),
    visible: db.prepare(`
      SELECT ms.domain AS domain, ms.label AS label, ms.tld AS tld, MIN(ms.day) AS first_seen, group_concat(DISTINCT ms.source) AS sources
      FROM match_sources ms
      WHERE EXISTS (SELECT 1 FROM owner_names o WHERE o.label = ms.label AND o.tld IN ('com','ai'))
        AND NOT EXISTS (SELECT 1 FROM owner_names o2 WHERE o2.domain = ms.domain)
        AND ms.tld != 'xyz' AND ms.tld NOT LIKE '%.xyz'
      GROUP BY ms.domain
      HAVING MIN(ms.day) >= @since`),
  };
  return { db, q };
}

function createOwnerNamesLane(options = {}) {
  const env = options.env || process.env;
  const dataDir = options.dataDir || null;
  const universeDir = options.universeDir || null;
  const storePath = options.storePath || path.join(dataDir || '.', 'owner-names', 'owner-names.db');
  const zoneDbPath = options.zoneDbPath !== undefined ? options.zoneDbPath : (dataDir ? path.join(dataDir, 'zone_index.db') : null);
  // Daily adds published by the authoritative-DNS sweep (server/owner-names-dns.js).
  const dnsDir = options.dnsDir !== undefined ? options.dnsDir : (dataDir ? path.join(dataDir, 'owner-names', 'dns') : null);
  const now = options.now || Date.now;
  const log = options.log || console;
  const enabled = options.enabled !== undefined ? !!options.enabled : ownerNamesEnabled(env);
  const nrdPageSize = options.nrdPageSize || 5000;
  let store = null;
  let zoneDb = null;
  let running = false;
  let rerun = false;
  let lastRun = null;
  let scheduled = null;

  const S = () => (store ||= openStore(storePath));
  const isoNow = () => new Date(now()).toISOString();
  const listVersion = () => Number(S().q.metaGet.get('list_version')?.value || 0);
  const bumpVersion = () => S().q.metaSet.run('list_version', String(listVersion() + 1));

  function openZoneDb() {
    if (zoneDb) return zoneDb;
    if (options.openZoneDb) return (zoneDb = options.openZoneDb());
    if (!zoneDbPath || !fs.existsSync(zoneDbPath)) return null;
    zoneDb = openSqlite(zoneDbPath, { readonly: true }).db;
    zoneDb.exec('PRAGMA busy_timeout = 30000');
    return zoneDb;
  }

  function loadWatched() {
    const rows = S().q.nameRows.all();
    const watched = new Map();
    for (const row of rows) if (WATCH_TLDS.includes(row.tld)) watched.set(row.label, new Set());
    for (const row of rows) if (watched.has(row.label)) watched.get(row.label).add(row.tld);
    return watched;
  }

  // ── Owner name list ──

  function normalizeAll(values) {
    const accepted = new Map();
    const rejected = [];
    for (const raw of values) {
      const parsed = normalizeDomain(raw);
      if (parsed) accepted.set(parsed.domain, parsed); else if (String(raw).trim()) rejected.push(String(raw).slice(0, 120));
    }
    if (accepted.size > MAX_NAMES) throw requestError(`At most ${MAX_NAMES} names are supported`, 413);
    return { accepted, rejected };
  }

  function afterChange(added) {
    if (added) { bumpVersion(); schedule('list-change'); }
  }

  function replaceNames(body) {
    const { accepted, rejected } = normalizeAll(parseNameInput(body));
    const { db, q } = S();
    const at = isoNow();
    const result = inTransaction(db, () => {
      let added = 0;
      let removed = 0;
      for (const { domain } of q.allDomains.all()) if (!accepted.has(domain)) { q.nameDelete.run(domain); removed += 1; }
      for (const n of accepted.values()) added += q.nameInsert.run(n.domain, n.label, n.tld, at).changes;
      return { added, removed };
    });
    afterChange(result.added > 0);
    return { ...result, total: q.nameCount.get().n, watchedLabels: q.watchedCount.get().n, rejectedCount: rejected.length, rejected: rejected.slice(0, 20) };
  }

  function addName(raw) {
    const parsed = normalizeDomain(raw);
    if (!parsed) throw requestError('Not a valid domain name');
    const { q } = S();
    if (q.nameCount.get().n >= MAX_NAMES && !q.nameGet.get(parsed.domain)) throw requestError(`At most ${MAX_NAMES} names are supported`, 413);
    const added = q.nameInsert.run(parsed.domain, parsed.label, parsed.tld, isoNow()).changes > 0;
    afterChange(added);
    return { ...parsed, added, watchSource: WATCH_TLDS.includes(parsed.tld), total: q.nameCount.get().n };
  }

  function removeName(raw) {
    const parsed = normalizeDomain(raw);
    if (!parsed) throw requestError('Not a valid domain name');
    const removed = S().q.nameDelete.run(parsed.domain).changes > 0;
    return { domain: parsed.domain, removed, total: S().q.nameCount.get().n };
  }

  function listNames(input = {}) {
    const qText = String(input.q || '').trim().toLowerCase();
    const limit = clampInt(input.limit, 500, 1, 5000);
    const offset = clampInt(input.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const { q } = S();
    const total = q.countNames.get({ q: qText }).n;
    const items = q.listNames.all({ q: qText, limit, offset }).map(row => ({
      domain: row.domain, label: row.label, extension: row.tld, watchSource: WATCH_TLDS.includes(row.tld), addedAt: row.added_at,
    }));
    return { total, watchedLabels: q.watchedCount.get().n, items, nextCursor: offset + items.length < total ? offset + items.length : null };
  }

  // ── Source stages ──

  function nrdDays() {
    const db = openZoneDb();
    if (!db) return [];
    try {
      return db.prepare('SELECT report_date, source_digest, completed_at FROM nrd_import_receipts').all();
    } catch (error) {
      if (/no such table/.test(error.message)) return [];
      throw error;
    }
  }

  async function inventory() {
    const stages = [];
    const failures = [];
    let entries = [];
    if (universeDir) {
      try { entries = await fsp.readdir(universeDir, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') failures.push({ source: 'universe', day: '*', error }); }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !DAY_PATTERN.test(entry.name)) continue;
      const day = entry.name;
      const files = [['czds', path.join(universeDir, day, 'tape', 'adds.tsv'), 'tsv']];
      try {
        for (const tape of dayMovementTapes(universeDir, day)) {
          if (tape.source !== 'czds') files.push([tape.source, path.join(path.dirname(tape.tape), 'adds.tsv'), 'tsv']);
        }
      } catch (error) { failures.push({ source: 'observed', day, error }); }
      files.push(['ct', path.join(universeDir, day, 'sites', JOURNAL_FILE), 'ct']);
      for (const [source, file, kind] of files) {
        try {
          const stat = await fsp.stat(file);
          stages.push({ source, day, kind, file, signature: `${stat.size}:${Math.trunc(stat.mtimeMs)}` });
        } catch (error) { if (error.code !== 'ENOENT') failures.push({ source, day, error }); }
      }
    }
    try {
      for (const row of nrdDays()) {
        if (DAY_PATTERN.test(String(row.report_date))) stages.push({ source: 'nrd', day: row.report_date, kind: 'nrd', signature: `${row.source_digest}:${row.completed_at}` });
      }
    } catch (error) { failures.push({ source: 'nrd', day: '*', error }); }
    if (dnsDir) {
      let dnsEntries = [];
      try { dnsEntries = await fsp.readdir(dnsDir, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') failures.push({ source: 'authoritative-dns', day: '*', error }); }
      for (const entry of dnsEntries) {
        if (!entry.isDirectory() || !DAY_PATTERN.test(entry.name)) continue;
        const file = path.join(dnsDir, entry.name, 'adds.tsv');
        try {
          const stat = await fsp.stat(file);
          stages.push({ source: 'authoritative-dns', day: entry.name, kind: 'tsv', file, signature: `${stat.size}:${Math.trunc(stat.mtimeMs)}` });
        } catch (error) { if (error.code !== 'ENOENT') failures.push({ source: 'authoritative-dns', day: entry.name, error }); }
      }
    }
    stages.sort((a, b) => b.day.localeCompare(a.day) || a.source.localeCompare(b.source));
    return { stages, failures };
  }

  async function scanLines(file, onLine) {
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let count = 0;
    try {
      for await (const line of lines) {
        if (line) onLine(line);
        if (++count % 50000 === 0) await yieldLoop();
      }
    } finally { lines.close(); input.destroy(); }
  }

  async function scanStage(stage, watched) {
    const found = new Map();
    const consider = (rawLabel, rawTld) => {
      const label = asciiLabel(rawLabel);
      const tld = String(rawTld || '').trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
      if (isMatch(watched, label, tld)) found.set(`${label}.${tld}`, { label, tld });
    };
    if (stage.kind === 'tsv') {
      await scanLines(stage.file, line => {
        const fields = line.split('\t');
        if (fields[0] && fields[1]) consider(fields[0], fields[1]);
      });
    } else if (stage.kind === 'ct') {
      await scanLines(stage.file, line => {
        const hit = /"domain":"([^"\\]+)"/.exec(line);
        let domain = hit?.[1];
        if (!domain) { try { domain = JSON.parse(line).domain; } catch { return; } }
        const parts = splitDomain(domain);
        if (parts) consider(parts.label, parts.tld);
      });
    } else if (stage.kind === 'nrd') {
      const db = openZoneDb();
      if (!db) throw new Error('zone_index.db is unavailable');
      const page = db.prepare(`SELECT tld, base_name FROM zone_daily_new_names
        WHERE report_date = @day AND (tld > @tld OR (tld = @tld AND base_name > @name))
        ORDER BY tld, base_name LIMIT @limit`);
      let cursor = { tld: '', name: '' };
      for (;;) {
        const rows = page.all({ day: stage.day, tld: cursor.tld, name: cursor.name, limit: nrdPageSize });
        for (const row of rows) consider(row.base_name, row.tld);
        if (rows.length < nrdPageSize) break;
        cursor = { tld: rows.at(-1).tld, name: rows.at(-1).base_name };
        await yieldLoop();
      }
    } else {
      throw new Error(`Unknown stage kind ${stage.kind}`);
    }
    return found;
  }

  function recordError(source, day, error) {
    const message = String(error?.message || error).slice(0, 500);
    const at = isoNow();
    S().q.errorPut.run(source, day, message, at);
    S().q.metaSet.run('last_error', JSON.stringify({ source, day, message, at }));
    log.warn?.(`[OwnerNames] ${source} ${day} failed: ${message}`);
  }

  async function pass(reason) {
    const started = Date.now();
    const version = listVersion();
    const watched = loadWatched();
    const summary = { reason, startedAt: isoNow(), listVersion: version, watchedLabels: watched.size, stages: 0, scanned: 0, skipped: 0, failed: 0, newMatches: 0 };
    if (!watched.size) return { ...summary, finishedAt: isoNow(), durationMs: Date.now() - started };
    const { stages, failures } = await inventory();
    for (const failure of failures) { recordError(failure.source, failure.day, failure.error); summary.failed += 1; }
    summary.stages = stages.length;
    const { db, q } = S();
    for (const stage of stages) {
      const prior = q.scanGet.get(stage.source, stage.day);
      if (prior && prior.signature === stage.signature && prior.list_version === version) { summary.skipped += 1; continue; }
      try {
        const found = await scanStage(stage, watched);
        const at = isoNow();
        let added = 0;
        inTransaction(db, () => {
          for (const [domain, m] of found) added += q.matchPut.run(domain, stage.source, stage.day, m.label, m.tld, at).changes;
          q.scanPut.run(stage.source, stage.day, stage.signature, version, found.size, at);
          q.errorClear.run(stage.source, stage.day);
        });
        summary.scanned += 1;
        summary.newMatches += added;
      } catch (error) {
        summary.failed += 1;
        recordError(stage.source, stage.day, error);
      }
      if (listVersion() !== version) { rerun = true; break; }
    }
    return { ...summary, finishedAt: isoNow(), durationMs: Date.now() - started };
  }

  // A run requested while one is in flight joins it (and forces one more pass
  // so newly landed days or list changes are picked up); totals are summed.
  let current = null;
  function run({ reason = 'manual' } = {}) {
    if (!enabled) return Promise.resolve({ skipped: 'disabled' });
    if (current) { rerun = true; return current; }
    current = (async () => {
      running = true;
      try {
        let total = null;
        do {
          rerun = false;
          const result = await pass(reason);
          total = total
            ? { ...result, startedAt: total.startedAt, passes: total.passes + 1, scanned: total.scanned + result.scanned, failed: total.failed + result.failed, newMatches: total.newMatches + result.newMatches }
            : { ...result, passes: 1 };
          lastRun = total;
          S().q.metaSet.run('last_run', JSON.stringify(total));
        } while (rerun);
        S().q.errorClear.run('lane', '*');
        if (total.newMatches || total.failed) log.log?.(`[OwnerNames] ${reason}: ${JSON.stringify(total)}`);
        return total;
      } catch (error) {
        recordError('lane', '*', error);
        throw error;
      } finally {
        running = false;
        current = null;
      }
    })();
    return current;
  }

  /** Background trigger: never blocks the caller, coalesces bursts. */
  function schedule(reason = 'trigger') {
    if (!enabled) return false;
    if (scheduled) return true;
    scheduled = setImmediate(() => {
      scheduled = null;
      run({ reason }).catch(error => log.error?.(`[OwnerNames] ${reason} run failed: ${error.message}`));
    });
    scheduled.unref?.();
    return true;
  }

  // ── Reads ──

  function windowRows(days) {
    const today = utcDay(now());
    const since = shiftDay(today, -(days - 1));
    const rows = S().q.visible.all({ since });
    const extsByLabel = new Map();
    for (const row of rows) {
      if (!extsByLabel.has(row.label)) extsByLabel.set(row.label, new Set());
      extsByLabel.get(row.label).add(row.tld);
    }
    const owners = new Map();
    for (const row of S().q.ownersByLabel.all()) {
      if (!owners.has(row.label)) owners.set(row.label, []);
      owners.get(row.label).push(row.domain);
    }
    const items = rows.map(row => ({
      domain: row.domain, label: row.label, extension: row.tld, firstSeen: row.first_seen,
      sources: String(row.sources || '').split(',').filter(Boolean).sort(),
      ownerNames: owners.get(row.label) || [],
      otherExtensionsInWindow: (extsByLabel.get(row.label)?.size || 1) - 1,
      url: `https://${row.domain}/`,
    })).sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.domain.localeCompare(b.domain));
    return { today, since, items };
  }

  function ownerFilter(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw.includes('.')) {
      const parsed = normalizeDomain(raw);
      if (!parsed) throw requestError('owner is not a valid name');
      return parsed.label;
    }
    const label = asciiLabel(raw);
    if (!LABEL_PART.test(label)) throw requestError('owner is not a valid name');
    return label;
  }

  function extFilter(value) {
    const ext = String(value || '').trim().toLowerCase().replace(/^\./, '');
    if (ext && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(ext)) throw requestError('ext is invalid');
    return ext;
  }

  function matches(input = {}) {
    const days = clampInt(input.days, 30, 1, MAX_WINDOW_DAYS);
    const ext = extFilter(input.ext);
    const owner = ownerFilter(input.owner);
    const qText = String(input.q || '').trim().toLowerCase();
    const qAscii = qText ? (normalizeDomain(qText)?.domain || asciiLabel(qText) || qText) : '';
    const limit = clampInt(input.limit, 50, 1, 500);
    const cursor = clampInt(input.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const { today, since, items } = windowRows(days);
    const filtered = items.filter(item => (!ext || item.extension === ext)
      && (!owner || item.label === owner)
      && (!qText || item.domain.includes(qText) || item.domain.includes(qAscii)));
    const page = filtered.slice(cursor, cursor + limit);
    return {
      days, since, until: today, total: filtered.length, items: page,
      nextCursor: cursor + page.length < filtered.length ? cursor + page.length : null,
      namesWatched: S().q.watchedCount.get().n, generatedAt: isoNow(),
    };
  }

  function rollup(input = {}) {
    const days = clampInt(input.days, 30, 1, MAX_WINDOW_DAYS);
    const owner = ownerFilter(input.owner);
    const qText = String(input.q || '').trim().toLowerCase();
    const limit = clampInt(input.limit, 20, 1, 500);
    const cursor = clampInt(input.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const { today, since, items } = windowRows(days);
    const groups = new Map();
    for (const item of items) {
      if (owner && item.label !== owner) continue;
      if (!groups.has(item.label)) groups.set(item.label, { label: item.label, ownerNames: item.ownerNames, extensions: [], latestFirstSeen: item.firstSeen });
      const group = groups.get(item.label);
      group.extensions.push({ domain: item.domain, extension: item.extension, firstSeen: item.firstSeen, sources: item.sources, url: item.url });
      if (item.firstSeen > group.latestFirstSeen) group.latestFirstSeen = item.firstSeen;
    }
    const all = [...groups.values()]
      .map(group => ({ ...group, count: group.extensions.length }))
      .filter(group => !qText || group.label.includes(qText) || group.ownerNames.some(name => name.includes(qText)))
      .sort((a, b) => b.count - a.count || b.latestFirstSeen.localeCompare(a.latestFirstSeen) || a.label.localeCompare(b.label));
    const page = all.slice(cursor, cursor + limit);
    return { days, since, until: today, total: all.length, items: page, nextCursor: cursor + page.length < all.length ? cursor + page.length : null };
  }

  // ── Health ──

  async function health() {
    if (!enabled) return { status: 'disabled', enabled: false, alerts: [] };
    const { q } = S();
    const version = listVersion();
    const namesTotal = q.nameCount.get().n;
    const namesWatched = q.watchedCount.get().n;
    const { stages, failures } = await inventory();
    const latestBySource = {};
    const earliestBySource = {};
    for (const stage of stages) {
      if (!latestBySource[stage.source] || stage.day > latestBySource[stage.source]) latestBySource[stage.source] = stage.day;
      if (!earliestBySource[stage.source] || stage.day < earliestBySource[stage.source]) earliestBySource[stage.source] = stage.day;
    }
    const scanned = Object.fromEntries(q.scannedBySource.all(version).map(row => [row.source, row.day]));
    const matched = Object.fromEntries(q.matchedBySource.all().map(row => [row.source, { day: row.day, matches: row.n }]));
    const alerts = [];
    const sources = {};
    for (const source of [...new Set([...Object.keys(latestBySource), ...Object.keys(matched)])].sort()) {
      const latest = latestBySource[source] || null;
      const lastScanned = scanned[source] || null;
      let behindDays = 0;
      if (latest && namesWatched) behindDays = lastScanned ? Math.max(0, dayDiff(lastScanned, latest)) : dayDiff(earliestBySource[source], latest) + 1;
      sources[source] = { latestSourceDay: latest, lastScannedDay: lastScanned, lastMatchedDay: matched[source]?.day || null, matches: matched[source]?.matches || 0, behindDays };
      if (behindDays > 1) alerts.push(`My names lane is ${behindDays} days behind ${source} (source ${latest}, last matched ${lastScanned || 'never'})`);
    }
    const stageErrors = q.errors.all();
    for (const failure of failures) alerts.push(`My names ${failure.source} listing failed: ${failure.error.message}`);
    for (const row of stageErrors) alerts.push(`My names ${row.source} ${row.day} failed (${row.attempts} attempts, retrying): ${row.error}`);
    let lastError = null;
    try { lastError = JSON.parse(q.metaGet.get('last_error')?.value || 'null'); } catch { lastError = null; }
    let storedRun = lastRun;
    if (!storedRun) { try { storedRun = JSON.parse(q.metaGet.get('last_run')?.value || 'null'); } catch { storedRun = null; } }
    const matchesTotal = q.visible.all({ since: '0000-00-00' }).length;
    const behind = Object.values(sources).some(s => s.behindDays > 1);
    const status = !namesWatched ? 'idle' : running ? 'running' : stageErrors.length || failures.length ? 'failed' : behind ? 'behind' : 'ok';
    let authoritativeDns = null;
    if (typeof options.dnsHealth === 'function') {
      authoritativeDns = await Promise.resolve().then(() => options.dnsHealth())
        .catch(error => ({ status: 'failed', alerts: [`My names DNS health unavailable: ${error.message}`] }));
      alerts.push(...(authoritativeDns?.alerts || []));
    }
    return { status, enabled: true, namesTotal, namesWatched, matchesTotal, listVersion: version, sources, lastError, lastRun: storedRun, authoritativeDns, alerts };
  }

  function close() {
    try { store?.db.close(); } catch { /* closed */ }
    try { if (!options.openZoneDb) zoneDb?.close(); } catch { /* closed */ }
    store = null;
    zoneDb = null;
  }

  return {
    enabled, storePath,
    replaceNames, addName, removeName, listNames,
    run, schedule, inventory, matches, rollup, health, close,
    get running() { return running; },
  };
}

// ── Routes (all behind the global requireAuth in server/index.js) ──

const BODY_LIMIT = '16mb';

function registerOwnerNameRoutes(app, lane) {
  const express = require('express');
  const jsonBody = express.json({ limit: BODY_LIMIT, strict: false });
  const textBody = express.text({ limit: BODY_LIMIT, type: ['text/plain', 'text/csv', 'application/octet-stream'] });
  const handle = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await fn(req, res)); }
    catch (error) { res.status(error.statusCode || (error.type === 'entity.too.large' ? 413 : 500)).json({ error: error.message || 'My names request failed' }); }
  };
  const guard = (req, res, next) => (lane.enabled ? next() : res.status(503).json({ error: 'My names lane is disabled (DOMAINSCOUT_OWNER_NAMES_ENABLED=0)' }));

  app.get('/api/owner-names', guard, handle(req => lane.listNames(req.query || {})));
  app.put('/api/owner-names', guard, jsonBody, textBody, handle(req => lane.replaceNames(req.body)));
  app.post('/api/owner-names', guard, jsonBody, textBody, handle((req, res) => {
    const body = req.body;
    const domain = typeof body === 'string' ? body.trim() : body?.domain;
    const result = lane.addName(domain);
    res.status(result.added ? 201 : 200);
    return result;
  }));
  app.delete('/api/owner-names/:domain', guard, handle(req => lane.removeName(req.params.domain)));
  app.get('/api/owner-names/matches', guard, handle(req => lane.matches(req.query || {})));
  app.get('/api/owner-names/rollup', guard, handle(req => lane.rollup(req.query || {})));
  app.get('/api/owner-names/health', handle(() => lane.health()));
  app.post('/api/owner-names/run', guard, handle((req, res) => { res.status(202); return { queued: lane.schedule('operator') }; }));
}

// Paths whose bodies the route-level parsers above own (the app-wide
// express.json() default 100kb limit would reject a large bulk replace).
const OWNER_NAMES_BODY_PATHS = Object.freeze(['/api/owner-names']);

module.exports = {
  WATCH_TLDS, EXCLUDED_TLDS, MAX_NAMES, OWNER_NAMES_BODY_PATHS,
  ownerNamesEnabled, normalizeDomain, parseNameInput, isMatch, isExcludedTld, asciiLabel,
  createOwnerNamesLane, registerOwnerNameRoutes, utcDay, shiftDay,
};
