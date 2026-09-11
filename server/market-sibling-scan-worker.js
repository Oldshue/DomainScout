'use strict';

// Snapshot-complete sibling-TLD scanner for live market inventory. This process is
// deliberately separate from the HTTP server: a full auction-universe verification
// may take minutes, but it must never freeze or partially populate the desktop view.
//
// The pure helpers below (date-window parsing, candidate filtering, and scan-identity
// encoding) are safe to require() from the HTTP server or from tests: they have no
// side effects. Everything that touches the filesystem, the database, the network, or
// process lifecycle lives inside the `require.main === module` guard at the bottom so
// a test (or server/index.js) can import the module without starting a scan.
const path = require('path');
const { normalizeTld } = require('./taken-in-status');

// -- Pure date-window helpers (mirrors the /api/domains dateWindow semantics in
// server/index.js: today | tomorrow | next24h | YYYY-MM-DD, all resolved in the
// auction reference timezone so a UTC host doesn't drift a day ahead of the user). --

function tzOffsetMs(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asWall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return asWall - date.getTime();
}

function tzMidnightUtc(y, mo, d, tz) {
  let t = Date.UTC(y, mo - 1, d, 0, 0, 0);
  for (let k = 0; k < 2; k++) t = Date.UTC(y, mo - 1, d, 0, 0, 0) - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}

function localDateWindow(offsetDays, tz) {
  const nowParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  const shifted = new Date(Date.UTC(+nowParts.year, +nowParts.month - 1, +nowParts.day + offsetDays));
  const y = shifted.getUTCFullYear(), mo = shifted.getUTCMonth() + 1, d = shifted.getUTCDate();
  const start = tzMidnightUtc(y, mo, d, tz);
  const end = tzMidnightUtc(y, mo, d + 1, tz);
  return { start: start.toISOString(), end: end.toISOString(), label: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

function rollingDateWindow(hours) {
  const boundedHours = Math.min(24 * 31, Math.max(1, Number(hours) || 24));
  const start = new Date();
  const end = new Date(start.getTime() + boundedHours * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString(), label: `next${boundedHours}h` };
}

// Parses MARKET_SIBLING_DATE_WINDOW / ?dateWindow= into { start, end, label } (ISO
// bounds) or null for "whole stream" (empty/unrecognized value). `tz` defaults to the
// same override env var as the main /api/domains filter.
function parseMarketSiblingDateWindow(value, tz = process.env.DOMAINSCOUT_TZ || 'America/Los_Angeles') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'any') return null;
  if (raw === 'today') return localDateWindow(0, tz);
  if (raw === 'tomorrow') return localDateWindow(1, tz);
  if (raw === 'next24h' || raw === 'next24' || raw === '24h') return rollingDateWindow(24);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const y = Number(match[1]), mo = Number(match[2]), d = Number(match[3]);
  const start = tzMidnightUtc(y, mo, d, tz);
  if (!Number.isFinite(start.getTime())) return null;
  const end = tzMidnightUtc(y, mo, d + 1, tz);
  return { start: start.toISOString(), end: end.toISOString(), label: raw };
}

// Normalizes a raw dateWindow input down to its canonical identity label (or null),
// without resolving it to concrete timestamps. Shared by the worker (to build its
// filter window) and by server/index.js (to build the scan identity key and echo the
// applied value) so both sides always agree on what "the same window" means.
function normalizeMarketSiblingDateWindow(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'any') return null;
  if (raw === 'today' || raw === 'tomorrow' || raw === 'next24h') return raw;
  if (raw === 'next24' || raw === '24h') return 'next24h';
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

// A windowed scan and a whole-stream scan over the identical stream/source/target TLDs
// are different bodies of work (different candidate sets, different completeness
// criteria) and must never collide in market_sibling_scan's
// (stream, source_tlds, target_tlds) primary key or in the in-process child-process
// lock. Folding the normalized window into the target-TLD identity key keeps the
// existing schema/PK unchanged while guaranteeing they never share a row or a lock.
function marketSiblingTargetIdentity(targetKey, dateWindowValue) {
  const window = normalizeMarketSiblingDateWindow(dateWindowValue);
  return window ? `${targetKey}::window=${window}` : String(targetKey || '');
}

