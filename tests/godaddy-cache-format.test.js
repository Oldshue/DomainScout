'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cacheSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'godaddy-cache.js'), 'utf8');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-godaddy-cache-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;

const {
  getGoDaddyInventoryCacheMeta,
  readGoDaddyInventoryCache,
  readGoDaddyInventoryIndex,
  validateGoDaddyInventorySnapshot,
  writeGoDaddyInventoryCache,
} = require('../server/godaddy-cache');
const { buildPageFromIndex } = require('../server/godaddy-query');

function row(domain, end, price = 10) {
  const name = domain.split('.')[0];
  return {
    domain,
    tld: `.${domain.split('.').slice(1).join('.')}`,
    stream: 'godaddy-auction',
    source: 'GoDaddy Auction',
    auction_price: price,
    auction_end: end,
    auction_url: `https://www.godaddy.com/domain-auctions/${name}-1`,
    age_years: 5,
    bid_count: 2,
    length: name.length,
    has_numbers: 0,
    has_hyphens: 0,
    tlds_taken: 3,
    source_feed: 'fixture.csv.zip',
    metrics: { valuationprice: 200 },
  };
}

test('compact cache round-trips full rows and sorted UI index with evidence', () => {
  const rows = [
    row('later.com', '2026-08-11T12:00:00Z', 20),
    row('sooner.com', '2026-08-10T18:00:00Z', 5),
    ...Array.from({ length: 9_998 }, (_, index) => row(
      `fixture${index}.com`,
      new Date(Date.parse('2026-08-13T00:00:00.000Z') + index * 1000).toISOString(),
      30,
    )),
  ];
  const validation = validateGoDaddyInventorySnapshot('godaddy-auction', rows, { minCount: 2 });
  assert.equal(validation.ok, true);
  writeGoDaddyInventoryCache('godaddy-auction', rows, {
    generatedAt: '2026-08-10T16:00:00.000Z',
    evidence: { sourceFeed: 'fixture.csv.zip', sha256: 'feed-hash' },
    validation,
  });

  const payload = readGoDaddyInventoryCache('godaddy-auction');
  assert.equal(payload.count, 10_000);
  assert.equal(payload.domains[0].metrics.valuationprice, 200);
  assert.equal(payload.domains[0].expiry_date, undefined, 'null-only legacy fields stay omitted');

  const index = readGoDaddyInventoryIndex('godaddy-auction');
  assert.equal(index.compactRows.length, 10_000, 'the persisted tuple index stays compact in memory');
  assert.deepEqual(index.rows.slice(0, 2).map(item => item.domain), ['sooner.com', 'later.com']);
  assert.equal(index.generatedAt, '2026-08-10T16:00:00.000Z');

  const meta = getGoDaddyInventoryCacheMeta('godaddy-auction');
  assert.equal(meta.snapshotFormat, 'provider-compact-columns-v2');
  assert.equal(meta.evidence.sha256, 'feed-hash');
  assert.equal(meta.validation.ok, true);
  assert.match(meta.snapshotSha256, /^[a-f0-9]{64}$/);
});

