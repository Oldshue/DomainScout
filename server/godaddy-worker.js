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

parentPort.on('message', (msg) => {
  const { id } = msg || {};
  try {
    const index = readGoDaddyInventoryIndex(msg.stream);
    if (!index) {
      parentPort.postMessage({ id, ok: true, missing: true });
      return;
    }
    const { total, pageRows, generatedAt } = buildPageFromIndex(index, msg.query, {
      sortBy: msg.sortBy,
      sortDir: msg.sortDir,
      pageNum: msg.pageNum,
      limitNum: msg.limitNum,
      dateWindow: msg.dateWindow,
      dateFilterIgnoredReason: msg.dateFilterIgnoredReason,
    });
    parentPort.postMessage({ id, ok: true, total, pageRows, generatedAt });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
