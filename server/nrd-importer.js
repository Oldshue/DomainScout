'use strict';

/**
 * Cloud-native NRD (newly-registered-domains) importer for DomainLab.
 *
 * Fills the exact tables DomainLab's daily-view endpoints read
 * (zone_daily_new_names, zone_daily_tokens, zone_daily_stats,
 * zone_keyword_trends / zone_keyword_tld_history) from the public WhoisDS
 * newly-registered-domains feed. Railway-gated by the caller (server/index.js) —
 * this module itself opens no DB connection and has no environment gating of
 * its own, so it stays inert wherever nothing calls it.
 *
 * Pure/injectable in the style of server/domainlab.js: every network and
 * side-effecting dependency (fetch, tokenize, recordTrends) is overridable via
 * opts for deterministic tests.
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');
const { domainToASCII } = require('node:url');
const { gzipSync } = require('node:zlib');
const { createS3ObjectStore } = require('./recent-registration-corpus');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { tokenizeDailyLabel } = require('./domainlab');
const { discoverFragments, ensureFragmentSchema } = require('./daily-fragments');
const { recordKeywordTrends } = require('./zone-indexer');

const NRD_USER_AGENT = 'DomainScout/1.0 (+https://domainscout-production-ea0f.up.railway.app)';
const NRD_FETCH_TIMEOUT_MS = 60000;
const NRD_MIN_BODY_BYTES = 1000;

/**
 * Fetch one day's NRD feed. Returns an array of raw lines, or null when the
 * feed is unavailable for any reason (non-200, tiny body, unzip failure,
 * network error) — never throws.
 */
async function fetchNrdDay(dateStr, opts = {}) {
  const httpClient = opts.axios || axios;
  try {
    const b64 = Buffer.from(`${dateStr}.zip`).toString('base64');
    const url = `https://www.whoisds.com/whois-database/newly-registered-domains/${b64}/nrd`;
    const response = await httpClient.get(url, {
      responseType: 'arraybuffer',
      timeout: NRD_FETCH_TIMEOUT_MS,
      maxRedirects: 5,
      headers: { 'User-Agent': NRD_USER_AGENT },
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      console.warn(`[NRD] ${dateStr}: feed unavailable (status ${response.status})`);
      return null;
    }
    const body = Buffer.from(response.data);
    if (body.length < NRD_MIN_BODY_BYTES) {
      console.warn(`[NRD] ${dateStr}: feed unavailable (body ${body.length} bytes)`);
      return null;
    }
    const zip = new AdmZip(body);
    const entry = zip.getEntries().find(e => /\.txt$/i.test(e.entryName));
    if (!entry) {
      console.warn(`[NRD] ${dateStr}: feed unavailable (no .txt entry in zip)`);
      return null;
    }
    const text = entry.getData().toString('utf8');
    return text.split(/\r?\n/);
  } catch (err) {
    console.warn(`[NRD] ${dateStr}: fetch failed (${err.message})`);
    return null;
  }
}

/** Normalize exact feed domains, preserving all suffix labels and accounting for every input row. */
function parseNrdLines(lines) {
  const byZone = new Map(), labelZones = new Map(), seen = new Set();
  const accounting = { inputRows: 0, emptyRows: 0, invalidRows: 0, duplicateRows: 0, acceptedNames: 0 };
  for (const raw of Array.isArray(lines) ? lines : []) {
    const value = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
    if (!value) { accounting.emptyRows++; continue; }
    accounting.inputRows++;
    const dom = domainToASCII(value);
    const parts = dom.split('.');
    if (!dom || dom.length > 253 || parts.length < 2 || parts.some(p => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)) || !/[a-z]/.test(parts.at(-1))) {
      accounting.invalidRows++; continue;
    }
    if (seen.has(dom)) { accounting.duplicateRows++; continue; }
    seen.add(dom);
    // Preserve the full suffix: foo.co.uk must never become foo.uk.
    const label = parts.shift(), tld = parts.join('.');
    if (!byZone.has(tld)) byZone.set(tld, []);
    byZone.get(tld).push(label);
    if (!labelZones.has(label)) labelZones.set(label, new Set());
    labelZones.get(label).add(tld);
    accounting.acceptedNames++;
  }
  return { byZone, labelZones, accounting };
}

