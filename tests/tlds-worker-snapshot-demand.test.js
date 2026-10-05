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

test('does not require ./tlds-worker directly (it opens the real database at require time)', () => {
  const thisTestSrc = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(thisTestSrc, /require\(['"]\.\.\/server\/tlds-worker['"]\)/);
});

test('tlds-worker requires ./large-provider-snapshot', () => {
  assert.match(tldsWorkerSrc, /require\(['"]\.\/large-provider-snapshot['"]\)/);
});

test('snapshotAuctionCandidates releases all snapshot caches and bounds extracted demand', () => {
  const start = tldsWorkerSrc.indexOf('function snapshotAuctionCandidates');
  const end = tldsWorkerSrc.indexOf('\n// ── Persistent work queue', start);
  assert.ok(start >= 0 && end > start, 'snapshotAuctionCandidates must exist');
  const body = tldsWorkerSrc.slice(start, end);
  assert.match(body, /releaseLargeProviderSnapshotCaches\(/);
  assert.match(body, /limit: QUEUE_MAX/);
  assert.doesNotMatch(tldsWorkerSrc, /_snapshotCandidatesMemo/);
});

test('releaseLargeProviderSnapshotIndex is exported and returns false for an unknown stream', () => {
  const { releaseLargeProviderSnapshotIndex, releaseLargeProviderSnapshotCaches } = require('../server/large-provider-snapshot');
  assert.equal(typeof releaseLargeProviderSnapshotIndex, 'function');
  assert.equal(releaseLargeProviderSnapshotIndex('no-such-stream-xyz'), false);
  assert.equal(typeof releaseLargeProviderSnapshotCaches, 'function');
  assert.equal(releaseLargeProviderSnapshotCaches('no-such-stream-xyz'), false);
});

test('bounded sorted compact demand stops at the limit and skips excluded labels', () => {
  const index = {
    sortedBy: 'auction_end_asc',
    compactColumnIndex: { domain: 0, auction_end: 1 },
    compactRows: [
      ['alpha.com', '2026-09-10T00:00:00Z'],
      ['alpha.net', '2026-09-11T00:00:00Z'],
      ['beta.com', '2026-09-12T00:00:00Z'],
      ['gamma.com', '2026-09-13T00:00:00Z'],
    ],
  };
  assert.deepEqual(snapshotDemandCandidates(index, { nowMs: NOW, limit: 1, exclude: new Set(['alpha']) }), [
    { base_name: 'beta', auction_end: '2026-09-12T00:00:00Z' },
  ]);
});

test('a transition timestamp does not expire rows still present in an active inventory', () => {
  const index = { rows: [{ domain: 'stillavailable.com', auction_end: '2026-01-01T00:00:00Z' }] };
  const nowMs = Date.parse('2026-09-28T00:00:00Z');
  assert.equal(snapshotDemandCandidates(index, { nowMs }).length, 0);
  assert.deepEqual(snapshotDemandCandidates(index, { nowMs, endIsExpiry: false }), [
    { base_name: 'stillavailable', auction_end: '2026-01-01T00:00:00Z' },
  ]);
});
