'use strict';

// Lane retirement contract for server/db-read-pool.js: a read that exceeds its deadline
// retires the lane worker, but ONLY that statement fails. Requests queued behind it
// that never started are re-dispatched once to the replacement worker, keeping their
// remaining deadline. A second timeout during re-dispatch fails cleanly (no hang, no
// unbounded respawn). Lane names are arbitrary fixtures, not product lanes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDbReadPool } = require('../server/db-read-pool');

// A serial fake worker shaped like server/db-read-worker.js: it processes one message
// at a time, acknowledges { id, started: true } before running, and either answers
// (sql 'ok:*') or blocks forever (sql 'hang:*'), like an uncancellable statement.
function fakeWorkerFactory() {
  const created = [];
  function createWorker(lane) {
    const w = new EventEmitter();
    w.lane = lane;
    w.queue = [];
    w.busy = false;
    w.dead = false;
    w.seen = [];
    const process = () => {
      if (w.busy || w.dead || !w.queue.length) return;
      const msg = w.queue.shift();
      w.busy = true;
      w.seen.push(msg.sql);
      setImmediate(() => {
        if (w.dead) return;
        w.emit('message', { id: msg.id, started: true });
        if (String(msg.sql).startsWith('hang:')) return; // never finishes
        setTimeout(() => {
          if (w.dead) return;
          w.emit('message', { id: msg.id, ok: true, rows: [{ sql: msg.sql, worker: created.indexOf(w) }] });
          w.busy = false;
          process();
        }, 5);
      });
    };
    w.postMessage = (msg) => { w.queue.push(msg); process(); };
    w.terminate = () => { w.dead = true; return Promise.resolve(0); };
    created.push(w);
    return w;
  }
  return { createWorker, created };
}

function settle(promise) {
  return promise.then(rows => ({ ok: true, rows }), err => ({ ok: false, error: err.message }));
}

test('queued requests survive a sibling timeout and run on the replacement worker', async () => {
  const fake = fakeWorkerFactory();
  const pool = createDbReadPool({ createWorker: fake.createWorker });
  const stuck = settle(pool.query('hang:a', {}, 60, 'lane-x'));
  const queued = settle(pool.query('ok:b', {}, 2000, 'lane-x'));
  const [s, q] = await Promise.all([stuck, queued]);
  assert.deepEqual(s, { ok: false, error: 'db-read-worker-timeout' });
  assert.equal(q.ok, true, `queued read failed: ${q.error}`);
  assert.equal(q.rows[0].sql, 'ok:b');
  assert.equal(q.rows[0].worker, 1, 'queued read must be served by the replacement worker');
  assert.equal(fake.created.length, 2);
  assert.equal(fake.created[0].dead, true, 'stuck worker is terminated');
  assert.equal(pool._pending.size, 0);
});

test('the timed-out request alone fails; every other queued request completes', async () => {
  const fake = fakeWorkerFactory();
  const pool = createDbReadPool({ createWorker: fake.createWorker });
  const results = await Promise.all([
    settle(pool.query('hang:a', {}, 60, 'lane-y')),
    settle(pool.query('ok:b', {}, 2000, 'lane-y')),
    settle(pool.query('ok:c', {}, 2000, 'lane-y')),
    settle(pool.query('ok:d', {}, 2000, 'other-lane')),
  ]);
  assert.deepEqual(results.map(r => r.ok), [false, true, true, true]);
  assert.equal(results[0].error, 'db-read-worker-timeout');
  assert.ok(!results.some(r => r.error === 'db-read-worker-retired'));
  // Each re-dispatched read ran exactly once on the replacement.
  const replacement = fake.created.find(w => w.lane === 'lane-y' && !w.dead);
  assert.deepEqual(replacement.seen, ['ok:b', 'ok:c']);
  assert.equal(pool._pending.size, 0);
});

test('a second timeout during re-dispatch fails cleanly without unbounded respawn', async () => {
  const fake = fakeWorkerFactory();
  const pool = createDbReadPool({ createWorker: fake.createWorker });
  const started = Date.now();
  const results = await Promise.all([
    settle(pool.query('hang:a', {}, 60, 'lane-z')),
    settle(pool.query('hang:b', {}, 200, 'lane-z')),
    settle(pool.query('ok:c', {}, 2000, 'lane-z')),
  ]);
  assert.deepEqual(results[0], { ok: false, error: 'db-read-worker-timeout' });
  // b was re-dispatched, started on the replacement, then hit its ORIGINAL deadline.
  assert.deepEqual(results[1], { ok: false, error: 'db-read-worker-timeout' });
  // c already used its one re-dispatch; the second retirement fails it cleanly.
  assert.deepEqual(results[2], { ok: false, error: 'db-read-worker-retired' });
  assert.ok(Date.now() - started < 1500, 'remaining deadline is kept, not reset');
  assert.equal(fake.created.length, 2, 'bounded: no third worker spawned for exhausted requests');
  assert.ok(fake.created.every(w => w.dead));
  assert.equal(pool._pending.size, 0);
  // The lane recovers for new work afterwards.
  const after = await settle(pool.query('ok:e', {}, 2000, 'lane-z'));
  assert.equal(after.ok, true);
});

test('a request that times out while queued behind a running sibling fails alone', async () => {
  const fake = fakeWorkerFactory();
  const pool = createDbReadPool({ createWorker: fake.createWorker });
  const slow = settle(pool.query('hang:a', {}, 300, 'lane-q'));
  const impatient = settle(pool.query('ok:b', {}, 40, 'lane-q'));
  const r = await impatient;
  assert.deepEqual(r, { ok: false, error: 'db-read-worker-timeout' });
  assert.equal(fake.created[0].dead, false, 'queued timeout must not retire the running worker');
  assert.deepEqual(await slow, { ok: false, error: 'db-read-worker-timeout' });
});
