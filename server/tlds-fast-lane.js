'use strict';

// Fast-lane assembler for GET /api/tlds-check and GET /api/tlds-lookup-full.
//
// This module never performs its own DNS/RDAP lookups. It only assembles
// taken/free/timedOut buckets from whatever a caller-supplied resolver
// returns before a bounded wall-clock deadline. Route handlers must pass in
// the SAME resolver the background worker uses (server/tlds-worker.js's
// resolveNsLimited) — this file is deliberately resolver-agnostic so tests
// can inject a fake resolver with no network access.

const CORE_FAST_LANE_EXTENSIONS = ['.com', '.net', '.org', '.io', '.ai', '.co', '.app', '.dev', '.xyz', '.me'];
const DEFAULT_FAST_LANE_TIMEOUT_MS = 8000;

function normalizeStatus(result) {
  if (result === true || result === 'taken') return 'taken';
  if (result === false || result === 'not_taken') return 'not_taken';
  return 'unknown';
}

/**
 * Resolve the core extension set for one base name, bounded to `timeoutMs`
 * total (default 8s, matching the fast-lane contract). Whatever extensions
 * finish before the deadline are reported as taken/free; everything else
 * (still in flight, or answered 'unknown') is reported as timedOut. Never
 * throws — a resolver rejection for one extension only removes that
 * extension from `checked`, same fail-closed rule as the background worker.
 *
 * @param {object} opts
 * @param {string} opts.baseName
 * @param {string[]} [opts.extensions] - defaults to CORE_FAST_LANE_EXTENSIONS
 * @param {(domain: string, tld: string, baseName: string) => Promise<'taken'|'not_taken'|'unknown'|boolean|null>} opts.resolver
 * @param {number} [opts.timeoutMs] - defaults to DEFAULT_FAST_LANE_TIMEOUT_MS (8000)
 * @returns {Promise<{ checked: string[], taken: string[], free: string[], timedOut: string[] }>}
 */
async function assembleFastLane({ baseName, extensions, resolver, timeoutMs } = {}) {
  if (typeof resolver !== 'function') throw new Error('resolver function is required');
  const cleanBase = String(baseName || '').trim().toLowerCase();
  const list = Array.isArray(extensions) && extensions.length ? extensions : CORE_FAST_LANE_EXTENSIONS;
  const bound = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_FAST_LANE_TIMEOUT_MS;

  const taken = [];
  const free = [];
  const checked = new Set();

  let deadlineTimer = null;
  const deadline = new Promise(resolve => {
    deadlineTimer = setTimeout(() => resolve('deadline'), bound);
  });

  const work = Promise.all(list.map(async (ext) => {
    const domain = `${cleanBase}${ext}`;
    try {
      const status = normalizeStatus(await resolver(domain, ext, cleanBase));
      if (status === 'taken') { taken.push(ext); checked.add(ext); }
      else if (status === 'not_taken') { free.push(ext); checked.add(ext); }
      // 'unknown' is left uncounted — no proof either way, same as the worker.
    } catch (_) {
      // A rejected resolver call behaves like an unresolved lookup, never a
      // negative answer.
    }
  }));

  // Whatever finished is returned — the timer, not the resolver, bounds
  // total latency to `bound` milliseconds.
  await Promise.race([work, deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  const timedOut = list.filter(ext => !checked.has(ext));
  return {
    checked: list.filter(ext => checked.has(ext)).sort(),
    taken: [...new Set(taken)].sort(),
    free: [...new Set(free)].sort(),
    timedOut: [...new Set(timedOut)].sort(),
  };
}

module.exports = {
  CORE_FAST_LANE_EXTENSIONS,
  DEFAULT_FAST_LANE_TIMEOUT_MS,
  assembleFastLane,
};
