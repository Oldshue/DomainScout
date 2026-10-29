'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBaseline } = require('../scripts/build-sale-watch-baseline');

test('portable Sale Watch baseline keeps qualified history and the current scan without shipping the corpus', () => {
  const discovery = {
    generatedAt: '2026-10-29T17:04:05.038Z',
    entries: [
      { domain: 'qualified.example', observationStatus: 'retained-history' },
      { domain: 'current.example', observationStatus: 'observed-in-latest-scan' },
      { domain: 'stale-suspect.example', observationStatus: 'retained-history' },
    ],
    retiredEntries: [
      { domain: 'ledger-control.example' },
      { domain: 'unrelated-retired.example' },
    ],
  };
  const baseline = buildBaseline(discovery, {
    probableDomains: new Set(['qualified.example']),
    ledgerDomains: new Set(['ledger-control.example']),
  });
  assert.deepEqual(baseline.entries.map(entry => entry.domain), ['qualified.example', 'current.example']);
  assert.deepEqual(baseline.retiredEntries.map(entry => entry.domain), ['ledger-control.example']);
  assert.equal(baseline.baseline, true);
});
