'use strict';

// Snapshot-complete sibling-TLD scanner for live market inventory. This process is
// deliberately separate from the HTTP server: a full auction-universe verification
// may take minutes, but it must never freeze or partially populate the desktop view.
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const {
  getRegistrarAvailabilityConfig,
  checkRegistrationAvailability,
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
const fallbackConcurrency = Math.max(1, Math.min(50, Number(process.env.MARKET_SIBLING_FALLBACK_CONCURRENCY) || 20));

if (!snapshotSha256 || !targetTlds.length) throw new Error('market sibling scan requires snapshot and target TLDs');

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

async function main() {
  const index = readGoDaddyInventoryIndex(stream);
  if (!index) throw new Error(`missing ${stream} inventory index`);
  const candidates = compactCandidates(index);
  const pairCount = candidates.length * targetTlds.length;
  const counters = { checked: 0, taken: 0, unknown: 0 };
  const state = (status, error = null) => updateState.run({
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
  state('running');

  const registrar = getRegistrarAvailabilityConfig();
  const credentials = registrar.configured
    ? { apiKey: process.env.GODADDY_API_KEY, apiSecret: process.env.GODADDY_API_SECRET }
    : null;
  const work = [];
  for (const baseName of candidates) {
    for (const tld of targetTlds) work.push({ baseName, tld, domain: `${baseName}${tld}` });
  }

  for (let offset = 0; offset < work.length; offset += batchSize * registrarConcurrency) {
    const window = work.slice(offset, offset + batchSize * registrarConcurrency);
    const groups = [];
    for (let i = 0; i < window.length; i += batchSize) groups.push(window.slice(i, i + batchSize));
    let statuses;
    if (credentials) {
      const groupStatuses = await mapConcurrent(groups, registrarConcurrency, group => checkRegistrarBatch(group.map(item => item.domain), credentials));
      statuses = groupStatuses.flat();
    } else {
      statuses = await mapConcurrent(window, fallbackConcurrency, async item => {
        const result = await checkRegistrationAvailability(item.domain);
        return result.registration_available === 0 ? 'taken' : result.registration_available === 1 ? 'not_taken' : 'unknown';
      });
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
      resolved.push({ ...window[index], status, source: credentials ? 'godaddy-registrar' : 'rdap+dns', checkedAt });
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
      snapshotGeneratedAt: snapshotGeneratedAt || null, candidateCount: 0, pairCount: 0,
      checkedCount: 0, takenCount: 0, unknownCount: 1, status: 'failed',
      completedAt: null, error: String(error?.message || error),
    });
  } catch (_) {}
  console.error(`[market-sibling-scan] ${String(error?.message || error)}`);
  process.exitCode = 1;
});