function ensureNrdReceipts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS nrd_import_receipts (
    report_date TEXT PRIMARY KEY, source TEXT NOT NULL, source_digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL, completed_at TEXT NOT NULL
  )`);
}

function dateMinusDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns free disk space in MB for the volume backing db's file (better-sqlite3
 * exposes the database file path as db.name), or null on any error — statfs
 * unsupported on the platform, an in-memory db (name ':memory:'), or any other
 * failure. This guard must never break imports, so it never throws.
 */
function freeDiskMb(db) {
  try {
    if (!db.name || db.name === ':memory:') return null;
    const stats = fs.statfsSync(path.dirname(db.name));
    return (stats.bavail * stats.bsize) / 1e6;
  } catch (_) {
    return null;
  }
}

/**
 * Import one day of the NRD feed into a caller-owned better-sqlite3 handle on
 * zone_index.db. opts allows injecting {fetch, recordTrends, tokenize} for
 * tests. Never throws — every failure mode returns a structured result.
 */
async function importNrdDay(db, dateStr, opts = {}) {
  const fetchFn = opts.fetch || fetchNrdDay;
  const tokenizeFn = opts.tokenize || tokenizeDailyLabel;
  const recordTrendsFn = opts.recordTrends || recordKeywordTrends;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || new Date(dateStr).toISOString().slice(0, 10) !== dateStr) throw new Error('Invalid report date');
  ensureNrdReceipts(db);
  const receiptRow = db.prepare('SELECT receipt_json FROM nrd_import_receipts WHERE report_date = ?').get(dateStr);
  const already = db.prepare('SELECT 1 FROM zone_daily_new_names WHERE report_date = ? LIMIT 1').get(dateStr);
  if (receiptRow && !opts.rebuild) return { imported: false, reason: 'already-imported', receipt: JSON.parse(receiptRow.receipt_json) };
  if (already && !opts.rebuild && !opts.verifyLegacy) return { imported: false, reason: 'legacy-unverified', requiresRebuild: true };

  const lines = await fetchFn(dateStr);
  if (lines && lines.length > 1000001) throw new Error('NRD feed exceeds one-million-row bound');
  if (!lines) return { imported: false, reason: 'feed-unavailable' };

  const { byZone, labelZones, accounting } = parseNrdLines(lines);
  if (!byZone.size) return { imported: false, reason: 'feed-unavailable' };

  // tokenCounts: tld -> token -> { wordCount, regCount }
  // regCount is incremented once per LABEL containing the token that day
  // (tokenizeFn already de-dupes tokens within a single label).
  const tokenCounts = new Map();
  let totalNames = 0;
  for (const [tld, labels] of byZone.entries()) {
    totalNames += labels.length;
    const perTld = tokenCounts.get(tld) || new Map();
    for (const label of labels) {
      let tokens;
      tokens = tokenizeFn(label) || new Map();
      for (const [token, wordCount] of tokens.entries()) {
        const entry = perTld.get(token) || { wordCount, regCount: 0 };
        entry.regCount += 1;
        entry.wordCount = wordCount;
        perTld.set(token, entry);
      }
    }
    tokenCounts.set(tld, perTld);
  }

  const insertName = db.prepare('INSERT OR IGNORE INTO zone_daily_new_names (tld, report_date, base_name) VALUES (?, ?, ?)');
  const upsertToken = db.prepare(`
    INSERT INTO zone_daily_tokens (tld, report_date, token, word_count, reg_count)
    VALUES (@tld, @reportDate, @token, @wordCount, @regCount)
    ON CONFLICT(tld, report_date, token) DO UPDATE SET
      reg_count = excluded.reg_count,
      word_count = excluded.word_count
  `);
  const upsertStats = db.prepare(`
    INSERT OR REPLACE INTO zone_daily_stats (tld, stat_date, total_count, new_count, dropped_count, had_previous)
    VALUES (?, ?, NULL, ?, NULL, 0)
  `);

  ensureFragmentSchema(db);
  const fragments = new Map([...byZone].map(([tld, labels]) => [tld, discoverFragments(labels)]));
  fragments.set('*', discoverFragments([...labelZones.keys()]));
  fragments.set('!signal', discoverFragments([...labelZones].filter(([,zones])=>[...zones].some(tld=>tld!=='xyz')).map(([label])=>label)));
  const sourceBytes = Buffer.from(JSON.stringify(lines));
  const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
  const sourceKey = `domainscout/nrd-inputs/v1/${dateStr}/${sourceDigest}.json.gz`;
  const archive = gzipSync(sourceBytes);
  const store = opts.objectStore === undefined ? createS3ObjectStore() : opts.objectStore;
  let sourceArtifact = null;
  if (store) { await store.put(sourceKey, archive, 'application/gzip'); sourceArtifact = { storage: 'evidence-store', key: sourceKey }; }
  else if (db.name && db.name !== ':memory:') {
    const archiveDir = path.join(path.dirname(db.name), 'nrd-inputs');
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${dateStr}-${sourceDigest}.json.gz`);
    try { fs.writeFileSync(archivePath, archive, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    sourceArtifact = { storage: 'local-evidence', key: path.basename(archivePath) };
  }
  const receipt = {
    schema: 'domainscout.nrd-import/v1', date: dateStr, source: 'whoisds-public-nrd',
    sourceDigest, sourceArtifact,
    ...accounting, suffixCount: byZone.size, completedAt: new Date().toISOString(),
    feedProcessed: true, globalCoverage: 'unknown', analysisVersion: 2,
    coverageNote: 'Public provider feed; not a census of all registrations. Registration dates are provider-reported.',
  };
  const txn = db.transaction(() => {
    if (!opts.rebuild && db.prepare('SELECT 1 FROM nrd_import_receipts WHERE report_date = ?').get(dateStr)) return false;
    // Replacement is explicit, atomic and idempotent; failed tokenization leaves the prior day intact.
    if (opts.rebuild) {
      db.prepare('DELETE FROM zone_daily_tokens WHERE report_date = ?').run(dateStr);
      db.prepare('DELETE FROM zone_daily_new_names WHERE report_date = ?').run(dateStr);
      db.prepare('DELETE FROM zone_daily_stats WHERE stat_date = ?').run(dateStr);
    }
    for (const [tld, labels] of byZone.entries()) {
      for (const label of labels) insertName.run(tld, dateStr, label);
      upsertStats.run(tld, dateStr, labels.length);
      const perTld = tokenCounts.get(tld) || new Map();
      for (const [token, entry] of perTld.entries()) {
        upsertToken.run({ tld, reportDate: dateStr, token, wordCount: entry.wordCount, regCount: entry.regCount });
      }
    }
    db.prepare('DELETE FROM zone_daily_fragments WHERE report_date = ?').run(dateStr);
    const putFragment = db.prepare('INSERT INTO zone_daily_fragments VALUES (?, ?, ?, ?, ?, ?)');
    for (const [tld, rows] of fragments) for (const row of rows) putFragment.run(tld, dateStr, row.token, row.count, Number(row.visible), row.contexts);
    db.prepare('INSERT OR REPLACE INTO nrd_import_receipts VALUES (?, ?, ?, ?, ?)')
      .run(dateStr, receipt.source, receipt.sourceDigest, JSON.stringify(receipt), receipt.completedAt);
    return true;
  });
  if (!txn()) return { imported: false, reason: 'already-imported' };

  let tokenRowCount = 0;
  for (const perTld of tokenCounts.values()) tokenRowCount += perTld.size;

  const trendCandidates = new Map();
  for (const [label, tlds] of labelZones.entries()) {
    if (tlds.size >= 2) trendCandidates.set(label, tlds);
  }
  if (trendCandidates.size) {
    try { recordTrendsFn(trendCandidates, dateStr, { source: 'nrd-feed' }); }
    catch (err) { console.warn(`[NRD] ${dateStr}: recordTrends failed (${err.message})`); }
  }

  return {
    imported: true,
    receipt,
    names: totalNames,
    tokenRows: tokenRowCount,
    trendCandidates: trendCandidates.size,
  };
}

