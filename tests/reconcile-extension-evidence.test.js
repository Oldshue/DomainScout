'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDotdbCells, reconcileCell } = require('../scripts/reconcile-extension-evidence');

test('dotDB rows preserve concrete multi-label suffixes without their More control', () => {
  assert.deepEqual(parseDotdbCells(['name', '3', '2', '.com, .co.uk, .com.au\nMore']), ['.co.uk', '.com', '.com.au']);
});

test('a later registry negative overrides an older indexed positive', () => {
  const result = reconcileCell([{ status: 'registered', source: 'public-index', checkedAt: '2026-10-21T00:00:00Z' }], { domain: 'sample.co.uk', status: 'available', source: 'registry-whois:whois.nic.uk', server: 'whois.nic.uk', checkedAt: '2026-10-22T00:00:00Z', bytes: 100, sha256: 'abc' });
  assert.equal(result.registered, false); assert.equal(result.decision, 'fresh-registry-negative');
});

test('unavailable registry WHOIS does not erase a concrete positive observation', () => {
  const result = reconcileCell([{ status: 'registered', source: 'current-corpus', checkedAt: '2026-10-21T00:00:00Z' }], { domain: 'sample.dev', status: 'unknown', source: 'registry-whois-unavailable', checkedAt: '2026-10-22T00:00:00Z', error: 'registry WHOIS unavailable or retired' });
  assert.equal(result.registered, true); assert.equal(result.decision, 'materialized-positive; registry-unresolved');
});
