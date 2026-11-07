'use strict';

// Small, durable interactive projection for the only Sale Watch view. The
// forensic discovery snapshot remains the raw evidence store; rebuilding this
// projection happens out of process and commits atomically, while HTTP reads
// touch only the indexed likely-sale rows.

const fs = require('node:fs');
const path = require('node:path');

const TABLE = 'sale_watch_probable';
const FTS = 'sale_watch_probable_fts';

function ensureProjectionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      domain TEXT PRIMARY KEY,
      report_date TEXT NOT NULL DEFAULT '',
      entry_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sale_watch_probable_chronology
      ON ${TABLE}(report_date DESC, domain ASC);
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS}
      USING fts5(domain UNINDEXED, body, tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS sale_watch_probable_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function searchableText(entry) {
  const assessment = entry.assessment || {};
  return [entry.domain, entry.buyerTitle, entry.buyer, entry.venue,
    assessment.basis, ...(assessment.signals || [])]
    .filter(Boolean).join(' ');
}

function rebuildProjection(db, { ledgerPath, discoveryPath }) {
  ensureProjectionSchema(db);
  const { readSaleWatchLedger } = require('./sale-watch');
  const ledger = readSaleWatchLedger(ledgerPath, discoveryPath, []);
  const rows = ledger.entries.filter(row => row.classification === 'likely-sale');
  const replace = db.prepare(`INSERT INTO ${TABLE}(domain,report_date,entry_json) VALUES(?,?,?)`);
  const replaceFts = db.prepare(`INSERT INTO ${FTS}(rowid,domain,body) VALUES(?,?,?)`);
  const rowid = db.prepare(`SELECT rowid FROM ${TABLE} WHERE domain=?`);
  const source = fs.statSync(discoveryPath);
  db.transaction(() => {
    db.prepare(`DELETE FROM ${FTS}`).run();
    db.prepare(`DELETE FROM ${TABLE}`).run();
    for (const row of rows) {
      // Marking the materialized verdict prevents a second per-request
      // adjudication. The classifier version is recorded in metadata below.
      const stored = { ...row, storedAssessment: true };
      replace.run(row.domain, String(row.reportDate || '').slice(0, 10), JSON.stringify(stored));
      const id = rowid.get(row.domain).rowid;
      replaceFts.run(id, row.domain, searchableText(row));
    }
    const put = db.prepare('INSERT OR REPLACE INTO sale_watch_probable_meta(key,value) VALUES(?,?)');
    put.run('source', JSON.stringify({ path: path.resolve(discoveryPath), size: source.size, mtimeMs: source.mtimeMs }));
    put.run('classifierVersion', String(ledger.classifierVersion || ''));
    put.run('generatedAt', new Date().toISOString());
    put.run('evidenceGeneratedAt', String(ledger.generatedAt || ''));
    put.run('evidenceCoverage', JSON.stringify({
      discoveryMode: ledger.coverage?.discoveryMode || 'awaiting-first-scan',
      nameserverDiscovery: ledger.coverage?.nameserverDiscovery || null,
      nameserverDeparturesInspected: Number(ledger.coverage?.nameserverDeparturesInspected || 0),
      nameserverAssociationsExposed: Number(ledger.coverage?.nameserverAssociationsExposed || 0),
    }));
    put.run('count', String(rows.length));
  })();
  return { count: rows.length, sourceBytes: source.size };
}

function ftsQuery(value) {
  const words = String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 8).map(word => `"${word.replace(/"/g, '""')}"*`).join(' AND ');
}

function readProbableProjection(db, { limit = 101, q = '', after = null, days = null } = {}) {
  const capped = Math.max(1, Math.min(101, Math.floor(Number(limit) || 101)));
  const match = ftsQuery(q);
  const cutoff = Number(days) >= 1
    ? new Date(Date.now() - Math.floor(Number(days)) * 86400000).toISOString().slice(0, 10)
    : '';
  const params = {
    limit: capped,
    cutoff,
    cursorDate: String(after?.date || ''),
    cursorDomain: String(after?.domain || ''),
    hasCursor: after ? 1 : 0,
  };
  const join = match ? `JOIN ${FTS} f ON f.rowid=p.rowid` : '';
  if (match) params.match = match;
  const searchWhere = match ? `AND ${FTS} MATCH @match` : '';
  const rows = db.prepare(`
    SELECT p.entry_json FROM ${TABLE} p ${join}
    WHERE (@cutoff='' OR p.report_date >= @cutoff)
      ${searchWhere}
      AND (@hasCursor=0 OR p.report_date < @cursorDate
        OR (p.report_date=@cursorDate AND p.domain>@cursorDomain))
    ORDER BY p.report_date DESC, p.domain ASC
    LIMIT @limit
  `).all(params).map(row => JSON.parse(row.entry_json));
  const metaRows = db.prepare('SELECT key,value FROM sale_watch_probable_meta').all();
  const meta = Object.fromEntries(metaRows.map(row => [row.key, row.value]));
  if (!meta.generatedAt) {
    return {
      status: 'pending',
      entries: [],
      source: 'pending',
      ledgerStore: { serving: 'indexed-probable-projection', assessed: 0, total: 0, generatedAt: null },
    };
  }
  let coverage = null;
  try { coverage = JSON.parse(meta.evidenceCoverage || 'null'); } catch (_) { coverage = null; }
  return {
    entries: rows,
    source: 'stored',
    generatedAt: meta.evidenceGeneratedAt || null,
    coverage,
    ledgerStore: { serving: 'indexed-probable-projection', assessed: Number(meta.count || 0), total: Number(meta.count || 0), generatedAt: meta.generatedAt || null },
  };
}

module.exports = { TABLE, FTS, ensureProjectionSchema, rebuildProjection, readProbableProjection, ftsQuery };