/**
 * Deletes rows older than the configured retention windows. Only ever
 * invoked on the Railway deployment, where the NRD lane is the sole writer
 * to these tables — a plain date cutoff is therefore safe. Never throws.
 */
function pruneNrdRetention(db, opts = {}) {
  const dailyDays = opts.dailyDays || parseInt(process.env.DOMAINSCOUT_DAILY_RETENTION_DAYS, 10) || 60;
  const trendDays = opts.trendDays || 270;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const dailyCutoff = dateMinusDays(today, dailyDays);
  const trendCutoff = dateMinusDays(today, trendDays);
  try {
    db.prepare('DELETE FROM zone_daily_tokens WHERE report_date < ?').run(dailyCutoff);
    db.prepare('DELETE FROM zone_daily_new_names WHERE report_date < ?').run(dailyCutoff);
    db.prepare('DELETE FROM zone_daily_stats WHERE stat_date < ?').run(dailyCutoff);
    for (const table of ['zone_daily_fragments', 'nrd_import_receipts']) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.prepare(`DELETE FROM ${table} WHERE report_date < ?`).run(dailyCutoff);
    }
    db.prepare('DELETE FROM zone_keyword_trends WHERE trend_date < ?').run(trendCutoff);
    db.prepare('DELETE FROM zone_keyword_tld_history WHERE trend_date < ?').run(trendCutoff);
  } catch (err) {
    console.warn(`[NRD] pruneNrdRetention failed: ${err.message}`);
  }
  return { dailyCutoff, trendCutoff };
}

