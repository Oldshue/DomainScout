'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesTldWorkerIdentity } = require('../server/tld-worker-lock-identity');

test('current parent or an actual worker command validates an accuracy lock', () => {
  assert.equal(matchesTldWorkerIdentity({ pid: 12, parentPid: 10 }, { currentPid: 10 }), true);
  assert.equal(matchesTldWorkerIdentity({ pid: 12, parentPid: 1 }, { currentPid: 10, readCommand: () => 'node /app/server/tlds-worker.js' }), true);
});

test('PID reuse by an unrelated process cannot keep a stale accuracy lock alive', () => {
  assert.equal(matchesTldWorkerIdentity({ pid: 36, parentPid: 1 }, { currentPid: 10, readCommand: () => 'node namecheap-worker.js' }), false);
  assert.equal(matchesTldWorkerIdentity({ pid: 36, parentPid: 1 }, { currentPid: 10, readCommand: () => { throw new Error('gone'); } }), false);
});
