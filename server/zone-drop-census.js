'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_BASE = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const ZONE_INDEX_DB = path.join(DATA_BASE, 'zone_index.db');
const ZONE_DIFF_SOURCE = 'First-party Zone Diff';
const ZONE_DIFF_PROVIDER = 'first-party-zone-diff';
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 2000;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function dottedTld(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/^\.+/, '');
  return clean ? `.${clean}` : '';
}

function sourceEventAt(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error(`invalid zone drop date: ${date}`);
  }
  return `${date}T00:00:00.000Z`;
}

function openZoneDb() {
  if (!fs.existsSync(ZONE_INDEX_DB)) return null;
  const database = new Database(ZONE_INDEX_DB);
  database.pragma('busy_timeout = 30000');
  return database;
}

function prepareDomainUpsert(database) {
  return database.prepare(`
    INSERT INTO domains (
      domain, base_name, tld, stream, source,
      length, has_numbers, has_hyphens, drop_date,
      tlds_taken, tlds_checked_at
    ) VALUES (
      @domain, @base_name, @tld, 'just-dropped', @source,
      @length, @has_numbers, @has_hyphens, @drop_date,
      @tlds_taken, @tlds_checked_at
    )
    ON CONFLICT(domain, stream) DO UPDATE SET
      source = excluded.source,
      dns_available = CASE WHEN excluded.drop_date > COALESCE(domains.drop_date, '') THEN NULL ELSE domains.dns_available END,
      registration_available = CASE WHEN excluded.drop_date > COALESCE(domains.drop_date, '') THEN NULL ELSE domains.registration_available END,
      first_available_at = CASE WHEN excluded.drop_date > COALESCE(domains.drop_date, '') THEN NULL ELSE domains.first_available_at END,
      availability_checked_at = CASE WHEN excluded.drop_date > COALESCE(domains.drop_date, '') THEN NULL ELSE domains.availability_checked_at END,
      availability_source = CASE WHEN excluded.drop_date > COALESCE(domains.drop_date, '') THEN NULL ELSE domains.availability_source END,
      availability_error = CASE WHEN excluded.drop_date > COALESCE(domains.drop_date, '') THEN NULL ELSE domains.availability_error END,
      drop_date = MAX(COALESCE(domains.drop_date, ''), excluded.drop_date),
      length = excluded.length,
      has_numbers = excluded.has_numbers,
      has_hyphens = excluded.has_hyphens,
      tlds_taken = MAX(COALESCE(domains.tlds_taken, 0), COALESCE(excluded.tlds_taken, 0)),
      tlds_checked_at = COALESCE(domains.tlds_checked_at, excluded.tlds_checked_at)
  `);
}

function eventCounts(database, tld, date) {
  return database.prepare(`
    SELECT COUNT(*) AS observed,
      SUM(CASE WHEN registration_available = 1 THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN registration_available = 0 THEN 1 ELSE 0 END) AS unavailable,
      SUM(CASE WHEN registration_available IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM drop_events
    WHERE source = ? AND tld = ? AND SUBSTR(source_event_at, 1, 10) = ?
  `).get(ZONE_DIFF_SOURCE, tld, date);
}

function zoneLedgerRows(zoneDb) {
  const columns = zoneDb.prepare('PRAGMA table_info(zone_daily_stats)').all().map((row) => row.name);
  if (!columns.includes('had_previous')) return [];
  return zoneDb.prepare(`
    SELECT CASE WHEN SUBSTR(stats.tld, 1, 1) = '.' THEN LOWER(stats.tld) ELSE '.' || LOWER(stats.tld) END AS tld,
      stats.stat_date AS date,
      COALESCE(stats.dropped_count, 0) AS dropped_count,
      COUNT(candidate.domain) AS candidate_count,
      COALESCE(SUM(CASE WHEN candidate.imported_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS imported_count
    FROM zone_daily_stats stats
    LEFT JOIN zone_drop_candidates candidate
      ON candidate.tld = CASE WHEN SUBSTR(stats.tld, 1, 1) = '.' THEN LOWER(stats.tld) ELSE '.' || LOWER(stats.tld) END
      AND candidate.drop_date = stats.stat_date
    WHERE stats.had_previous = 1
    GROUP BY stats.tld, stats.stat_date, stats.dropped_count
    ORDER BY stats.stat_date, stats.tld
  `).all();
}

