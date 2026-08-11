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
    // Plain-data override + sibling-evidence contracts are forwarded as structured-
    // cloneable data. This worker remains database-free; the separate read worker owns
    // SQLite access so neither the inventory scan nor evidence lookup blocks the web loop.
    trace('before-page', `id=${id} sort=${msg.sortBy}:${msg.sortDir} page=${msg.pageNum} limit=${msg.limitNum}`);
    const evidence = msg.takenInEvidence && Array.isArray(msg.takenInEvidence.tlds)
      ? {
          tlds: msg.takenInEvidence.tlds,
          sets: msg.takenInEvidence.tlds.map(tld => new Set(msg.takenInEvidence.baseNamesByTld?.[tld] || [])),
          baseMetadata: msg.takenInEvidence.baseMetadata || {},
        }
      : null;
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
      takenInBaseSets: evidence?.sets || null,
    });
    const outputRows = evidence ? pageRows.map(row => {
      const domain = String(row.domain || '');
      const dot = domain.indexOf('.');
      const base = (dot === -1 ? domain : domain.slice(0, dot)).toLowerCase();
      const takenCount = evidence.sets.reduce((count, set) => count + (set.has(base) ? 1 : 0), 0);
      const metadata = evidence.baseMetadata[base] || null;
      return {
        ...row,
        tlds_taken: metadata?.tldsTaken ?? row.tlds_taken ?? null,
        tlds_checked_at: metadata?.tldsCheckedAt ?? null,
        tlds_verified: Boolean(metadata),
        tlds_all_count: metadata?.tldsAllCount ?? null,
        tlds_source: metadata?.tldsSource ?? null,
        taken_in_count: takenCount,
        taken_in_checked_count: takenCount,
      };
    }) : pageRows;
    trace('after-page', `id=${id} total=${total} rows=${pageRows.length}`);
    parentPort.postMessage({ id, ok: true, total, pageRows: outputRows, generatedAt, takenInTlds: evidence?.tlds || null });
    trace('after-post', `id=${id}`);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
