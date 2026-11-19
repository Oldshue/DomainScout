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

const { lockHeldByLiveTldWorker } = require('../server/tld-worker-lock-identity');

test('a lock whose pid was reused by another live process does not block the worker', () => {
  const lock = { pid: 29, parentPid: 1, startedAt: '2026-11-07T15:21:48.823Z' };
  assert.equal(lockHeldByLiveTldWorker(lock, { selfPid: 70843, isAlive: () => true, readCommand: () => 'node server/index.js' }), false);
});

test('a lock held by a live tlds-worker blocks a second instance', () => {
  const lock = { pid: 29, parentPid: 1, startedAt: '2026-11-07T15:21:48.823Z' };
  assert.equal(lockHeldByLiveTldWorker(lock, { selfPid: 70843, isAlive: () => true, readCommand: () => 'node /app/server/tlds-worker.js' }), true);
});

test('dead pids, own pid, unreadable commands and empty locks never block', () => {
  assert.equal(lockHeldByLiveTldWorker({ pid: 29 }, { selfPid: 1, isAlive: () => false, readCommand: () => 'tlds-worker.js' }), false);
  assert.equal(lockHeldByLiveTldWorker({ pid: 29 }, { selfPid: 29, isAlive: () => true, readCommand: () => 'tlds-worker.js' }), false);
  assert.equal(lockHeldByLiveTldWorker({ pid: 29 }, { selfPid: 1, isAlive: () => true, readCommand: () => { throw new Error('gone'); } }), false);
  assert.equal(lockHeldByLiveTldWorker(null), false);
});
