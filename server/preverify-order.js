'use strict';

// Proactive pre-verify ordering for whole-root receipts.
//
// Every ingested inventory stream (auctions, expiring, closeouts, ...) is walked
// as soon as it is imported and receipts are filled ahead of display. Streams
// are interleaved with a FAIR SHARE per stream so a very large undated stream
// (GoDaddy closeouts, ~170k .com rows) never starves timed auctions, and timed
// auctions never starve closeouts. Within a stream the order is: soonest
// end/expiry first (undated rows after dated rows), then display priority
// (lower number = shown earlier), then base name for determinism.
//
// Pure and provider-neutral: no DB access, no stream-specific branches. The
// existing on-view promotion (negative queue ords) still jumps ahead of
// everything produced here.

function endMs(row) {
  const value = row && (row.auction_end || row.expiry || row.end_at || row.ends_at);
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function compareWithinStream(a, b) {
  const ae = a._endMs; const be = b._endMs;
  if (ae !== be) {
    if (ae === null) return 1;
    if (be === null) return -1;
    return ae - be;
  }
  const ap = Number.isFinite(a._priority) ? a._priority : Number.MAX_SAFE_INTEGER;
  const bp = Number.isFinite(b._priority) ? b._priority : Number.MAX_SAFE_INTEGER;
  if (ap !== bp) return ap - bp;
  return a.base_name < b.base_name ? -1 : a.base_name > b.base_name ? 1 : 0;
}

function normalizeShares(streamNames, shares) {
  const out = new Map();
  for (const name of streamNames) {
    const raw = shares && Number(shares[name]);
    out.set(name, Number.isFinite(raw) && raw > 0 ? raw : 1);
  }
  return out;
}

/**
 * Build the pre-verify order.
 *
 * @param {Object<string, Array<{base_name:string, auction_end?:string, expiry?:string, priority?:number}>>} streams
 *   candidate rows per stream (already filtered to rows lacking a current receipt).
 * @param {Object} [options]
 * @param {number} [options.max] maximum rows to emit (default Infinity)
 * @param {Object<string, number>} [options.shares] relative weight per stream (default 1 each)
 * @param {Set<string>} [options.exclude] base names to skip (already queued / receipted)
 * @returns {Array<{base_name:string, stream:string, auction_end:string|null}>}
 */
function buildPreverifyOrder(streams, options = {}) {
  const max = Number.isFinite(options.max) ? Math.max(0, options.max) : Infinity;
  const exclude = options.exclude instanceof Set ? options.exclude : new Set();
  const names = Object.keys(streams || {}).filter(name => Array.isArray(streams[name]) && streams[name].length);
  const shares = normalizeShares(names, options.shares);
  const queues = new Map();
  for (const name of names) {
    const rows = [];
    for (const raw of streams[name]) {
      const base = String(raw && raw.base_name || '').toLowerCase();
      if (!base || exclude.has(base)) continue;
      rows.push({
        base_name: base,
        stream: name,
        auction_end: raw.auction_end || raw.expiry || null,
        _endMs: endMs(raw),
        _priority: raw.priority == null ? NaN : Number(raw.priority),
      });
    }
    rows.sort(compareWithinStream);
    queues.set(name, { rows, index: 0, credit: 0 });
  }

  // Weighted round-robin: each pass grants every stream `share` credits; a
  // stream emits while it has credit and rows. Duplicate base names across
  // streams are emitted once (first occurrence wins, keeping its stream tag).
  const out = [];
  const seen = new Set();
  let active = [...queues.keys()].filter(name => queues.get(name).rows.length);
  while (active.length && out.length < max) {
    for (const name of active) queues.get(name).credit += shares.get(name);
    for (const name of active) {
      const q = queues.get(name);
      while (q.credit >= 1 && q.index < q.rows.length && out.length < max) {
        const row = q.rows[q.index++];
        q.credit -= 1;
        if (seen.has(row.base_name)) continue;
        seen.add(row.base_name);
        out.push({ base_name: row.base_name, stream: row.stream, auction_end: row.auction_end });
      }
      if (q.index >= q.rows.length) q.credit = 0;
    }
    active = active.filter(name => queues.get(name).index < queues.get(name).rows.length);
  }
  return out;
}

module.exports = { buildPreverifyOrder };
