'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBackgroundWorkAdmission } = require('../server/background-work-admission');

test('admits bounded background work when no conflicting workload is active', () => {
  assert.deepEqual(evaluateBackgroundWorkAdmission({
    workload: 'artifact-compaction',
    blockers: [{ name: 'catalog-import', state: null }],
  }), {
    admitted: true,
    workload: 'artifact-compaction',
    blockedBy: null,
    state: null,
  });
});

test('defers to the first active resource-heavy workload without losing its state', () => {
  const active = { pid: 42, startedAt: '2026-08-21T18:00:00.000Z' };
  assert.deepEqual(evaluateBackgroundWorkAdmission({
    workload: 'artifact-compaction',
    blockers: [
      { name: 'catalog-import', state: active },
      { name: 'media-transcode', state: { pid: 43 } },
    ],
  }), {
    admitted: false,
    workload: 'artifact-compaction',
    blockedBy: 'catalog-import',
    state: active,
  });
});