// Keeps only candidates whose auction_end falls inside `dateWindow` (already resolved
// to ISO start/end bounds by parseMarketSiblingDateWindow) and that are still open
// (auction_end in the future). `dateWindow` of null/undefined means "whole stream":
// unchanged behavior. Pure and network-free; safe to unit test with fixture rows.
function selectCandidateBaseNames(index, { sourceTlds = null, dateWindow = null, now = Date.now() } = {}) {
  const domainColumn = index.compactColumnIndex.domain;
  const tldColumn = index.compactColumnIndex.tld;
  const endColumn = index.compactColumnIndex.auction_end;
  const windowStart = dateWindow ? Date.parse(dateWindow.start) : null;
  const windowEnd = dateWindow ? Date.parse(dateWindow.end) : null;
  const names = new Set();
  for (const tuple of index.compactRows) {
    const rowTld = normalizeTld(tuple[tldColumn]);
    if (sourceTlds && !sourceTlds.has(rowTld)) continue;
    const end = Date.parse(tuple[endColumn] || '');
    if (!Number.isFinite(end) || end <= now) continue;
    if (dateWindow && (end < windowStart || end >= windowEnd)) continue;
    const domain = String(tuple[domainColumn] || '').toLowerCase();
    const dot = domain.indexOf('.');
    if (dot > 0) names.add(domain.slice(0, dot));
  }
  return [...names].sort();
}

module.exports = {
  parseMarketSiblingDateWindow,
  normalizeMarketSiblingDateWindow,
  marketSiblingTargetIdentity,
  selectCandidateBaseNames,
};

