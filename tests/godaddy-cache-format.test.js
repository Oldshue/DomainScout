'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-godaddy-cache-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;

const {
  getGoDaddyInventoryCacheMeta,
  readGoDaddyInventoryCache,
  readGoDaddyInventoryIndex,
  validateGoDaddyInventorySnapshot,
  writeGoDaddyInventoryCache,
} = require('../server/godaddy-cache');

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
  ];
  const validation = validateGoDaddyInventorySnapshot('godaddy-auction', rows, { minCount: 2 });
  assert.equal(validation.ok, true);
  writeGoDaddyInventoryCache('godaddy-auction', rows, {
    generatedAt: '2026-08-10T16:00:00.000Z',
    evidence: { sourceFeed: 'fixture.csv.zip', sha256: 'feed-hash' },
    validation,
  });

  const payload = readGoDaddyInventoryCache('godaddy-auction');
  assert.equal(payload.count, 2);
  assert.equal(payload.domains[0].metrics.valuationprice, 200);
  assert.equal(payload.domains[0].expiry_date, undefined, 'null-only legacy fields stay omitted');

  const index = readGoDaddyInventoryIndex('godaddy-auction');
  assert.deepEqual(index.rows.map(item => item.domain), ['sooner.com', 'later.com']);
  assert.equal(index.generatedAt, '2026-08-10T16:00:00.000Z');

  const meta = getGoDaddyInventoryCacheMeta('godaddy-auction');
  assert.equal(meta.snapshotFormat, 'compact-columns-v1');
  assert.equal(meta.evidence.sha256, 'feed-hash');
  assert.equal(meta.validation.ok, true);
  assert.match(meta.snapshotSha256, /^[a-f0-9]{64}$/);
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