function reconcileCzdsCoverage({ zoneDb, database, dropUniverse } = {}) {
  if (!zoneDb) throw new Error('zoneDb is required');
  database ||= require('./db');
  dropUniverse ||= require('./drop-universe');
  const rows = zoneLedgerRows(zoneDb);
  const byTld = new Map();
  const receipts = [];
  let structuralErrors = 0;

  for (const row of rows) {
    const tld = dottedTld(row.tld);
    const date = String(row.date);
    const dropped = Number(row.dropped_count || 0);
    const candidates = Number(row.candidate_count || 0);
    const imported = Number(row.imported_count || 0);
    const counts = eventCounts(database, tld, date);
    const observed = Number(counts.observed || 0);
    const available = Number(counts.available || 0);
    const unavailable = Number(counts.unavailable || 0);
    const unknown = Number(counts.unknown || 0);
    const structural = candidates === dropped && imported === dropped && observed === dropped;
    const decisive = available + unavailable === observed && unknown === 0;
    const status = !structural ? 'error' : (decisive ? 'complete' : 'pending');
    const error = structural ? null
      : `zone ledger mismatch: dropped=${dropped}, candidates=${candidates}, imported=${imported}, events=${observed}`;
    if (!structural) structuralErrors += 1;

    if (!byTld.has(tld)) byTld.set(tld, []);
    byTld.get(tld).push(date);
    dropUniverse.recordCoverageReceipt({
      tld, date, source: ZONE_DIFF_SOURCE, status,
      observed, available, unavailable, unknown, error,
    });
    receipts.push({ tld, date, status, observed, available, unavailable, unknown, error });
  }

  for (const [tld, dates] of byTld) {
    dropUniverse.registerDropSource({
      tld,
      source: ZONE_DIFF_SOURCE,
      sourceKind: 'zone-deletion-diff',
      coverageStartedOn: [...dates].sort()[0],
      metadata: { provider: ZONE_DIFF_PROVIDER, contract: 'complete-prior-current-zone-diff' },
    });
  }

  if (rows.length) {
    const latestByTld = [...byTld.values()].map((dates) => [...dates].sort().at(-1)).sort();
    const allDates = rows.map((row) => String(row.date)).sort();
    dropUniverse.recordDropSourceStatus({
      source: ZONE_DIFF_SOURCE,
      provider: ZONE_DIFF_PROVIDER,
      lastUpdate: latestByTld[0],
      availableFrom: allDates[0],
      status: structuralErrors ? 'error' : 'ok',
      error: structuralErrors ? `${structuralErrors} zone ledger row(s) failed structural reconciliation` : null,
    });
  }

  return { receipts, sourceRows: rows.length, structuralErrors };
}

async function importCzdsDropCandidates(options = {}) {
  const batchSize = positiveInt(
    options.batchSize || options.limit
      || process.env.DOMAINSCOUT_CZDS_DROP_IMPORT_BATCH_SIZE
      || process.env.DOMAINSCOUT_CZDS_DROP_IMPORT_LIMIT,
    DEFAULT_BATCH_SIZE,
    1,
    MAX_BATCH_SIZE,
  );
  const database = options.database || require('./db');
  const dropUniverse = options.dropUniverse || require('./drop-universe');
  const suppliedZoneDb = options.zoneDb || null;
  const zoneDb = suppliedZoneDb || openZoneDb();
  if (!zoneDb) return { imported: 0, selected: 0, byTld: {}, receipts: [], error: 'zone_index.db not found' };

  const upsertDomain = prepareDomainUpsert(database);
  const selectBatch = zoneDb.prepare(`
    SELECT domain, base_name, tld, drop_date, tld_count, length
    FROM zone_drop_candidates
    WHERE imported_at IS NULL
    ORDER BY drop_date, tld, domain
    LIMIT ?
  `);
  const markImported = zoneDb.prepare(`
    UPDATE zone_drop_candidates SET imported_at = datetime('now')
    WHERE domain = ? AND drop_date = ?
  `);
  let selected = 0;
  const byTld = {};

  try {
    while (true) {
      const rows = selectBatch.all(batchSize);
      if (!rows.length) break;
      database.transaction((items) => {
        for (const row of items) {
          const domain = String(row.domain || '').toLowerCase();
          const baseName = String(row.base_name || '').toLowerCase();
          const tld = dottedTld(row.tld);
          upsertDomain.run({
            domain,
            base_name: baseName,
            tld,
            source: ZONE_DIFF_SOURCE,
            length: Number(row.length || baseName.length),
            has_numbers: /[0-9]/.test(baseName) ? 1 : 0,
            has_hyphens: baseName.includes('-') ? 1 : 0,
            drop_date: row.drop_date,
            tlds_taken: Number(row.tld_count || 0),
            tlds_checked_at: new Date().toISOString(),
          });
          dropUniverse.recordDropEvent({
            domain,
            tld,
            source: ZONE_DIFF_SOURCE,
            sourceKind: 'zone-deletion-diff',
            sourceEventAt: sourceEventAt(row.drop_date),
            priorRegisteredEvidence: `${ZONE_DIFF_SOURCE}: present in prior snapshot and absent from ${row.drop_date} snapshot`,
            releasedAt: null,
            registrationAvailable: null,
          });
          byTld[tld] = (byTld[tld] || 0) + 1;
        }
      })(rows);
      zoneDb.transaction((items) => {
        for (const row of items) markImported.run(row.domain, row.drop_date);
      })(rows);
      selected += rows.length;
      await yieldToEventLoop();
    }
    const coverage = reconcileCzdsCoverage({ zoneDb, database, dropUniverse });
    return { imported: selected, selected, byTld, ...coverage };
  } finally {
    if (!suppliedZoneDb) zoneDb.close();
  }
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  ZONE_DIFF_PROVIDER,
  ZONE_DIFF_SOURCE,
  importCzdsDropCandidates,
  reconcileCzdsCoverage,
};
