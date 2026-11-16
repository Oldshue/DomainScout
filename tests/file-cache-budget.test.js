'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { GIB, createFileCacheBudget, ownedCacheFiles, cleanupAfterResponse } = require('../server/file-cache-budget');

test('owned cache paths stay inside the data directory and include derived daily stores', () => {
  const existing = new Set([
    '/data/domains.db', '/data/universe/ct/launches.db',
    '/data/universe/2026-11-15/sites/public-feed-v2.sqlite',
  ]);
  const io = {
    readdirSync: () => ['not-a-day', '2026-11-15'],
    statSync: file => ({ isFile: () => existing.has(file) }),
  };
  assert.deepEqual(ownedCacheFiles('/data', io), [...existing]);
});

test('cache budget skips busy and below-budget service, then coalesces cleanup', async () => {
  let busy = true, bytes = 5 * GIB, calls = 0, finish;
  const io = { readdirSync: () => [], statSync: () => ({ isFile: () => true }) };
  const readFile = () => `file ${bytes}\n`;
  const advise = async files => { calls += 1; await new Promise(resolve => { finish = resolve; }); bytes = 2 * GIB; return { supported: true, advised: files.length }; };
  const budget = createFileCacheBudget({ dataDir: '/data', busy: () => busy, readFile, io, advise, log: { log() {} } });
  assert.equal((await budget.run()).reason, 'busy');
  busy = false;
  const one = budget.run('test'), two = budget.run('test');
  await new Promise(resolve => setImmediate(resolve));
  finish();
  assert.deepEqual(await one, await two);
  assert.equal(calls, 1);
  assert.equal((await budget.run()).reason, 'below-budget');
});

test('cache budget releases unrelated files while protecting the active owner set', async () => {
  const seen = [];
  const io = { readdirSync: () => [], statSync: () => ({ isFile: () => true }) };
  const budget = createFileCacheBudget({
    dataDir: '/data', readFile: () => `file ${5 * GIB}\n`, io,
    protectedFile: file => file.includes('sale_watch.db') || file.endsWith('sale-watch-discovery.json'),
    advise: async files => { seen.push(...files); return { supported: true, advised: files.length }; },
    log: { log() {} },
  });
  const result = await budget.run('active-wave');
  assert.equal(result.ran, true);
  assert.ok(seen.includes(path.join('/data', 'domains.db')));
  assert.equal(seen.some(file => file.includes('sale_watch.db') || file.endsWith('sale-watch-discovery.json')), false);
});

test('provider response completion schedules one coalesced cleanup after bytes are sent', async () => {
  const response = new EventEmitter();
  const reasons = [];
  const timers = [];
  const budget = { run: async reason => { reasons.push(reason); } };
  assert.equal(cleanupAfterResponse(budget, response, {
    delayMs: 25,
    setTimer(fn, delay) { timers.push({ fn, delay }); return { unref() {} }; },
  }), true);
  assert.deepEqual(reasons, []);
  response.emit('finish');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 25);
  await timers[0].fn();
  assert.deepEqual(reasons, ['post-provider-query']);
});
