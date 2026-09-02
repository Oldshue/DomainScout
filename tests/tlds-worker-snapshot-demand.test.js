'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { snapshotDemandCandidates } = require('../server/provider-snapshot-demand');

const NOW = Date.parse('2026-09-02T00:00:00.000Z');

test('returns [] for null/undefined/empty index', () => {
  assert.deepEqual(snapshotDemandCandidates(null), []);
  assert.deepEqual(snapshotDemandCandidates(undefined), []);
  assert.deepEqual(snapshotDemandCandidates({ compactRows: [], compactColumnIndex: { domain: 0, auction_end: 1 } }), []);
  assert.deepEqual(snapshotDemandCandidates({ rows: [] }), []);
});

test('compact-index fixture: drops ended rows, lowercases + dedupes base names keeping soonest end', () => {
  const index = {
    compactColumnIndex: { domain: 0, tld: 1, auction_end: 2 },
    compactRows: [
      ['Widget.com', '.com', '2026-09-10T00:00:00.000Z'],
      ['WIDGET.net', '.net', '2026-09-05T00:00:00.000Z'],
      ['ended.com', '.com', '2026-01-01T00:00:00.000Z'],
      ['widget.org', '.org', '2026-09-20T00:00:00.000Z'],
    ],
  };
  const out = snapshotDemandCandidates(index, { nowMs: NOW });
  assert.deepEqual(out, [{ base_name: 'widget', auction_end: '2026-09-05T00:00:00.000Z' }]);
});

test('row-object fixture: undated rows kept but sorted after dated rows; stable by base name for ties', () => {
  const index = {
    rows: [
      { domain: 'zeta.com', auction_end: null },
      { domain: 'alpha.com', auction_end: '2026-09-15T00:00:00.000Z' },
      { domain: 'beta.net', auction_end: null },
      { domain: 'gamma.com', auction_end: '2026-09-01T00:00:00.000Z' }, // ended (<= now)
    ],
  };
  const out = snapshotDemandCandidates(index, { nowMs: NOW });
  assert.deepEqual(out, [
    { base_name: 'alpha', auction_end: '2026-09-15T00:00:00.000Z' },
    { base_name: 'beta', auction_end: null },
    { base_name: 'zeta', auction_end: null },
  ]);
});

test('rows with empty base name are skipped', () => {
  const index = { rows: [{ domain: '.com', auction_end: '2026-09-10T00:00:00.000Z' }] };
  assert.deepEqual(snapshotDemandCandidates(index, { nowMs: NOW }), []);
});

// ── Source-regex tests on server/tlds-worker.js (style mirrors tests/godaddy-freshness-ui.test.js) ──
const root = path.resolve(__dirname, '..');
const tldsWorkerSrc = fs.readFileSync(path.join(root, 'server', 'tlds-worker.js'), 'utf8');

test('tlds-worker requires provider-snapshot-demand and godaddy-cache', () => {
  assert.match(tldsWorkerSrc, /require\(['"]\.\/provider-snapshot-demand['"]\)/);
  assert.match(tldsWorkerSrc, /require\(['"]\.\/godaddy-cache['"]\)/);
});

test('populateWorkQueue and topUpImminent both reference snapshotAuctionCandidates', () => {
  const populateStart = tldsWorkerSrc.indexOf('function populateWorkQueue');
  const populateEnd = tldsWorkerSrc.indexOf('\n// ── Worker loop', populateStart);
  assert.ok(populateStart >= 0 && populateEnd > populateStart, 'populateWorkQueue must exist');
  assert.match(tldsWorkerSrc.slice(populateStart, populateEnd), /snapshotAuctionCandidates/);

  const topUpStart = tldsWorkerSrc.indexOf('function topUpImminent');
  const topUpEnd = tldsWorkerSrc.indexOf('\n// Fast populate:', topUpStart);
  assert.ok(topUpStart >= 0 && topUpEnd > topUpStart, 'topUpImminent must exist');
  assert.match(tldsWorkerSrc.slice(topUpStart, topUpEnd), /snapshotAuctionCandidates/);
});

test('top-up anti-join queries tld_check_cache with a batched base_name IN list', () => {
  const topUpStart = tldsWorkerSrc.indexOf('function topUpImminent');
  const topUpEnd = tldsWorkerSrc.indexOf('\n// Fast populate:', topUpStart);
  const topUp = tldsWorkerSrc.slice(topUpStart, topUpEnd);
  assert.match(topUp, /FROM tld_check_cache/);
  assert.match(topUp, /base_name IN \(/);
  assert.match(topUp, /i \+= 900/);
});

test('does not require ./tlds-worker directly (it opens the real database at require time)', () => {
  const thisTestSrc = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(thisTestSrc, /require\(['"]\.\.\/server\/tlds-worker['"]\)/);
});

test('tlds-worker requires ./large-provider-snapshot', () => {
  assert.match(tldsWorkerSrc, /require\(['"]\.\/large-provider-snapshot['"]\)/);
});

test('snapshotAuctionCandidates releases the snapshot index after extracting demand and uses the memo', () => {
  const start = tldsWorkerSrc.indexOf('function snapshotAuctionCandidates');
  const end = tldsWorkerSrc.indexOf('\n// ── Persistent work queue', start);
  assert.ok(start >= 0 && end > start, 'snapshotAuctionCandidates must exist');
  const body = tldsWorkerSrc.slice(start, end);
  assert.match(body, /releaseLargeProviderSnapshotIndex\(/);
  assert.match(tldsWorkerSrc, /_snapshotCandidatesMemo/);
});

test('releaseLargeProviderSnapshotIndex is exported and returns false for an unknown stream', () => {
  const { releaseLargeProviderSnapshotIndex } = require('../server/large-provider-snapshot');
  assert.equal(typeof releaseLargeProviderSnapshotIndex, 'function');
  assert.equal(releaseLargeProviderSnapshotIndex('no-such-stream-xyz'), false);
});
