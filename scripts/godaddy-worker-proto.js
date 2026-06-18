// STANDALONE PROTOTYPE — validates whether parsing the GoDaddy ui-index in a worker
// thread keeps the MAIN event loop responsive (the whole point of the refactor) and
// whether the result transfer is cheap. Does NOT touch production code. Run with node.
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const UI_INDEX = path.join(__dirname, '../data/godaddy-auction-cache.json.ui-index.json');

if (!isMainThread) {
  // WORKER: parse the ui-index + sort by auction_end ASC + return the first 1000 rows.
  const fs = require('fs');
  const t0 = Date.now();
  const raw = JSON.parse(fs.readFileSync(workerData.file, 'utf8'));
  const parseMs = Date.now() - t0;
  const t1 = Date.now();
  const rows = (raw.domains || [])
    .filter(r => r.auction_end)
    .sort((a, b) => String(a.auction_end).localeCompare(String(b.auction_end)))
    .slice(0, 1000);
  const sortMs = Date.now() - t1;
  parentPort.postMessage({ parseMs, sortMs, total: (raw.domains || []).length, page: rows.length, first: rows[0] && rows[0].domain });
  return;
}

// MAIN: measure event-loop lag (responsiveness) WHILE the worker parses.
(async () => {
  const fs = require('fs');
  if (!fs.existsSync(UI_INDEX)) { console.log('ui-index not found:', UI_INDEX); process.exit(0); }
  console.log('ui-index size:', (fs.statSync(UI_INDEX).size / 1e6).toFixed(0) + 'MB');

  // Event-loop lag sampler: schedule a 20ms timer repeatedly; lag = actual - expected.
  let maxLag = 0, samples = 0, last = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - 20;            // how much later than the 20ms target it fired
    if (lag > maxLag) maxLag = lag;
    samples++;
    last = now;
  }, 20);

  // For comparison: also time a SYNCHRONOUS parse on the main (the current behavior) to
  // measure the event-loop freeze it causes.
  const syncStart = Date.now();
  await new Promise(r => setTimeout(r, 200)); // let the sampler establish a baseline
  const baselineMaxLag = maxLag; maxLag = 0;

  // 1) WORKER parse (the proposed approach) — main should stay responsive.
  const wallStart = Date.now();
  const result = await new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { file: UI_INDEX } });
    w.once('message', m => { resolve(m); w.terminate(); });
    w.once('error', reject);
  });
  const workerWallMs = Date.now() - wallStart;
  const lagDuringWorker = maxLag; maxLag = 0;

  await new Promise(r => setTimeout(r, 100));

  // 2) SYNCHRONOUS parse on main (current behavior) — measure the freeze.
  const sStart = Date.now();
  const rawSync = JSON.parse(fs.readFileSync(UI_INDEX, 'utf8'));
  void rawSync.domains.length;
  const syncParseMs = Date.now() - sStart;
  // the lag sampler couldn't fire during the sync parse (event loop blocked), so the
  // next sample's lag ≈ the freeze duration:
  await new Promise(r => setTimeout(r, 50));
  const lagAfterSyncParse = maxLag;

  clearInterval(lagTimer);
  console.log('\n=== RESULTS ===');
  console.log('baseline max event-loop lag (idle):', baselineMaxLag + 'ms');
  console.log('WORKER approach: wall=' + workerWallMs + 'ms, worker parseMs=' + result.parseMs + ', sortMs=' + result.sortMs + ', page=' + result.page + ', total=' + result.total);
  console.log('  -> MAIN event-loop max lag DURING worker parse:', lagDuringWorker + 'ms  (LOW = main stayed responsive)');
  console.log('SYNC approach (current): parseMs=' + syncParseMs + 'ms');
  console.log('  -> MAIN event-loop freeze from sync parse:', lagAfterSyncParse + 'ms  (HIGH = main frozen)');
  process.exit(0);
})();
