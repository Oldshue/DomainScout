'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hydrateProviderSnapshotPage } = require('../server/provider-page-hydration');
const { isPositiveSelectedTldRequest, selectedTldProjectionPolicy } = require('../server/provider-sibling-policy');

test('selected-TLD snapshot routing is provider-neutral and evidence-hint agnostic', () => {
  const targets = ['ai'];
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken', takenInEvidence: 'partial' }, targets), true);
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken', takenInEvidence: 'explicit' }, targets), true);
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken', takenInEvidence: 'complete' }, targets), true);
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken' }, ['shop']), true,
    'an unrelated Sedo .shop projection uses the same contract');
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'not_taken' }, targets), false);
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken' }, []), false);
  assert.deepEqual(selectedTldProjectionPolicy({ takenInMode: 'taken' }, ['shop']), {
    admissible: true,
    positive: true,
    requiresCompleteUniverse: false,
    evidenceMode: 'verified-positive-lower-bound',
  });
  assert.equal(
    selectedTldProjectionPolicy({ takenInMode: 'not_taken' }, ['shop']).requiresCompleteUniverse,
    true,
    'negative evidence for an unrelated target must still fail closed without complete coverage'
  );
});

test('unrelated provider receives shared extension evidence without a live-auction overlay', () => {
  const sedoRows = [{ domain: 'starlight.shop', stream: 'sedo-auction' }];
  let overlayCalls = 0;
  const result = hydrateProviderSnapshotPage(sedoRows, {
    enrichExtensions: rows => rows.map(row => ({
      ...row,
      tlds_taken: 7,
      tlds_verified: true,
      tlds_coverage: { status: 'complete', checkedCount: 1437, totalCount: 1437 },
    })),
    liveOverlay: false,
    overlayLiveFields: rows => {
      overlayCalls += 1;
      return rows.map(row => ({ ...row, auction_price: 999 }));
    },
  });

  assert.equal(result[0].stream, 'sedo-auction');
  assert.equal(result[0].tlds_taken, 7);
  assert.equal(result[0].tlds_verified, true);
  assert.equal(result[0].auction_price, undefined);
  assert.equal(overlayCalls, 0);
});

test('live overlay remains a descriptor capability after shared extension hydration', () => {
  const result = hydrateProviderSnapshotPage([{ domain: 'inventory.dev' }], {
    enrichExtensions: rows => rows.map(row => ({ ...row, tlds_taken: 3 })),
    liveOverlay: true,
    overlayLiveFields: rows => rows.map(row => ({ ...row, bid_count: 4 })),
  });

  assert.equal(result[0].tlds_taken, 3);
  assert.equal(result[0].bid_count, 4);
});

test('an unrelated hydrated provider page reapplies changed materialized sort values', () => {
  const rows = [
    { domain: 'first.shop', auction_end: '2026-08-29T12:00:00Z', tlds_taken: 20 },
    { domain: 'second.shop', auction_end: '2026-08-28T12:00:00Z', tlds_taken: 15 },
    { domain: 'unknown.shop', auction_end: '2026-08-27T12:00:00Z', tlds_taken: 10 },
  ];
  const counts = { 'first.shop': 3, 'second.shop': 9, 'unknown.shop': null };
  const hydrated = hydrateProviderSnapshotPage(rows, {
    enrichExtensions: page => page.map(row => ({ ...row, tlds_taken: counts[row.domain] })),
    reapplySortBy: 'tlds_taken',
    sortDir: 'DESC',
  });

  assert.deepEqual(
    hydrated.map(row => [row.domain, row.tlds_taken]),
    [['second.shop', 9], ['first.shop', 3], ['unknown.shop', null]],
    'the rendered order follows the concrete hydrated cardinality and keeps unknowns last',
  );
});
