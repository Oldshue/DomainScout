'use strict';

// One memory-heavy background job at a time in this process's container.
// 2026-11-12: after every boot the GoDaddy inventory refresh (gigabytes of
// heap) and the Sale Watch discovery scan started within seconds of each
// other; together with the server they crossed the container memory limit and
// the kernel killed whichever it picked, twice the whole container.
//
// A job takes the gate before it spawns its child and releases it when the
// child exits. Immediate callers can retry later; queued callers are admitted
// in FIFO order. Ownership is terminal-event based, never wall-clock based:
// a healthy long-running child must not silently lose the gate while alive.

const fs = require('node:fs');

function createHeavyJobGate({ now = Date.now } = {}) {
  let holder = null;
  const queue = [];
  let maintenanceHolder = null;
  const maintenanceQueue = [];
  const snapshot = entry => entry ? {
    name: entry.name,
    since: new Date(entry.since).toISOString(),
  } : null;
  const current = () => {
    const active = snapshot(holder);
    if (!active) return null;
    return {
      ...active,
      waiting: queue.map(entry => ({ name: entry.name, queuedAt: new Date(entry.queuedAt).toISOString() })),
    };
  };
  const grant = name => {
    const mine = { name: String(name), since: now() };
    holder = mine;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (holder !== mine) return;
      holder = null;
      const next = queue.shift();
      if (next) next.resolve(grant(next.name));
    };
  };
  return {
    current,
    maintenanceCurrent: () => {
      const active = snapshot(maintenanceHolder);
      return active ? { ...active, waiting: maintenanceQueue.map(entry => ({ name: entry.name, queuedAt: new Date(entry.queuedAt).toISOString() })) } : null;
    },
    /** Returns a release function, or null while another job holds the gate. */
    acquire(name) {
      if (holder || queue.length) return null;
      return grant(name);
    },
    /** Resolves with a release function when this FIFO request owns the gate. */
    wait(name) {
      if (!holder && queue.length === 0) return Promise.resolve(grant(name));
      return new Promise(resolve => queue.push({ name: String(name), queuedAt: now(), resolve }));
    },
    /** One bounded streaming/index-maintenance task, independent of a long network-heavy owner. */
    waitMaintenance(name) {
      const grantMaintenance = value => {
        const mine = { name: String(value), since: now() };
        maintenanceHolder = mine;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (maintenanceHolder !== mine) return;
          maintenanceHolder = null;
          const next = maintenanceQueue.shift();
          if (next) next.resolve(grantMaintenance(next.name));
        };
      };
      if (!maintenanceHolder && maintenanceQueue.length === 0) return Promise.resolve(grantMaintenance(name));
      return new Promise(resolve => maintenanceQueue.push({ name: String(name), queuedAt: now(), resolve }));
    },
  };
}

async function runWithHeavyJobGate(gate, name, job) {
  if (!gate || typeof gate.wait !== 'function') throw new Error('heavy job gate with wait() is required');
  if (typeof job !== 'function') throw new Error('heavy job callback is required');
  const release = await gate.wait(name);
  try {
    return await job();
  } finally {
    release();
  }
}

async function runWithMaintenanceJobGate(gate, name, job) {
  if (!gate || typeof gate.waitMaintenance !== 'function') throw new Error('resource gate with waitMaintenance() is required');
  const release = await gate.waitMaintenance(name);
  try { return await job(); } finally { release(); }
}

/** The container's memory limit in bytes (cgroup v2, then v1), or null when there is none. */
function containerMemoryLimitBytes(read = file => fs.readFileSync(file, 'utf8')) {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const n = Number(String(read(file)).trim());
      // cgroup v1 reports "no limit" as a number near 2^63.
      if (Number.isFinite(n) && n > 0 && n < 2 ** 50) return n;
    } catch (_) { /* not this cgroup version, or not a container */ }
  }
  return null;
}

/**
 * V8 old-space ceiling (MB) for a child that must fail alone instead of
 * taking the container with it: `share` of the container limit, inside
 * [minMb, maxMb]; maxMb when there is no limit. An explicit setting wins.
 * minMb is the smallest ceiling the GoDaddy refresh was measured to finish
 * under at production scale (890,681 auctions + 379,805 closeouts, 2026-11-12).
 */
function childHeapCeilingMb({ explicit, limitBytes, share = 0.5, minMb = 3072, maxMb = 8192 } = {}) {
  const set = parseInt(explicit, 10);
  if (Number.isFinite(set) && set > 0) return Math.max(1024, set);
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return maxMb;
  return Math.max(minMb, Math.min(maxMb, Math.floor((limitBytes / (1024 * 1024)) * share)));
}

/** Delay before the next automatic attempt after `failures` consecutive failures: base, doubled each time, capped. */
function failureBackoffMs(failures, { baseMs = 5 * 60_000, capMs = 60 * 60_000 } = {}) {
  const n = Math.max(0, Math.floor(Number(failures)) || 0);
  if (!n) return 0;
  return Math.min(capMs, baseMs * 2 ** Math.min(n - 1, 20));
}

const heavyJobGate = createHeavyJobGate();

module.exports = { createHeavyJobGate, runWithHeavyJobGate, runWithMaintenanceJobGate, containerMemoryLimitBytes, childHeapCeilingMb, failureBackoffMs, heavyJobGate };