test('snapshot publication projects rows incrementally instead of duplicating the inventory', () => {
  const writerStart = cacheSource.indexOf('function writeGoDaddyInventoryUiIndex');
  const writerEnd = cacheSource.indexOf('\nfunction readGoDaddyInventoryCache', writerStart);
  const writers = cacheSource.slice(writerStart, writerEnd);
  assert.match(cacheSource, /writeCompactPayloadFile\(filePath, header, rows, columns, projectRow/);
  assert.doesNotMatch(writers, /domains\.map\(cacheDomainRow\)/);
  assert.doesNotMatch(writers, /domains\.map\(cacheDomainIndexRow\)/);
  assert.match(writers, /domains\.slice\(\)\.sort\(compareIndexRowsByAuctionEnd\)/);
});

test('default auction page materializes only returned rows from a compact index', () => {
  const columns = [
    'domain', 'tld', 'stream', 'source', 'auction_price', 'auction_end', 'auction_url',
    'age_years', 'bid_count', 'length', 'has_numbers', 'has_hyphens', 'tlds_taken',
  ];
  const compactRows = Array.from({ length: 10_000 }, (_, index) => [
    `name${index}.com`, '.com', 'godaddy-auction', 'GoDaddy Auction', 10,
    new Date(Date.parse('2026-08-12T00:00:00.000Z') + index * 1000).toISOString(),
    `https://example.test/${index}`, 5, 0, `name${index}`.length, 0, 0, 2,
  ]);
  const compactIndex = {
    stream: 'godaddy-auction',
    excludeEnded: true,
    generatedAt: '2026-08-11T18:00:00.000Z',
    compactRows,
    compactColumns: columns,
    compactColumnIndex: Object.fromEntries(columns.map((column, index) => [column, index])),
  };
  Object.defineProperty(compactIndex, 'rows', {
    get() { throw new Error('default page must not inflate the full compact index'); },
  });
  Object.defineProperty(compactIndex, 'byAuctionEndAsc', {
    get() { throw new Error('default page must not allocate a full end-index object graph'); },
  });

  const page = buildPageFromIndex(compactIndex, {}, {
    sortBy: 'auction_end', sortDir: 'ASC', pageNum: 2, limitNum: 250,
    dateWindow: null, dateFilterIgnoredReason: null, overrides: null,
    nowMs: Date.parse('2026-08-11T12:00:00.000Z'),
  });

  assert.equal(page.total, 10_000);
  assert.equal(page.pageRows.length, 250);
  assert.equal(page.pageRows[0].domain, 'name250.com');
  assert.equal(page.pageRows[249].domain, 'name499.com');

  const filtered = buildPageFromIndex(compactIndex, {
    minLength: '8', maxPrice: '10', minTlds: '2', noHyphens: '1',
  }, {
    sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 25,
    dateWindow: null, dateFilterIgnoredReason: null, overrides: null,
    nowMs: Date.parse('2026-08-11T12:00:00.000Z'),
  });
  assert.equal(filtered.total, 9_000);
  assert.equal(filtered.pageRows.length, 25);
  assert.equal(filtered.pageRows[0].domain, 'name1000.com');

  const alternateSort = buildPageFromIndex(compactIndex, { maxLength: '6' }, {
    sortBy: 'domain', sortDir: 'DESC', pageNum: 1, limitNum: 10,
    dateWindow: null, dateFilterIgnoredReason: null, overrides: null,
    nowMs: Date.parse('2026-08-11T12:00:00.000Z'),
  });
  assert.equal(alternateSort.total, 100);
  assert.equal(alternateSort.pageRows.length, 10);
  assert.equal(alternateSort.pageRows[0].domain, 'name99.com');

  const takenInAi = buildPageFromIndex(compactIndex, {
    takenIn: '.ai', takenInMode: 'taken', takenInMatch: 'all', takenInEvidence: 'partial',
  }, {
    sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 25,
    dateWindow: null, dateFilterIgnoredReason: null, overrides: null,
    nowMs: Date.parse('2026-08-11T12:00:00.000Z'),
    takenInBaseSets: [new Set(['name17', 'name211'])],
  });
  assert.equal(takenInAi.total, 2);
  assert.deepEqual(takenInAi.pageRows.map(item => item.domain), ['name17.com', 'name211.com']);

  const takenInAiByExtensionCount = buildPageFromIndex(compactIndex, {
    takenIn: '.ai', takenInMode: 'taken', takenInMatch: 'all', takenInEvidence: 'partial',
  }, {
    sortBy: 'tlds_taken', sortDir: 'DESC', pageNum: 1, limitNum: 25,
    dateWindow: null, dateFilterIgnoredReason: null, overrides: null,
    nowMs: Date.parse('2026-08-11T12:00:00.000Z'),
    takenInBaseSets: [new Set(['name17', 'name211'])],
    sortValuesByBase: { name17: 2, name211: 9 },
  });
  assert.deepEqual(takenInAiByExtensionCount.pageRows.map(item => item.domain), ['name211.com', 'name17.com']);

  // Unrelated capability fixture: the same generic contract intersects multiple
  // provider projections without a DomainScout/.ai-specific query branch.
  const takenInAiAndShop = buildPageFromIndex(compactIndex, {
    takenIn: '.ai,.shop', takenInMode: 'taken', takenInMatch: 'all', takenInEvidence: 'partial',
  }, {
    sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 25,
    dateWindow: null, dateFilterIgnoredReason: null, overrides: null,
    nowMs: Date.parse('2026-08-11T12:00:00.000Z'),
    takenInBaseSets: [new Set(['name17', 'name211']), new Set(['name211', 'name800'])],
  });
  assert.deepEqual(takenInAiAndShop.pageRows.map(item => item.domain), ['name211.com']);
});

test('candidate validation rejects duplicate domains and malformed timestamps', () => {
  const rows = [
    row('duplicate.com', 'not-a-time'),
    row('duplicate.com', '2026-08-11T12:00:00Z'),
  ];
  const validation = validateGoDaddyInventorySnapshot('godaddy-auction', rows, {
    minCount: 2,
    minTimestampRatio: 1,
  });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(' '), /duplicate domain/);
  assert.match(validation.errors.join(' '), /auction_end coverage/);
});
