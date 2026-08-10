'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateSnapshotHealth,
  validateSnapshotCandidate,
} = require('../server/snapshot-health');

const NOW = Date.parse('2026-08-10T16:00:00.000Z');

test('fresh validated snapshots are serveable and retain evidence', () => {
  const health = evaluateSnapshotHealth({
    generatedAt: '2026-08-10T15:30:00.000Z',
    count: 500,
    evidence: { sha256: 'abc123', source: 'provider-feed' },
  }, { maxAgeMs: 60 * 60 * 1000, minCount: 10 }, NOW);
  assert.equal(health.status, 'current');
  assert.equal(health.serveable, true);
  assert.equal(health.ageMs, 30 * 60 * 1000);
  assert.equal(health.evidence.sha256, 'abc123');
});

test('stale snapshots fail closed and expose the last failed refresh', () => {
  const lastAttempt = { status: 'failed', completedAt: '2026-08-10T15:55:00.000Z', error: 'provider timeout' };
  const health = evaluateSnapshotHealth({
    generatedAt: '2026-08-10T12:00:00.000Z', count: 500, lastAttempt,
  }, { maxAgeMs: 60 * 60 * 1000 }, NOW);
  assert.equal(health.status, 'stale');
  assert.equal(health.serveable, false);
  assert.deepEqual(health.lastFailure, lastAttempt);
});

test('unrelated warehouse inventory snapshots reject partial replacement', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ sku: `sku-${i}`, observedAt: '2026-08-10T15:00:00Z' }));
  const result = validateSnapshotCandidate(rows, {
    minCount: 10,
    previousCount: 100,
    maxDropFraction: 0.5,
    identityField: 'sku',
    timestampField: 'observedAt',
    minTimestampRatio: 0.95,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /maximum drop/);
});

test('unrelated market-price snapshots validate identity and timestamp coverage', () => {
  const rows = [
    { symbol: 'ALPHA', quotedAt: '2026-08-10T15:59:00Z' },
    { symbol: 'BRAVO', quotedAt: '2026-08-10T15:59:10Z' },
  ];
  const result = validateSnapshotCandidate(rows, {
    minCount: 2,
    identityField: 'symbol',
    timestampField: 'quotedAt',
    minTimestampRatio: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.distinctCount, 2);
  assert.equal(result.timestampRatio, 1);
});
