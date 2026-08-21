'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-provider-snapshot-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;

const {
  largeProviderSnapshotHealth,
  publishLargeProviderSnapshot,
  readLargeProviderSnapshotIndex,
  readLargeProviderSnapshotMeta,
  registerLargeProviderStream,
  _test,
} = require('../server/large-provider-snapshot');
const { buildPageFromIndex } = require('../server/godaddy-query');

const columns = [
  'domain', 'tld', 'stream', 'source', 'auction_price', 'auction_end', 'auction_url',
  'age_years', 'bid_count', 'length', 'has_numbers', 'has_hyphens', 'tlds_taken',
];

registerLargeProviderStream({
  stream: 'sedo-auction',
  columns,
  minCount: 2,
  maxAgeMs: 60 * 60 * 1000,
  maxDropFraction: 0.6,
  minTimestampRatio: 1,
  retainGenerations: 2,
  excludeEnded: true,
});

function rows(prefix, generatedAt) {
  return [
    { domain: `${prefix}-later.shop`, tld: '.shop', stream: 'sedo-auction', source: 'Sedo', auction_price: 20, auction_end: '2026-08-12T18:00:00.000Z', length: 10 },
    { domain: `${prefix}-sooner.com`, tld: '.com', stream: 'sedo-auction', source: 'Sedo', auction_price: 10, auction_end: '2026-08-12T17:00:00.000Z', length: 11 },
  ].map(row => ({ ...row, generatedAt }));
}

test('unrelated provider publishes a validated generation by atomic pointer and queries directly', () => {
  const manifest = publishLargeProviderSnapshot('sedo-auction', rows('first'), {
    generatedAt: '2026-08-12T16:30:00.000Z',
    evidence: { source: 'fixture-feed', etag: 'fixture-v1' },
  });
  assert.equal(manifest.count, 2);
  const meta = readLargeProviderSnapshotMeta('sedo-auction');
  assert.equal(meta.generationId, manifest.generationId);
  assert.equal(meta.snapshotFormat, 'provider-compact-columns-v2');
  assert.match(meta.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.lstatSync(path.join(dataDir, 'provider-snapshots', 'sedo-auction', 'current.json')).isSymbolicLink(), false);

  const index = readLargeProviderSnapshotIndex('sedo-auction');
  assert.equal(index.excludeEnded, true);
  const page = buildPageFromIndex(index, { tld: '.shop' }, {
    sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 25,
    nowMs: Date.parse('2026-08-12T16:00:00.000Z'),
  });
  assert.equal(page.total, 1);
  assert.equal(page.pageRows[0].domain, 'first-later.shop');

  const activePage = buildPageFromIndex(index, {}, {
    sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 25,
    nowMs: Date.parse('2026-08-12T17:30:00.000Z'),
    dateWindow: { start: '2026-08-12T16:00:00.000Z', end: '2026-08-12T19:00:00.000Z' },
  });
  assert.equal(activePage.total, 1, 'descriptor semantics exclude ended rows without a provider-name branch');
  assert.equal(activePage.pageRows[0].domain, 'first-later.shop');
  const querySource = fs.readFileSync(path.join(__dirname, '..', 'server', 'godaddy-query.js'), 'utf8');
  assert.doesNotMatch(querySource, /(?:index\.)?stream\s*===\s*['\"]godaddy-auction['\"]/, 'core query logic must remain provider-neutral');
});

test('failed candidate leaves the prior pointer intact and health is fail closed', () => {
  const before = readLargeProviderSnapshotMeta('sedo-auction');
  assert.throws(() => publishLargeProviderSnapshot('sedo-auction', [rows('bad')[0]], {
    generatedAt: '2026-08-12T16:31:00.000Z',
  }), /validation failed/);
  assert.equal(readLargeProviderSnapshotMeta('sedo-auction').generationId, before.generationId);
  const health = largeProviderSnapshotHealth('sedo-auction', Date.parse('2026-08-12T16:45:00.000Z'));
  assert.equal(health.current, true);
  assert.equal(health.serveable, true);
});

test('bounded retention keeps two complete generations and removes stale crash staging', () => {
  const generations = path.join(dataDir, 'provider-snapshots', 'sedo-auction', 'generations');
  const staleStage = path.join(generations, '.staging-999-dead');
  const recentOrphanStage = path.join(generations, '.staging-999999-recent-orphan');
  fs.mkdirSync(staleStage, { mode: 0o700 });
  fs.mkdirSync(recentOrphanStage, { mode: 0o700 });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(staleStage, old, old);
  publishLargeProviderSnapshot('sedo-auction', rows('second'), { generatedAt: '2026-08-12T16:32:00.000Z' });
  publishLargeProviderSnapshot('sedo-auction', rows('third'), { generatedAt: '2026-08-12T16:33:00.000Z' });
  const dirs = fs.readdirSync(generations, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name));
  assert.equal(dirs.length, 2);
  assert.equal(fs.existsSync(staleStage), false);
  assert.equal(fs.existsSync(recentOrphanStage), false, 'dead writers must not fill the volume for an hour');
  assert.equal(readLargeProviderSnapshotIndex('sedo-auction').rows[0].domain, 'third-sooner.com');
});

test('descriptor and filesystem boundaries reject traversal and symlink roots', () => {
  assert.throws(() => registerLargeProviderStream({ stream: '../escape', columns, minCount: 1 }), /bounded lowercase identifier/);
  registerLargeProviderStream({ stream: 'afternic-auction', columns, minCount: 1 });
  const root = path.join(dataDir, 'provider-snapshots', 'afternic-auction');
  fs.symlinkSync(os.tmpdir(), root);
  assert.throws(() => publishLargeProviderSnapshot('afternic-auction', [rows('safe')[0]]), /unsafe snapshot directory/);
});

test('publication capacity preserves a fixed query-volume reserve before writing', () => {
  const enough = _test.publicationCapacity({
    freeBytes: 900 * 1024 * 1024,
    totalBytes: 5_000 * 1024 * 1024,
    estimatedBytes: 300 * 1024 * 1024,
  });
  assert.equal(enough.ok, true);
  assert.equal(enough.reserveBytes, 500 * 1024 * 1024);

  const unsafe = _test.publicationCapacity({
    freeBytes: 700 * 1024 * 1024,
    totalBytes: 5_000 * 1024 * 1024,
    estimatedBytes: 300 * 1024 * 1024,
  });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.requiredBytes, 800 * 1024 * 1024);
});
