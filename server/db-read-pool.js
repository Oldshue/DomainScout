'use strict';

// Lane-scoped pool of off-main read-only SQLite workers (see server/db-read-worker.js).
//
// better-sqlite3 cannot cancel a synchronous statement, so a read that exceeds its
// deadline forces the lane worker to be retired. Retirement must punish ONLY the
// statement the worker was actually executing: every request merely queued behind it
// never began, so it is re-dispatched (once, bounded, keeping its remaining deadline)
// to the replacement worker instead of failing with 'db-read-worker-retired'.
//
// The worker acknowledges each request with { id, started: true } immediately before
// running it, so the pool knows exactly which request each worker is executing.

function createDbReadPool(options = {}) {
  const {
    createWorker,
    laneFor = (_sql, hint) => hint || 'catalog',
    busyLanes = [],
    busyLimit = 8,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;
  if (typeof createWorker !== 'function') throw new Error('createDbReadPool requires createWorker(lane)');

  const workers = new Map(); // lane -> slot { worker, lane, current, retired }
  const pending = new Map(); // id -> request
  let seq = 0;

  function finish(p) {
    pending.delete(p.id);
    clearTimer(p.timer);
  }

  function arm(p) {
    clearTimer(p.timer);
    const remaining = Math.max(0, p.deadline - now());
    p.timer = setTimer(() => onTimeout(p), remaining);
  }

  function spawn(lane) {
    const existing = workers.get(lane);
    if (existing) return existing;
    const worker = createWorker(lane);
    const slot = { worker, lane, current: null, retired: false };
    worker.on('message', (m) => onMessage(slot, m));
    worker.on('error', (err) => retire(slot, err instanceof Error ? err : new Error(String(err))));
    worker.on('exit', () => retire(slot, new Error('db-read-worker-exit')));
    workers.set(lane, slot);
    return slot;
  }

  function dispatch(p, slot) {
    p.slot = slot;
    p.started = false;
    slot.worker.postMessage({ id: p.id, sql: p.sql, params: p.params, operation: p.operation });
  }

  function onMessage(slot, m) {
    if (!m || m.id === undefined) return;
    const p = pending.get(m.id);
    if (m.started === true) {
      slot.current = m.id;
      if (p && p.slot === slot) p.started = true;
      return;
    }
    if (slot.current === m.id) slot.current = null;
    if (!p || p.slot !== slot) return;
    finish(p);
    if (m.ok) p.resolve(m.rows);
    else p.reject(new Error(m.error || 'db-read-worker-error'));
  }

  function onTimeout(p) {
    if (pending.get(p.id) !== p) return;
    finish(p);
    p.reject(new Error('db-read-worker-timeout'));
    const slot = p.slot;
    // Retire only when this request is (or may be) the statement the worker is stuck
    // on. A request that timed out while still queued behind a running sibling fails
    // alone; the sibling's own deadline governs retirement. A worker that has never
    // acknowledged anything (e.g. hung opening the database) is also retired.
    if (slot && !slot.retired && (p.started || slot.current === p.id || slot.current === null)) {
      retire(slot, new Error('db-read-worker-retired'));
    }
  }

  function retire(slot, reason) {
    if (slot.retired) return;
    slot.retired = true;
    if (workers.get(slot.lane) === slot) workers.delete(slot.lane);
    try { slot.worker.removeAllListeners(); } catch (_) { /* ignore */ }
    try { slot.worker.on('error', () => {}); } catch (_) { /* ignore */ }
    Promise.resolve().then(() => slot.worker.terminate()).catch(() => null);
    let replacement = null;
    for (const q of [...pending.values()]) {
      if (q.slot !== slot) continue;
      const remaining = q.deadline - now();
      const executing = q.started || slot.current === q.id;
      if (executing || q.redispatched || remaining <= 0) {
        finish(q);
        q.reject(executing ? reason : new Error('db-read-worker-retired'));
        continue;
      }
      // Never started: hand it to the replacement worker once, same deadline.
      try {
        if (!replacement) replacement = spawn(slot.lane);
        q.redispatched = true;
        dispatch(q, replacement);
        arm(q);
      } catch (err) {
        finish(q);
        q.reject(err);
      }
    }
  }

  function query(sql, params, timeoutMs = 20000, laneHint = null, operation = null) {
    return new Promise((resolve, reject) => {
      const lane = laneFor(sql, laneHint);
      if (busyLanes.includes(lane)) {
        let n = 0;
        for (const p of pending.values()) if (p.lane === lane) n += 1;
        if (n >= busyLimit) return reject(new Error('Analysis is busy; retry shortly'));
      }
      let slot;
      try { slot = spawn(lane); } catch (err) { return reject(err); }
      const p = {
        id: ++seq, lane, sql, params, operation, resolve, reject,
        deadline: now() + timeoutMs, started: false, redispatched: false, slot: null, timer: null,
      };
      pending.set(p.id, p);
      arm(p);
      try { dispatch(p, slot); } catch (err) { finish(p); reject(err); }
    });
  }

  return { query, _pending: pending, _workers: workers };
}

module.exports = { createDbReadPool };
