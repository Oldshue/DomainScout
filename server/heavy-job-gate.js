'use strict';

// One memory-heavy background job at a time in this process's container.
// 2026-11-12: after every boot the GoDaddy inventory refresh (gigabytes of
// heap) and the Sale Watch discovery scan started within seconds of each
// other; together with the server they crossed the container memory limit and
// the kernel killed whichever it picked, twice the whole container.
//
// A job takes the gate before it spawns its child and releases it when the
// child exits. A job that finds the gate held does not start; the caller
// retries later. Holding is bounded: a holder older than maxHoldMs is treated
// as gone, so a lost exit event cannot block every later job.

const fs = require('node:fs');

const DEFAULT_MAX_HOLD_MS = 45 * 60_000;

function createHeavyJobGate({ now = Date.now, maxHoldMs = DEFAULT_MAX_HOLD_MS } = {}) {
  let holder = null;
  const current = () => {
    if (holder && now() - holder.since > maxHoldMs) holder = null;
    return holder ? { name: holder.name, since: new Date(holder.since).toISOString() } : null;
  };
  return {
    current,
    /** Returns a release function, or null while another job holds the gate. */
    acquire(name) {
      if (current()) return null;
      const mine = { name: String(name), since: now() };
      holder = mine;
      return () => { if (holder === mine) holder = null; };
    },
  };
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

module.exports = { DEFAULT_MAX_HOLD_MS, createHeavyJobGate, containerMemoryLimitBytes, childHeapCeilingMb, failureBackoffMs, heavyJobGate };
