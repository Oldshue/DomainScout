'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { forcedRefreshPending } = require('../server/tlds-lookup-response');

test('forced lookup is a pending acknowledgement and never republishes a cached receipt as fresh', () => {
  const coverage = { status: 'complete', completedAt: '2026-09-10T10:00:00.000Z' };
  const result = { count: 4, taken: ['.com', '.net'], coverage, tldUniverse: { count: 2, tlds: ['.com', '.net'] } };
  const response = forcedRefreshPending(result, 1000, 1250);
  assert.equal(response.status, 'pending');
  assert.equal(response.count, null);
  assert.deepEqual(response.taken, []);
  assert.equal(response.previousReceipt, coverage);
  assert.equal(response.durationMs, 250);
  assert.match(response.message, /previous receipt is not returned as current evidence/);
});
