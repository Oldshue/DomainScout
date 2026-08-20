'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyAccessibleZoneProjection,
  applyExtensionProjection,
  compareResearchNames,
  researchExtensionCount,
} = require('../server/research-result-projection');

test('complete accessible-zone corpus is exact within its declared universe', () => {
  const row = applyAccessibleZoneProjection({ base_name: 'agent', tlds_taken: 410 }, {
    total_tlds: 1071,
    last_finished_at: '2026-08-20 21:12:54',
  });
  assert.equal(row.tlds_taken, 410);
  assert.equal(row.tlds_lower_bound, null);
  assert.equal(row.tlds_verified, true);
  assert.equal(row.tlds_all_count, 1071);
  assert.equal(row.tlds_label, '410 of 1071 accessible CZDS zones');
  assert.equal(row.tlds_source, 'czds:complete-accessible-prefix-corpus');
});

test('observed zone counts survive an unverified full-universe projection', () => {
  const row = { base_name: 'agentframe', tlds_taken: 27 };
  applyExtensionProjection(row, {
    verified: false,
    extensions: null,
    extensionsLowerBound: 3,
    extensionsLabel: 'Not verified',
    receipt: null,
  }, { universeCount: 1437, defaultSource: 'iana-root-tlds', includeCoverage: false });

  assert.equal(row.tlds_taken, null);
  assert.equal(row.tlds_lower_bound, 27);
  assert.equal(row.tlds_sort_value, 27);
  assert.equal(row.tlds_verified, false);
  assert.match(row.tlds_label, /At least 27/);
  assert.equal('tlds_coverage' in row, false);
});

test('complete consistent evidence replaces a lower bound with an exact count', () => {
  const row = { base_name: 'agentgauge', tlds_taken: 4 };
  applyExtensionProjection(row, {
    verified: true,
    extensions: 9,
    extensionsLowerBound: 9,
    extensionsLabel: '9 verified extensions',
    receipt: { completedAt: '2026-08-20T12:00:00Z', totalCount: 1437, universeVersion: 'fixture-v1' },
  });

  assert.equal(row.tlds_taken, 9);
  assert.equal(row.tlds_lower_bound, null);
  assert.equal(row.tlds_verified, true);
  assert.equal(researchExtensionCount(row), 9);
});

test('conflicting exact evidence fails closed behind the stronger observed lower bound', () => {
  const row = { base_name: 'agentops', tlds_taken: 12 };
  applyExtensionProjection(row, {
    verified: true,
    extensions: 7,
    extensionsLowerBound: 7,
    extensionsLabel: '7 verified extensions',
    receipt: { completedAt: '2026-08-20T12:00:00Z', totalCount: 1437 },
  });

  assert.equal(row.tlds_taken, null);
  assert.equal(row.tlds_lower_bound, 12);
  assert.equal(row.tlds_verified, false);
});

test('extension ordering is descending and deterministic for an unrelated prefix fixture', () => {
  const rows = [
    { base_name: 'router-zone', tlds_taken: null, tlds_lower_bound: 2 },
    { base_name: 'router-api', tlds_taken: 8, tlds_verified: true },
    { base_name: 'router-admin', tlds_taken: null, tlds_lower_bound: 8 },
    { base_name: 'router-missing', tlds_taken: null, tlds_lower_bound: null },
  ].sort((a, b) => compareResearchNames(a, b, 'DESC'));

  assert.deepEqual(rows.map(row => row.base_name), [
    'router-admin',
    'router-api',
    'router-zone',
    'router-missing',
  ]);
});