/**
 * Iterates endDate going back `days` days (newest first), importing each day
 * sequentially. Catches and logs per-day errors with an [NRD] prefix, prunes
 * retention at the end, and never throws.
 *
 * Before the day loop, checks free disk space via opts.freeDiskMb(db) (test
 * injection point, in the style of opts.fetch/opts.tokenize/opts.recordTrends)
 * or the module's freeDiskMb by default, against a floor read from
 * DOMAINSCOUT_NRD_MIN_FREE_MB (default 400 MB). When free space is a finite
 * number below the floor, every day is skipped with reason 'disk-pressure'
 * (each result still recorded), retention pruning still runs (it frees
 * space), and the returned summary carries diskPressure: true. When the free
 * reading is null (unsupported/in-memory/error) or >= the floor, behavior is
 * byte-identical to before this guard existed — fail-open by construction.
 */
async function runNrdTopUp(db, opts = {}) {
  try {
    const days = opts.days || 3;
    const endDate = opts.endDate || dateMinusDays(new Date().toISOString().slice(0, 10), 1);

    const floor = parseInt(process.env.DOMAINSCOUT_NRD_MIN_FREE_MB, 10) || 400;
    let free = null;
    try { free = (opts.freeDiskMb || freeDiskMb)(db); } catch (_) { free = null; }
    const diskPressure = typeof free === 'number' && Number.isFinite(free) && free < floor;
    if (diskPressure) {
      console.warn(`[NRD] disk pressure: ${free.toFixed(0)}MB free < ${floor}MB floor — skipping import`);
    }

    const results = [];
    for (let i = 0; i < days; i++) {
      const dateStr = dateMinusDays(endDate, i);
      if (diskPressure) {
        results.push({ date: dateStr, imported: false, reason: 'disk-pressure' });
        continue;
      }
      try {
        const result = await importNrdDay(db, dateStr, opts);
        results.push({ date: dateStr, ...result });
        console.log(`[NRD] ${dateStr}: ${result.imported ? `imported (${result.names} names)` : result.reason}`);
      } catch (err) {
        console.warn(`[NRD] ${dateStr}: importNrdDay failed (${err.message})`);
        results.push({ date: dateStr, imported: false, reason: 'error', error: err.message });
      }
    }
    let prune = null;
    try { prune = pruneNrdRetention(db, opts); }
    catch (err) { console.warn(`[NRD] pruneNrdRetention failed: ${err.message}`); }
    const summary = { days, endDate, results, prune };
    if (diskPressure) summary.diskPressure = true;
    return summary;
  } catch (err) {
    console.warn(`[NRD] runNrdTopUp failed: ${err.message}`);
    return { days: opts.days || 3, endDate: opts.endDate || null, results: [], prune: null, error: err.message };
  }
}

module.exports = {
  fetchNrdDay,
  parseNrdLines,
  importNrdDay,
  pruneNrdRetention,
  runNrdTopUp,
  freeDiskMb,
  ensureNrdReceipts,
};