if (require.main === module) {
  const axios = require('axios');
  const Database = require('better-sqlite3');
  const crypto = require('crypto');
  const dns = require('dns');
  const fs = require('fs');
  const {
    getRegistrarAvailabilityConfig,
    checkRegistrationAvailability,
  } = require('../enrichment');
  const { readGoDaddyInventoryIndex, getGoDaddyInventoryCacheMeta } = require('./godaddy-cache');

  const DATA_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
  const DB_PATH = path.join(DATA_PATH, 'domains.db');
  const stream = String(process.env.MARKET_SIBLING_STREAM || 'godaddy-auction');
  const sourceKey = String(process.env.MARKET_SIBLING_SOURCE_TLDS || '*');
  const targetKey = String(process.env.MARKET_SIBLING_TARGET_TLDS || '');
  const snapshotSha256 = String(process.env.MARKET_SIBLING_SNAPSHOT_SHA256 || '');
  const snapshotGeneratedAt = String(process.env.MARKET_SIBLING_SNAPSHOT_GENERATED_AT || '');
  const dateWindowRaw = String(process.env.MARKET_SIBLING_DATE_WINDOW || '');
  const dateWindowLabel = normalizeMarketSiblingDateWindow(dateWindowRaw);
  const dateWindow = parseMarketSiblingDateWindow(dateWindowRaw);
  const targetIdentityKey = marketSiblingTargetIdentity(targetKey, dateWindowRaw);
  const sourceTlds = sourceKey === '*' ? null : new Set(sourceKey.split(',').map(normalizeTld).filter(Boolean));
  const targetTlds = [...new Set(targetKey.split(',').map(normalizeTld).filter(Boolean))];
  const batchSize = Math.max(10, Math.min(250, Number(process.env.MARKET_SIBLING_BATCH_SIZE) || 100));
  const registrarConcurrency = Math.max(1, Math.min(12, Number(process.env.MARKET_SIBLING_REGISTRAR_CONCURRENCY) || 4));
  const fallbackConcurrency = Math.max(10, Math.min(500, Number(process.env.MARKET_SIBLING_FALLBACK_CONCURRENCY) || 300));
  const retryConcurrency = Math.max(5, Math.min(100, Number(process.env.MARKET_SIBLING_RETRY_CONCURRENCY) || 60));
  const dnsTimeoutMs = Math.max(300, Math.min(5000, Number(process.env.MARKET_SIBLING_DNS_TIMEOUT_MS) || 1200));
  const evidenceTtlMs = Math.max(15 * 60_000, Math.min(24 * 60 * 60_000, Number(process.env.MARKET_SIBLING_EVIDENCE_TTL_MS) || 6 * 60 * 60_000));
  const lockKey = crypto.createHash('sha256').update(`${stream}\0${sourceKey}\0${targetIdentityKey}`).digest('hex').slice(0, 24);
  const lockPath = path.join(DATA_PATH, `market-sibling-scan-${lockKey}.lock`);

  if (!snapshotSha256 || !targetTlds.length) throw new Error('market sibling scan requires snapshot and target TLDs');

  function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  function acquireLock() {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, stream, sourceKey, targetKey: targetIdentityKey, snapshotSha256 }));
        fs.closeSync(fd);
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let owner = null;
        try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
        if (processIsAlive(Number(owner?.pid))) {
          console.log(JSON.stringify({ ok: true, skipped: 'scan-already-running', ownerPid: owner.pid, stream, sourceTlds: sourceKey, targetTlds: targetIdentityKey }));
          return false;
        }
        try { fs.unlinkSync(lockPath); } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
      }
    }
    throw new Error('could not acquire market sibling scan lock');
  }

  function releaseLock() {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
    if (Number(owner?.pid) !== process.pid) return;
    try { fs.unlinkSync(lockPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  if (!acquireLock()) process.exit(0);
  process.once('exit', releaseLock);
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));

  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 30000');

  const siblingScanColumns = db.prepare("PRAGMA table_info(market_sibling_scan)").all().map(c => c.name);
  if (!siblingScanColumns.includes('date_window')) {
    db.exec("ALTER TABLE market_sibling_scan ADD COLUMN date_window TEXT");
  }

  const updateState = db.prepare(`
    INSERT INTO market_sibling_scan (
      stream, source_tlds, target_tlds, date_window, snapshot_sha256, snapshot_generated_at,
      candidate_count, pair_count, checked_count, taken_count, unknown_count,
      status, started_at, completed_at, error
    ) VALUES (
      @stream, @sourceTlds, @targetTlds, @dateWindow, @snapshotSha256, @snapshotGeneratedAt,
      @candidateCount, @pairCount, @checkedCount, @takenCount, @unknownCount,
      @status, datetime('now'), @completedAt, @error
    )
    ON CONFLICT(stream, source_tlds, target_tlds) DO UPDATE SET
      date_window = excluded.date_window,
      snapshot_sha256 = excluded.snapshot_sha256,
      snapshot_generated_at = excluded.snapshot_generated_at,
      candidate_count = excluded.candidate_count,
      pair_count = excluded.pair_count,
      checked_count = excluded.checked_count,
      taken_count = excluded.taken_count,
      unknown_count = excluded.unknown_count,
      status = excluded.status,
      started_at = CASE WHEN excluded.status = 'running' AND market_sibling_scan.snapshot_sha256 != excluded.snapshot_sha256 THEN datetime('now') ELSE market_sibling_scan.started_at END,
      completed_at = excluded.completed_at,
      error = excluded.error
  `);
  const upsertStatus = db.prepare(`
    INSERT INTO sibling_tld_status (base_name, tld, status, source, checked_at)
    VALUES (@baseName, @tld, @status, @source, @checkedAt)
    ON CONFLICT(base_name, tld) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      checked_at = excluded.checked_at
  `);
  const insertPositive = db.prepare('INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name) VALUES (@tld, @baseName)');
  const deleteNegative = db.prepare('DELETE FROM cctld_taken_idx WHERE tld = @tld AND base_name = @baseName');
  const persist = db.transaction((rows) => {
    for (const row of rows) {
      upsertStatus.run(row);
      if (row.status === 'taken') insertPositive.run(row);
      else deleteNegative.run(row);
    }
  });

  const freshStatusStatements = new Map();
  function loadFreshStatuses(baseNames, cutoff) {
    if (!baseNames.length) return [];
    const statementKey = `${baseNames.length}:${targetTlds.length}`;
    let statement = freshStatusStatements.get(statementKey);
    if (!statement) {
      const basePlaceholders = baseNames.map(() => '?').join(',');
      const targetPlaceholders = targetTlds.map(() => '?').join(',');
      statement = db.prepare(`
        SELECT base_name, tld, status
        FROM sibling_tld_status
        WHERE checked_at >= ?
          AND status IN ('taken', 'not_taken')
          AND base_name IN (${basePlaceholders})
          AND tld IN (${targetPlaceholders})
      `);
      freshStatusStatements.set(statementKey, statement);
    }
    return statement.all(cutoff, ...baseNames, ...targetTlds);
  }

  function registrarRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.domains)) return payload.domains;
    return [];
  }

  const DNS_SERVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '1.0.0.1', '8.8.4.4', '149.112.112.112'];
  const resolvers = DNS_SERVERS.map(server => {
    const resolver = new dns.promises.Resolver({ timeout: dnsTimeoutMs, tries: 1 });
    resolver.setServers([server]);
    return resolver;
  });
  let resolverCursor = 0;

  async function checkDnsRegistration(domain) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const resolver = resolvers[resolverCursor++ % resolvers.length];
      try {
        const records = await resolver.resolveNs(domain);
        return Array.isArray(records) && records.length ? 'taken' : 'not_taken';
      } catch (error) {
        const code = String(error?.code || '').toUpperCase();
        if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return 'not_taken';
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    return 'unknown';
  }

  async function checkRegistrarBatch(domains, credentials, attempt = 0) {
    try {
      const response = await axios.post(
        'https://api.godaddy.com/v1/domains/available?checkType=FAST',
        domains,
        {
          headers: {
            Authorization: `sso-key ${credentials.apiKey}:${credentials.apiSecret}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );
      const byDomain = new Map(registrarRows(response.data).map(row => [String(row.domain || '').toLowerCase(), row]));
      return domains.map(domain => {
        const row = byDomain.get(domain.toLowerCase());
        return row?.available === true ? 'not_taken' : row?.available === false ? 'taken' : 'unknown';
      });
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      if ((status === 429 || status >= 500) && attempt < 5) {
        const retryAfter = Number(error?.response?.headers?.['retry-after'] || 0);
        await new Promise(resolve => setTimeout(resolve, Math.max(1000, retryAfter * 1000, 1000 * (2 ** attempt))));
        return checkRegistrarBatch(domains, credentials, attempt + 1);
      }
      return domains.map(() => 'unknown');
    }
  }

  async function mapConcurrent(items, concurrency, callback) {
    const output = new Array(items.length);
    let cursor = 0;
    const pool = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        output[index] = await callback(items[index], index);
      }
    });
    await Promise.all(pool);
    return output;
  }

  let lastProgress = {
    candidateCount: 0,
    pairCount: 0,
    checkedCount: 0,
    takenCount: 0,
    unknownCount: 0,
  };

  async function main() {
    const index = readGoDaddyInventoryIndex(stream);
    if (!index) throw new Error(`missing ${stream} inventory index`);
    const candidates = selectCandidateBaseNames(index, { sourceTlds, dateWindow });
    const pairCount = candidates.length * targetTlds.length;
    const counters = { checked: 0, taken: 0, unknown: 0 };
    const unresolved = [];
    const state = (status, error = null) => {
      lastProgress = {
        candidateCount: candidates.length,
        pairCount,
        checkedCount: counters.checked,
        takenCount: counters.taken,
        unknownCount: counters.unknown,
      };
      return updateState.run({
      stream,
      sourceTlds: sourceKey,
      targetTlds: targetIdentityKey,
      dateWindow: dateWindowLabel,
      snapshotSha256,
      snapshotGeneratedAt: snapshotGeneratedAt || null,
      candidateCount: candidates.length,
      pairCount,
      checkedCount: counters.checked,
      takenCount: counters.taken,
      unknownCount: counters.unknown,
      status,
      completedAt: status === 'complete' ? new Date().toISOString() : null,
        error,
      });
    };
    state('running');

    const registrar = getRegistrarAvailabilityConfig();
    const credentials = registrar.configured
      ? { apiKey: process.env.GODADDY_API_KEY, apiSecret: process.env.GODADDY_API_SECRET }
      : null;
    const work = [];
    const evidenceCutoff = new Date(Date.now() - evidenceTtlMs).toISOString();
    for (let offset = 0; offset < candidates.length; offset += 400) {
      const baseNames = candidates.slice(offset, offset + 400);
      const fresh = new Map(loadFreshStatuses(baseNames, evidenceCutoff).map(row => [`${row.base_name}\0${row.tld}`, row.status]));
      for (const baseName of baseNames) {
        for (const tld of targetTlds) {
          const status = fresh.get(`${baseName}\0${tld}`);
          if (status === 'taken' || status === 'not_taken') {
            counters.checked++;
            if (status === 'taken') counters.taken++;
          } else {
            work.push({ baseName, tld, domain: `${baseName}${tld}` });
          }
        }
      }
    }
    state('running');

    const windowSize = credentials ? batchSize * registrarConcurrency : batchSize * fallbackConcurrency;
    for (let offset = 0; offset < work.length; offset += windowSize) {
      const windowSlice = work.slice(offset, offset + windowSize);
      const groups = [];
      for (let i = 0; i < windowSlice.length; i += batchSize) groups.push(windowSlice.slice(i, i + batchSize));
      let statuses;
      if (credentials) {
        const groupStatuses = await mapConcurrent(groups, registrarConcurrency, group => checkRegistrarBatch(group.map(item => item.domain), credentials));
        statuses = groupStatuses.flat();
      } else {
        statuses = await mapConcurrent(windowSlice, fallbackConcurrency, item => checkDnsRegistration(item.domain));
      }
      const checkedAt = new Date().toISOString();
      const resolved = [];
      for (let index = 0; index < windowSlice.length; index++) {
        const status = statuses[index];
        if (status !== 'taken' && status !== 'not_taken') {
          unresolved.push(windowSlice[index]);
          continue;
        }
        counters.checked++;
        if (status === 'taken') counters.taken++;
        resolved.push({ ...windowSlice[index], status, source: credentials ? 'godaddy-registrar' : 'dns-ns-full-snapshot', checkedAt });
      }
      counters.unknown = unresolved.length;
      persist(resolved);
      state('running');
    }

    // Saturating a home connection with the primary sweep can leave a small number
    // of resolver timeouts. Retry only those names at lower concurrency; an
    // inconclusive lookup is never silently converted into an available domain.
    for (let round = 1; round <= 3 && unresolved.length; round++) {
      const pending = unresolved.splice(0);
      const statuses = await mapConcurrent(
        pending,
        Math.max(5, Math.floor(retryConcurrency / round)),
        item => checkDnsRegistration(item.domain)
      );
      const checkedAt = new Date().toISOString();
      const resolved = [];
      for (let index = 0; index < pending.length; index++) {
        const status = statuses[index];
        if (status !== 'taken' && status !== 'not_taken') {
          unresolved.push(pending[index]);
          continue;
        }
        counters.checked++;
        if (status === 'taken') counters.taken++;
        resolved.push({ ...pending[index], status, source: `dns-ns-full-snapshot-retry-${round}`, checkedAt });
      }
      counters.unknown = unresolved.length;
      persist(resolved);
      state('running');
    }

    // A tiny tail can remain inconclusive across independent DNS resolvers (for
    // example registry-reserved or temporarily lame names). Resolve only that tail
    // through the registry-aware RDAP/WHOIS path so the full universe remains
    // bounded without treating transport failure as availability.
    if (unresolved.length) {
      const pending = unresolved.splice(0);
      const results = await mapConcurrent(pending, Math.min(8, retryConcurrency), async item => {
        const result = await checkRegistrationAvailability(item.domain);
        return {
          status: result.registration_available === 0 ? 'taken' : result.registration_available === 1 ? 'not_taken' : 'unknown',
          source: result.availability_source || 'rdap+whois',
        };
      });
      const checkedAt = new Date().toISOString();
      const resolved = [];
      for (let index = 0; index < pending.length; index++) {
        const result = results[index];
        if (result.status !== 'taken' && result.status !== 'not_taken') {
          unresolved.push(pending[index]);
          continue;
        }
        counters.checked++;
        if (result.status === 'taken') counters.taken++;
        resolved.push({ ...pending[index], status: result.status, source: result.source, checkedAt });
      }
      counters.unknown = unresolved.length;
      persist(resolved);
      state('running');
    }

    const currentMeta = getGoDaddyInventoryCacheMeta(stream);
    if (currentMeta?.snapshotSha256 !== snapshotSha256) throw new Error('inventory snapshot changed during sibling scan');
    if (counters.checked !== pairCount || counters.unknown !== 0) {
      throw new Error(`${counters.unknown} sibling registrations remained unknown`);
    }
    state('complete');
    console.log(JSON.stringify({ ok: true, stream, sourceTlds: sourceKey, targetTlds: targetIdentityKey, dateWindow: dateWindowLabel, snapshotSha256, candidateCount: candidates.length, pairCount, takenCount: counters.taken }));
  }

  main().catch(error => {
    try {
      updateState.run({
        stream, sourceTlds: sourceKey, targetTlds: targetIdentityKey, dateWindow: dateWindowLabel, snapshotSha256,
        snapshotGeneratedAt: snapshotGeneratedAt || null,
        candidateCount: lastProgress.candidateCount, pairCount: lastProgress.pairCount,
        checkedCount: lastProgress.checkedCount, takenCount: lastProgress.takenCount,
        unknownCount: Math.max(1, lastProgress.unknownCount), status: 'failed',
        completedAt: null, error: String(error?.message || error),
      });
    } catch (_) {}
    console.error(`[market-sibling-scan] ${String(error?.message || error)}`);
    process.exitCode = 1;
  });
}
