/**
 * TLDs-taken background worker
 *
 * Runs continuously alongside the main server.
 * Picks unchecked base names in batches, fires DNS NS lookups across all ~160 TLDs,
 * writes tlds_taken + tlds_checked_at back to the DB.
 *
 * DNS concurrency is capped at 500 simultaneous queries globally to avoid
 * hammering public resolvers and getting throttled/inaccurate results.
 *
 * Throughput: ~200 domains per ~2-3s round = ~4-5 hours for 843K domains.
 * Subsequent runs are near-instant (only new domains need checking).
 */
const dns  = require('dns').promises;
const db   = require('./db');
const { CHECK_TLDS } = require('./tlds-list');

const BATCH       = 200;  // base names per round
const DNS_CONCURRENCY = 500; // max simultaneous DNS queries across all domains

// ── Simple semaphore ──────────────────────────────────────────────────────────
function makeSemaphore(max) {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      return new Promise(res => {
        if (active < max) { active++; res(); }
        else queue.push(res);
      });
    },
    release() {
      active--;
      if (queue.length > 0) { active++; queue.shift()(); }
    },
  };
}

const sem = makeSemaphore(DNS_CONCURRENCY);

async function resolveNsLimited(domain) {
  await sem.acquire();
  try {
    await dns.resolveNs(domain);
    return true;
  } catch (_) {
    return false;
  } finally {
    sem.release();
  }
}

async function checkTldsTakenLimited(baseName) {
  const results = await Promise.all(
    CHECK_TLDS.map(tld => resolveNsLimited(baseName + tld))
  );
  return results.filter(Boolean).length;
}

// ── DB statements ─────────────────────────────────────────────────────────────
const update = db.prepare(`
  UPDATE domains
  SET tlds_taken = ?, tlds_checked_at = datetime('now')
  WHERE SUBSTR(domain, 1, INSTR(domain, '.') - 1) = ?
    AND tlds_checked_at IS NULL
`);

const getUnchecked = db.prepare(`
  SELECT DISTINCT SUBSTR(domain, 1, INSTR(domain, '.') - 1) AS base_name
  FROM domains
  WHERE tlds_checked_at IS NULL
  LIMIT ?
`);

// ── Worker loop ───────────────────────────────────────────────────────────────
let checked   = 0;
let startTime = Date.now();

async function runBatch() {
  const rows = getUnchecked.all(BATCH);

  if (rows.length === 0) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[TLDs Worker] Caught up. ${checked} checked in ${elapsed}m. Sleeping 5min...`);
    setTimeout(runBatch, 5 * 60 * 1000);
    return;
  }

  const baseNames = rows.map(r => r.base_name);
  const counts    = await Promise.all(baseNames.map(b => checkTldsTakenLimited(b)));

  db.transaction(() => {
    for (let i = 0; i < baseNames.length; i++) {
      update.run(counts[i], baseNames[i]);
    }
  })();

  checked += baseNames.length;

  if (checked % 10000 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[TLDs Worker] ${checked} checked in ${elapsed}m`);
  }

  setImmediate(runBatch); // no artificial pause — run as fast as DNS allows
}

function startWorker() {
  startTime = Date.now();
  console.log(`[TLDs Worker] Starting (batch=${BATCH}, dns_concurrency=${DNS_CONCURRENCY})...`);
  runBatch().catch(err => {
    console.error('[TLDs Worker] Fatal:', err.message);
    setTimeout(startWorker, 15000);
  });
}

module.exports = { startWorker };
