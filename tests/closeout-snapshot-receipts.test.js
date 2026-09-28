'use strict';

// GoDaddy closeouts are a snapshot-only stream (never inserted into `domains`).
// Their list rows must render exact whole-root extension counts from the SAME
// shared receipts every other stream uses, and a row is exact only once every
// extension in the universe carries a receipt. This builds a real closeout
// snapshot in a temp volume, pages it exactly as the closeout view does, and
// hydrates it from a shared receipt database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const volume = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-closeout-receipts-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = volume;

require('../server/provider-snapshot-registry');
const { publishLargeProviderSnapshot, readLargeProviderSnapshotIndex } = require('../server/large-provider-snapshot');
const { readGoDaddyInventoryIndex } = require('../server/godaddy-cache');
const { buildPageFromIndex } = require('../server/godaddy-query');
const { snapshotDemandCandidates } = require('../server/provider-snapshot-demand');
const { hydrateProviderExtensionEvidence } = require('../server/provider-extension-evidence');
const { createNameverseCoverageProducer, ensureNameverseCoverageSchema, projectCoverageReceipt } = require('../server/nameverse-coverage');
const { buildPreverifyOrder } = require('../server/preverify-order');

// Mirrors getSupportedTldUniverse(): count is always present in production.
const universe = { id: 'iana-root-tlds', version: 'closeout-v1', authoritative: true, count: 4, tlds: ['.com', '.io', '.net', '.xyz'] };

function receiptDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE domains (base_name TEXT, stream TEXT, tlds_taken INTEGER, tlds_checked_at TEXT);
    CREATE TABLE base_tld_counts (base_name TEXT PRIMARY KEY, tld_count INTEGER, source TEXT, updated_at TEXT);
    CREATE INDEX idx_base_tld_counts_count ON base_tld_counts(tld_count, base_name);
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY, count INTEGER NOT NULL, taken_json TEXT NOT NULL,
      all_count INTEGER NOT NULL, source TEXT, checked_at TEXT
    );
  `);
  return db;
}

function closeoutRows(count, generatedAt) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const base = `closeout${String(i).padStart(4, '0')}`;
    rows.push({
      domain: `${base}.com`, tld: '.com', stream: 'godaddy-closeout', source: 'GoDaddy',
      auction_price: 5 + (i % 40), auction_end: new Date(Date.UTC(2026, 8, 25, 0, i % 600)).toISOString(),
      auction_url: `https://example.invalid/${base}`, age_years: i % 12, bid_count: 0,
      length: base.length, has_numbers: 1, has_hyphens: 0,
      tlds_taken: null, tlds_lower_bound: null, tlds_verified: false, source_feed: 'fixture', metrics: null,
      generatedAt,
    });
  }
  return rows;
}

function pageRowsForView(index, limit) {
  const { pageRows, total } = buildPageFromIndex(index, {}, {
    sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: limit,
    dateWindow: null, nowMs: Date.parse('2026-09-28T00:00:00Z'),
  });
  return { pageRows: pageRows.map(row => ({ ...row })), total };
}

test('closeout snapshot rows become exact only from shared receipts covering every extension', async () => {
  const generatedAt = '2026-09-28T00:00:00.000Z';
  const manifest = publishLargeProviderSnapshot('godaddy-closeout', closeoutRows(1200, generatedAt), {
    generatedAt, evidence: { source: 'fixture-closeout-feed' },
  });
  assert.equal(manifest.count, 1200);

  const index = readGoDaddyInventoryIndex('godaddy-closeout');
  assert.ok(index, 'closeout snapshot index must be readable through the godaddy-cache facade');
  assert.equal(index, readLargeProviderSnapshotIndex('godaddy-closeout'));

  // The pre-verify producer sees every closeout row as demand, tagged by stream,
  // and orders it soonest-end first.
  const demand = snapshotDemandCandidates(index, { nowMs: Date.parse('2026-09-28T00:00:00Z'), endIsExpiry: false });
  assert.equal(demand.length, 1200);
  const order = buildPreverifyOrder({ 'godaddy-closeout': demand.map(c => ({ ...c })), 'godaddy-auction': [] });
  assert.equal(order[0].base_name, 'closeout0000');
  assert.equal(order[0].stream, 'godaddy-closeout');

  const db = receiptDb();
  const { pageRows, total } = pageRowsForView(index, 5);
  assert.equal(total, 1200);
  assert.equal(pageRows.length, 5);
  const first = pageRows[0].domain.split('.')[0];

  // The shared receipt schema is prepared at server boot before any view hydrates.
  ensureNameverseCoverageSchema(db);

  // 1. No receipts anywhere: every row is PENDING, never an estimate.
  hydrateProviderExtensionEvidence(db, pageRows, universe);
  for (const row of pageRows) {
    assert.equal(row.tlds_verified, false, `${row.domain} must be pending without receipts`);
    assert.equal(row.tlds_lower_bound, null);
  }

  // 2. A receipt that covers all but one extension (one lookup ambiguous) is
  //    still PENDING: partial coverage is never rendered as a count.
  let ambiguous = new Set(['.xyz']);
  const answers = { '.com': 'taken', '.io': 'taken', '.net': 'not_taken', '.xyz': 'not_taken' };
  const producer = createNameverseCoverageProducer({
    database: db,
    resolver: async (domain, tld) => (ambiguous.has(tld) ? 'unknown' : answers[tld]),
    concurrency: 4, source: 'fixture-dns',
  });
  const partial = await producer.refreshBaseName(first, universe);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.checkedCount, 3);
  const afterPartial = pageRowsForView(index, 5).pageRows;
  hydrateProviderExtensionEvidence(db, afterPartial, universe);
  const pendingRow = afterPartial.find(row => row.domain === `${first}.com`);
  assert.equal(pendingRow.tlds_verified, false, 'three of four receipts must not render as exact');
  assert.equal(projectCoverageReceipt(db.prepare('SELECT * FROM tld_check_cache WHERE base_name = ?').get(first), universe).extensions, null);

  // 3. The last missing extension lands: the row is exact from the shared receipt
  //    and the count equals the positives across the whole universe (.com + .io).
  ambiguous = new Set();
  const complete = await producer.refreshBaseName(first, universe);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.count, 2);
  const afterComplete = pageRowsForView(index, 5).pageRows;
  hydrateProviderExtensionEvidence(db, afterComplete, universe);
  const exactRow = afterComplete.find(row => row.domain === `${first}.com`);
  assert.equal(exactRow.tlds_verified, true);
  assert.equal(exactRow.tlds_taken, 2);
  assert.equal(exactRow.tlds_lower_bound, null);
  assert.equal(exactRow.tlds_checked_at, complete.completedAt);
  // Untouched neighbours remain pending: exactness is per label, never inferred.
  for (const row of afterComplete) {
    if (row.domain === `${first}.com`) continue;
    assert.equal(row.tlds_verified, false);
  }

  // 4. Ranking uses the same exact number the row displays: min-extensions filtering
  //    through the closeout query path sees the receipt-backed count.
  const evidenceByBase = { [first]: { tldsTaken: 2, tldsVerified: true, tldsLowerBound: null } };
  const filtered = buildPageFromIndex(index, { minTlds: '2', maxTlds: '2' }, {
    sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 50,
    dateWindow: null, nowMs: Date.parse('2026-09-28T00:00:00Z'),
    extensionEvidenceByBase: evidenceByBase,
  });
  assert.deepEqual(filtered.pageRows.map(row => row.domain), [`${first}.com`]);

  db.close();
  fs.rmSync(volume, { recursive: true, force: true });
});
