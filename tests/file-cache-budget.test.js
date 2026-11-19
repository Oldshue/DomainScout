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

test('the scheduled budget is enforced within seconds, with releases kept apart', async () => {
  const { startFileCacheBudget } = require('../server/file-cache-budget');
  let clock = 0, bytes = 1 * GIB;
  const timers = [], releases = [];
  const io = { readdirSync: () => [], statSync: () => ({ isFile: () => true }) };
  const budget = startFileCacheBudget({
    dataDir: '/data', io, readFile: () => `file ${bytes}\n`, log: { log() {} },
    advise: async files => { releases.push(clock); bytes = 1 * GIB; return { supported: true, advised: files.length }; },
    now: () => clock,
    setTimer(fn, delay) { timers.push({ fn, delay }); return { unref() {} }; },
  });
  // Advance the fake clock to each pending timer and run it.
  const tick = async () => { const next = timers.shift(); clock += next.delay; await next.fn(); return next.delay; };
  assert.equal(timers[0].delay, 120_000);
  await tick();                                   // 2:00 below budget: nothing released
  assert.deepEqual(releases, []);
  assert.equal(timers[0].delay, 30_000, 'the next look is 30 seconds away, not five minutes');
  bytes = 5 * GIB;
  await tick();                                   // 2:30 over budget: released at once
  assert.deepEqual(releases, [150_000]);
  bytes = 6 * GIB;                                // a working set that refills immediately
  let waited = 0;
  while (releases.length < 2) waited += await tick();
  assert.equal(releases[1] - releases[0], 120_000, 'releases stay two minutes apart');
  assert.equal(waited, 120_000);
  // A release asked for by a finished provider query counts toward the gap.
  bytes = 6 * GIB;
  clock += 120_000;
  assert.equal((await budget.run('post-provider-query')).ran, true);
  const before = releases.length;
  bytes = 6 * GIB;
  await tick();
  assert.equal(releases.length, before, 'no scheduled release right after another one');
  budget.stop();
});
