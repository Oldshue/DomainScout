// Off-main-thread GoDaddy inventory query worker.
//
// The GoDaddy ui-index is a ~211MB JSON file; parsing it synchronously on the main
// thread freezes the event loop ~1330ms per refresh (proven by scripts/godaddy-worker-proto.js),
// blocking every concurrent request for that tick. This worker OWNS the parsed cache
// (memoized per file mtime inside godaddy-cache.js's module state — a separate instance
// here) and serves filter/sort/page queries, so only the small result page crosses the
// thread boundary and the main thread never parses.
//
// Enabled behind DOMAINSCOUT_GODADDY_WORKER=1; the main thread falls back to the
// synchronous path if the worker is unavailable, so worst-case == current behavior.
const { parentPort } = require('worker_threads');
const { readGoDaddyInventoryIndex } = require('./godaddy-cache');
const { buildPageFromIndex } = require('./godaddy-query');
const TRACE_ENABLED = process.env.DOMAINSCOUT_GODADDY_TRACE === '1';
let traceCount = 0;
function trace(event, details = '') {
  if (!TRACE_ENABLED || traceCount >= 100) return;
  traceCount += 1;
  console.log(`[GoDaddyTrace] ${Date.now()} worker ${event}${details ? ` ${details}` : ''}`);
}

parentPort.on('message', (msg) => {
  const { id } = msg || {};
  try {
    trace('message', `id=${id} stream=${msg.stream} keys=${Object.keys(msg.query || {}).sort().join(',')}`);
    trace('before-index', `id=${id}`);
    const index = readGoDaddyInventoryIndex(msg.stream);
    trace('after-index', `id=${id} rows=${index && index.compactRows ? index.compactRows.length : -1}`);
    if (!index) {
      parentPort.postMessage({ id, ok: true, missing: true });
      return;
    }
    // Plain-data override contract: overrides/nowMs/maxAgeMs are forwarded verbatim to
    // buildPageFromIndex, unchanged — the worker adds no database or filesystem access
    // beyond the existing memoized inventory-index read above.
    trace('before-page', `id=${id} sort=${msg.sortBy}:${msg.sortDir} page=${msg.pageNum} limit=${msg.limitNum}`);
    const { total, pageRows, generatedAt } = buildPageFromIndex(index, msg.query, {
      sortBy: msg.sortBy,
      sortDir: msg.sortDir,
      pageNum: msg.pageNum,
      limitNum: msg.limitNum,
      dateWindow: msg.dateWindow,
      dateFilterIgnoredReason: msg.dateFilterIgnoredReason,
      overrides: msg.overrides,
      nowMs: msg.nowMs,
      maxAgeMs: msg.maxAgeMs,
    });
    trace('after-page', `id=${id} total=${total} rows=${pageRows.length}`);
    parentPort.postMessage({ id, ok: true, total, pageRows, generatedAt });
    trace('after-post', `id=${id}`);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
