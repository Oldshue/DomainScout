const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_BASE = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const DB_PATH = path.join(DATA_BASE, 'zone_index.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 10000');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS research_prefix_hits (
      prefix     TEXT NOT NULL,
      base_name  TEXT NOT NULL,
      tld        TEXT NOT NULL,
      source     TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (prefix, base_name, tld)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_rph_prefix_tld
      ON research_prefix_hits(prefix, tld);

    CREATE TABLE IF NOT EXISTS research_prefix_sources (
      prefix        TEXT NOT NULL,
      tld           TEXT NOT NULL,
      file_date     TEXT,
      status        TEXT NOT NULL,
      matched_count INTEGER NOT NULL DEFAULT 0,
      checked_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (prefix, tld)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS research_prefix_meta (
      prefix           TEXT PRIMARY KEY,
      status           TEXT NOT NULL,
      total_tlds       INTEGER NOT NULL DEFAULT 0,
      checked_tlds     INTEGER NOT NULL DEFAULT 0,
      failed_tlds      INTEGER NOT NULL DEFAULT 0,
      names            INTEGER NOT NULL DEFAULT 0,
      hits             INTEGER NOT NULL DEFAULT 0,
      last_started_at  TEXT,
      last_finished_at TEXT,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const metaColumns = new Set(_db.prepare('PRAGMA table_info(research_prefix_meta)').all().map(row => row.name));
  if (!metaColumns.has('failed_tlds')) {
    _db.exec('ALTER TABLE research_prefix_meta ADD COLUMN failed_tlds INTEGER NOT NULL DEFAULT 0');
  }
  return _db;
}

function normalizePrefix(prefix) {
  return String(prefix || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
}

function startPrefixCorpus(prefix, totalTlds, accessibleTlds = []) {
  const p = normalizePrefix(prefix);
  const db = getDb();
  const normalizedTlds = [...new Set(accessibleTlds
    .map(tld => String(tld || '').toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
    .map(tld => `.${tld}`))];
  if (normalizedTlds.length) {
    const encoded = JSON.stringify(normalizedTlds);
    db.transaction(() => {
      db.prepare(`DELETE FROM research_prefix_hits
        WHERE prefix = ? AND tld NOT IN (SELECT value FROM json_each(?))`).run(p, encoded);
      db.prepare(`DELETE FROM research_prefix_sources
        WHERE prefix = ? AND tld NOT IN (SELECT value FROM json_each(?))`).run(p, encoded);
    })();
  }
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM research_prefix_sources WHERE prefix = ? AND status = 'done') AS checked_tlds,
      (SELECT COUNT(*) FROM research_prefix_sources WHERE prefix = ? AND status = 'failed') AS failed_tlds,
      (SELECT COUNT(DISTINCT base_name) FROM research_prefix_hits WHERE prefix = ?) AS names,
      (SELECT COUNT(*) FROM research_prefix_hits WHERE prefix = ?) AS hits
  `).get(p, p, p, p);
  getDb().prepare(`
    INSERT INTO research_prefix_meta (prefix, status, total_tlds, checked_tlds, failed_tlds, names, hits, last_started_at, updated_at)
    VALUES (?, 'running', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(prefix) DO UPDATE SET
      status = 'running',
      total_tlds = excluded.total_tlds,
      checked_tlds = excluded.checked_tlds,
      failed_tlds = excluded.failed_tlds,
      names = excluded.names,
      hits = excluded.hits,
      last_started_at = excluded.last_started_at,
      updated_at = excluded.updated_at
  `).run(p, normalizedTlds.length || totalTlds || 0, stats.checked_tlds || 0, stats.failed_tlds || 0, stats.names || 0, stats.hits || 0);
}

function refreshPrefixMeta(prefix, status = null) {
  const p = normalizePrefix(prefix);
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM research_prefix_sources WHERE prefix = ? AND status = 'done') AS checked_tlds,
      (SELECT COUNT(*) FROM research_prefix_sources WHERE prefix = ? AND status = 'failed') AS failed_tlds,
      (SELECT COUNT(DISTINCT base_name) FROM research_prefix_hits WHERE prefix = ?) AS names,
      (SELECT COUNT(*) FROM research_prefix_hits WHERE prefix = ?) AS hits
  `).get(p, p, p, p);

  const current = db.prepare('SELECT total_tlds FROM research_prefix_meta WHERE prefix = ?').get(p);
  const totalTlds = current?.total_tlds || 0;
  const requestedStatus = status || 'running';
  const effectiveStatus = requestedStatus === 'complete'
    ? ((stats.checked_tlds === totalTlds && stats.failed_tlds === 0) ? 'complete' : 'partial')
    : requestedStatus;
  db.prepare(`
    INSERT INTO research_prefix_meta (prefix, status, total_tlds, checked_tlds, failed_tlds, names, hits, updated_at, last_finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), CASE WHEN ? != 'running' THEN datetime('now') ELSE NULL END)
    ON CONFLICT(prefix) DO UPDATE SET
      status = excluded.status,
      total_tlds = excluded.total_tlds,
      checked_tlds = excluded.checked_tlds,
      failed_tlds = excluded.failed_tlds,
      names = excluded.names,
      hits = excluded.hits,
      updated_at = excluded.updated_at,
      last_finished_at = COALESCE(excluded.last_finished_at, research_prefix_meta.last_finished_at)
  `).run(
    p,
    effectiveStatus,
    totalTlds,
    stats.checked_tlds || 0,
    stats.failed_tlds || 0,
    stats.names || 0,
    stats.hits || 0,
    effectiveStatus,
  );
  return getPrefixCorpusStats(p);
}

function finishPrefixCorpus(prefix, status = 'complete') {
  return refreshPrefixMeta(prefix, status);
}

function replacePrefixTldHits(prefix, tld, fileDate, names, source = 'czds-prefix') {
  const p = normalizePrefix(prefix);
  const dotTld = String(tld || '').startsWith('.') ? tld : `.${tld}`;
  const cleanNames = [...new Set(names || [])]
    .map(n => String(n || '').toLowerCase())
    .filter(n => n.startsWith(p) && !n.includes('.'));

  const db = getDb();
  const insertHit = db.prepare(`
    INSERT OR IGNORE INTO research_prefix_hits (prefix, base_name, tld, source, checked_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  const upsertSource = db.prepare(`
    INSERT INTO research_prefix_sources (prefix, tld, file_date, status, matched_count, checked_at)
    VALUES (?, ?, ?, 'done', ?, datetime('now'))
    ON CONFLICT(prefix, tld) DO UPDATE SET
      file_date = excluded.file_date,
      status = excluded.status,
      matched_count = excluded.matched_count,
      checked_at = excluded.checked_at
  `);

  db.transaction(() => {
    db.prepare('DELETE FROM research_prefix_hits WHERE prefix = ? AND tld = ?').run(p, dotTld);
    for (const name of cleanNames) insertHit.run(p, name, dotTld, source);
    upsertSource.run(p, dotTld, fileDate || null, cleanNames.length);
  })();

  return cleanNames.length;
}

function markPrefixTldFailed(prefix, tld, fileDate, status = 'failed') {
  const p = normalizePrefix(prefix);
  const dotTld = String(tld || '').startsWith('.') ? tld : `.${tld}`;
  getDb().prepare(`
    INSERT INTO research_prefix_sources (prefix, tld, file_date, status, matched_count, checked_at)
    VALUES (?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(prefix, tld) DO UPDATE SET
      file_date = excluded.file_date,
      status = excluded.status,
      checked_at = excluded.checked_at
  `).run(p, dotTld, fileDate || null, status);
}

function isPrefixTldCurrent(prefix, tld, fileDate) {
  const p = normalizePrefix(prefix);
  const dotTld = String(tld || '').startsWith('.') ? tld : `.${tld}`;
  const row = getDb().prepare(`
    SELECT file_date, status FROM research_prefix_sources
    WHERE prefix = ? AND tld = ?
  `).get(p, dotTld);
  return !!row && row.status === 'done' && row.file_date === fileDate;
}

function queryPrefixCorpus(prefix) {
  const p = normalizePrefix(prefix);
  if (!p) return [];
  return getDb().prepare(`
    SELECT base_name, COUNT(*) AS tld_count, GROUP_CONCAT(tld) AS tld_list
    FROM research_prefix_hits
    WHERE prefix = ?
    GROUP BY base_name
    ORDER BY tld_count DESC, base_name ASC
  `).all(p);
}

function getPrefixCorpusStats(prefix) {
  const p = normalizePrefix(prefix);
  if (!p) return null;
  const row = getDb().prepare(`
    SELECT prefix, status, total_tlds, checked_tlds, failed_tlds, names, hits, last_started_at, last_finished_at, updated_at
    FROM research_prefix_meta
    WHERE prefix = ?
  `).get(p);
  if (!row) {
    const quick = getDb().prepare(`
      SELECT COUNT(DISTINCT base_name) AS names, COUNT(*) AS hits, COUNT(DISTINCT tld) AS checked_tlds
      FROM research_prefix_hits
      WHERE prefix = ?
    `).get(p);
    return {
      prefix: p,
      status: 'missing',
      total_tlds: 0,
      checked_tlds: quick.checked_tlds || 0,
      failed_tlds: 0,
      names: quick.names || 0,
      hits: quick.hits || 0,
    };
  }
  return {
    ...row,
    complete: row.status === 'complete' && row.total_tlds > 0 && row.checked_tlds === row.total_tlds && row.failed_tlds === 0,
  };
}

function listPrefixCorpora() {
  return getDb().prepare(`
    SELECT prefix, status, total_tlds, checked_tlds, failed_tlds, names, hits, last_started_at, last_finished_at, updated_at
    FROM research_prefix_meta
    ORDER BY updated_at DESC
  `).all();
}

module.exports = {
  normalizePrefix,
  startPrefixCorpus,
  refreshPrefixMeta,
  finishPrefixCorpus,
  replacePrefixTldHits,
  markPrefixTldFailed,
  isPrefixTldCurrent,
  queryPrefixCorpus,
  getPrefixCorpusStats,
  listPrefixCorpora,
};
