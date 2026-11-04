'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesTldWorkerIdentity } = require('../server/tld-worker-lock-identity');

test('current parent or an actual worker command validates an accuracy lock', () => {
  assert.equal(matchesTldWorkerIdentity({ pid: 12, parentPid: 10, startedAt: '2026-11-04T19:00:01Z' }, { currentPid: 10, currentStartedAt: Date.parse('2026-11-04T19:00:00Z') }), true);
  assert.equal(matchesTldWorkerIdentity({ pid: 12, parentPid: 1, startedAt: '2026-10-29T00:00:00Z' }, { currentPid: 10, currentStartedAt: Date.parse('2026-11-04T19:00:00Z'), readCommand: () => 'node /app/server/tlds-worker.js' }), true);
});

test('PID reuse by an unrelated process cannot keep a stale accuracy lock alive', () => {
  assert.equal(matchesTldWorkerIdentity({ pid: 36, parentPid: 1, startedAt: '2026-10-29T00:00:00Z' }, { currentPid: 1, currentStartedAt: Date.parse('2026-11-04T19:00:00Z'), readCommand: () => 'node namecheap-worker.js' }), false);
  assert.equal(matchesTldWorkerIdentity({ pid: 36, parentPid: 1, startedAt: '2026-10-29T00:00:00Z' }, { currentPid: 1, currentStartedAt: Date.parse('2026-11-04T19:00:00Z'), readCommand: () => { throw new Error('gone'); } }), false);
});
