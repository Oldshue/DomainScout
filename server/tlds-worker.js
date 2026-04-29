/**
 * TLDs-taken background worker
 *
 * Runs continuously alongside the main server.
 * Picks unchecked domains in batches, fires DNS NS lookups across all ~160 TLDs,
 * writes tlds_taken + tlds_checked_at back to the DB.
 *
 * Runs independently of the scrape cycle — never blocks inserts or the API.
 */
const db = require('./db');
const { checkTldsTaken } = require('../enrichment');

const BATCH = 50;        // domains per round — 50 × 160 = 8,000 concurrent DNS queries
const INTERVAL_MS = 500; // pause between rounds to avoid hammering DNS

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

let running = false;
let checked = 0;
let startTime = Date.now();

async function runBatch() {
  const rows = getUnchecked.all(BATCH);
  if (rows.length === 0) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[TLDs Worker] All domains checked. Total: ${checked} in ${elapsed}m`);
    // Sleep longer when caught up — check for new domains every 5 min
    setTimeout(runBatch, 5 * 60 * 1000);
    return;
  }

  const baseNames = rows.map(r => r.base_name);
  const counts = await Promise.all(baseNames.map(b => checkTldsTaken(b)));

  db.transaction(() => {
    for (let i = 0; i < baseNames.length; i++) {
      update.run(counts[i], baseNames[i]);
    }
  })();

  checked += baseNames.length;

  if (checked % 5000 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const remaining = getUnchecked.all(1).length > 0;
    console.log(`[TLDs Worker] ${checked} checked in ${elapsed}m...`);
  }

  setTimeout(runBatch, INTERVAL_MS);
}

function startWorker() {
  if (running) return;
  running = true;
  startTime = Date.now();
  console.log('[TLDs Worker] Starting...');
  runBatch().catch(err => {
    console.error('[TLDs Worker] Error:', err.message);
    running = false;
    // Restart after error
    setTimeout(startWorker, 10000);
  });
}

module.exports = { startWorker };
