'use strict';

// Snapshot-complete sibling-TLD scanner for live market inventory. This process is
// deliberately separate from the HTTP server: a full auction-universe verification
// may take minutes, but it must never freeze or partially populate the desktop view.
const axios = require('axios');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const {
  getRegistrarAvailabilityConfig,
} = require('../enrichment');
const { readGoDaddyInventoryIndex, getGoDaddyInventoryCacheMeta } = require('./godaddy-cache');
const { normalizeTld } = require('./taken-in-status');

const DATA_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const DB_PATH = path.join(DATA_PATH, 'domains.db');
const stream = String(process.env.MARKET_SIBLING_STREAM || 'godaddy-auction');
const sourceKey = String(process.env.MARKET_SIBLING_SOURCE_TLDS || '*');
const targetKey = String(process.env.MARKET_SIBLING_TARGET_TLDS || '');
const snapshotSha256 = String(process.env.MARKET_SIBLING_SNAPSHOT_SHA256 || '');
const snapshotGeneratedAt = String(process.env.MARKET_SIBLING_SNAPSHOT_GENERATED_AT || '');
const sourceTlds = sourceKey === '*' ? null : new Set(sourceKey.split(',').map(normalizeTld).filter(Boolean));
const targetTlds = [...new Set(targetKey.split(',').map(normalizeTld).filter(Boolean))];
const batchSize = Math.max(10, Math.min(250, Number(process.env.MARKET_SIBLING_BATCH_SIZE) || 100));
const registrarConcurrency = Math.max(1, Math.min(12, Number(process.env.MARKET_SIBLING_REGISTRAR_CONCURRENCY) || 4));
const fallbackConcurrency = Math.max(10, Math.min(500, Number(process.env.MARKET_SIBLING_FALLBACK_CONCURRENCY) || 300));
const dnsTimeoutMs = Math.max(300, Math.min(5000, Number(process.env.MARKET_SIBLING_DNS_TIMEOUT_MS) || 1200));
const lockKey = crypto.createHash('sha256').update(`${stream}\0${sourceKey}\0${targetKey}`).digest('hex').slice(0, 24);
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
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, stream, sourceKey, targetKey, snapshotSha256 }));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
      if (processIsAlive(Number(owner?.pid))) {
        console.log(JSON.stringify({ ok: true, skipped: 'scan-already-running', ownerPid: owner.pid, stream, sourceTlds: sourceKey, targetTlds: targetKey }));
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

const updateState = db.prepare(`
  INSERT INTO market_sibling_scan (
    stream, source_tlds, target_tlds, snapshot_sha256, snapshot_generated_at,
    candidate_count, pair_count, checked_count, taken_count, unknown_count,
    status, started_at, completed_at, error
  ) VALUES (
    @stream, @sourceTlds, @targetTlds, @snapshotSha256, @snapshotGeneratedAt,
    @candidateCount, @pairCount, @checkedCount, @takenCount, @unknownCount,
    @status, datetime('now'), @completedAt, @error
  )
  ON CONFLICT(stream, source_tlds, target_tlds) DO UPDATE SET
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

function compactCandidates(index) {
  const domainColumn = index.compactColumnIndex.domain;
  const tldColumn = index.compactColumnIndex.tld;
  const endColumn = index.compactColumnIndex.auction_end;
  const now = Date.now();
  const names = new Set();
  for (const tuple of index.compactRows) {
    const rowTld = normalizeTld(tuple[tldColumn]);
    if (sourceTlds && !sourceTlds.has(rowTld)) continue;
    const end = Date.parse(tuple[endColumn] || '');
    if (!Number.isFinite(end) || end <= now) continue;
    const domain = String(tuple[domainColumn] || '').toLowerCase();
    const dot = domain.indexOf('.');
    if (dot > 0) names.add(domain.slice(0, dot));
  }
  return [...names].sort();
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
  const candidates = compactCandidates(index);
  const pairCount = candidates.length * targetTlds.length;
  const counters = { checked: 0, taken: 0, unknown: 0 };
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
    targetTlds: targetKey,
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
  for (const baseName of candidates) {
    for (const tld of targetTlds) work.push({ baseName, tld, domain: `${baseName}${tld}` });
  }

  const windowSize = credentials ? batchSize * registrarConcurrency : batchSize * fallbackConcurrency;
  for (let offset = 0; offset < work.length; offset += windowSize) {
    const window = work.slice(offset, offset + windowSize);
    const groups = [];
    for (let i = 0; i < window.length; i += batchSize) groups.push(window.slice(i, i + batchSize));
    let statuses;
    if (credentials) {
      const groupStatuses = await mapConcurrent(groups, registrarConcurrency, group => checkRegistrarBatch(group.map(item => item.domain), credentials));
      statuses = groupStatuses.flat();
    } else {
      statuses = await mapConcurrent(window, fallbackConcurrency, item => checkDnsRegistration(item.domain));
    }
    const checkedAt = new Date().toISOString();
    const resolved = [];
    for (let index = 0; index < window.length; index++) {
      const status = statuses[index];
      if (status !== 'taken' && status !== 'not_taken') {
        counters.unknown++;
        continue;
      }
      counters.checked++;
      if (status === 'taken') counters.taken++;
      resolved.push({ ...window[index], status, source: credentials ? 'godaddy-registrar' : 'dns-ns-full-snapshot', checkedAt });
    }
    persist(resolved);
    state('running');
  }

  const currentMeta = getGoDaddyInventoryCacheMeta(stream);
  if (currentMeta?.snapshotSha256 !== snapshotSha256) throw new Error('inventory snapshot changed during sibling scan');
  if (counters.checked !== pairCount || counters.unknown !== 0) {
    throw new Error(`${counters.unknown} sibling registrations remained unknown`);
  }
  state('complete');
  console.log(JSON.stringify({ ok: true, stream, sourceTlds: sourceKey, targetTlds: targetKey, snapshotSha256, candidateCount: candidates.length, pairCount, takenCount: counters.taken }));
}

main().catch(error => {
  try {
    updateState.run({
      stream, sourceTlds: sourceKey, targetTlds: targetKey, snapshotSha256,
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
