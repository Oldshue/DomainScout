'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hydrateProviderSnapshotPage } = require('../server/provider-page-hydration');
const { isPositiveSelectedTldRequest } = require('../server/provider-sibling-policy');

test('selected-TLD snapshot routing is provider-neutral and evidence-hint agnostic', () => {
  const targets = ['ai'];
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken', takenInEvidence: 'partial' }, targets), true);
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken', takenInEvidence: 'explicit' }, targets), true);
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken', takenInEvidence: 'complete' }, targets), true);
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken' }, ['shop']), true,
    'an unrelated Sedo .shop projection uses the same contract');
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'not_taken' }, targets), false);
  assert.equal(isPositiveSelectedTldRequest({ takenInMode: 'taken' }, []), false);
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
