'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeLimitApplied, computeHasMore } = require('../server/domains-query-contract');

// Evidence: a customer agent sent `limit=10000`; the handler clamped it
// silently (returned 5,180 rows) while `total` said 7,577 and `totalCapped`
// was false, so the agent's counts were wrong. These tests cover the pure
// helpers that make the clamp and the has-more-pages signal honest, with no
// database and no HTTP involved.

test('computeLimitApplied: clamped request reports reason max-page-size', () => {
  const result = computeLimitApplied('10000', 100);
  assert.deepEqual(result, { requested: 10000, enforced: 100, reason: 'max-page-size' });
});

test('computeLimitApplied: in-range request reports reason as-requested', () => {
  const result = computeLimitApplied('50', 50);
  assert.deepEqual(result, { requested: 50, enforced: 50, reason: 'as-requested' });
});

test('computeLimitApplied: an already-at-cap request also reports as-requested (not clamped further)', () => {
  const result = computeLimitApplied('10000', 10000);
  assert.deepEqual(result, { requested: 10000, enforced: 10000, reason: 'as-requested' });
});

test('computeLimitApplied: non-numeric raw limit yields requested null', () => {
  const result = computeLimitApplied('not-a-number', 100);
  assert.deepEqual(result, { requested: null, enforced: 100, reason: 'as-requested' });
});

test('computeLimitApplied: missing raw limit (undefined) yields requested null', () => {
  const result = computeLimitApplied(undefined, 100);
  assert.deepEqual(result, { requested: null, enforced: 100, reason: 'as-requested' });
});

test('computeLimitApplied: empty-string raw limit yields requested null', () => {
  const result = computeLimitApplied('', 100);
  assert.deepEqual(result, { requested: null, enforced: 100, reason: 'as-requested' });
});

test('computeHasMore: true when more rows remain past the current page boundary', () => {
  const result = computeHasMore({ page: 1, limit: 100, total: 250, returned: 100 });
  assert.equal(result, true);
});

test('computeHasMore: false exactly at the last page boundary (page * limit === total)', () => {
  const result = computeHasMore({ page: 3, limit: 100, total: 300, returned: 100 });
  assert.equal(result, false);
});

test('computeHasMore: false on a final partial page past the boundary', () => {
  const result = computeHasMore({ page: 3, limit: 100, total: 250, returned: 50 });
  assert.equal(result, false);
});

test('computeHasMore: true just before the boundary (one row short of the last full page)', () => {
  const result = computeHasMore({ page: 2, limit: 100, total: 201, returned: 100 });
  assert.equal(result, true);
});

test('computeHasMore: total null falls back to returned === limit (true when page is full)', () => {
  const result = computeHasMore({ page: 1, limit: 100, total: null, returned: 100 });
  assert.equal(result, true);
});

test('computeHasMore: total null falls back to returned === limit (false when page is short)', () => {
  const result = computeHasMore({ page: 1, limit: 100, total: null, returned: 40 });
  assert.equal(result, false);
});

test('computeHasMore: total non-finite (NaN) also falls back to returned === limit', () => {
  const result = computeHasMore({ page: 1, limit: 100, total: NaN, returned: 100 });
  assert.equal(result, true);
});
