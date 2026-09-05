'use strict';

// Stream-contract honesty helpers shared by the /api/domains named-stream branch
// and the /api/streams inventory endpoint.
//
// knownStreams(db) is the union builder: it always includes the app's statically
// registered streams (ACTIVE_AUCTION_STREAMS + the large-provider STREAM_DESCRIPTORS
// keys) so a stream that is momentarily empty or mid-provisioning in the `domains`
// table is still recognized, PLUS every stream value actually present in the table
// (so ad hoc / legacy streams like pending-delete or discovered are never rejected).
// The underlying grouped COUNT query is memoized for 60s so neither the validation
// guard nor the /api/streams endpoint pays a fresh GROUP BY on every request.

const { ACTIVE_AUCTION_STREAMS } = require('./auction-cleanup');
const { STREAM_DESCRIPTORS } = require('./provider-snapshot-registry');

const KNOWN_STREAMS_TTL_MS = 60_000;

// { ts, counts: Map<string, number>, union: Set<string> } | null
let _cache = null;

function staticStreamNames() {
  const names = new Set(ACTIVE_AUCTION_STREAMS);
  for (const descriptor of STREAM_DESCRIPTORS) {
    if (descriptor && descriptor.stream) names.add(descriptor.stream);
  }
  return names;
}

function refresh(db) {
  const counts = new Map();
  try {
    const rows = db.prepare('SELECT stream, COUNT(*) AS total FROM domains GROUP BY stream').all();
    for (const row of rows) {
      if (row && row.stream) counts.set(row.stream, Number(row.total) || 0);
    }
  } catch (_) {
    // Best effort: a DB read failure still leaves the static registry streams valid,
    // so validation and the endpoint degrade to the known-safe stream names instead
    // of throwing.
  }
  const union = staticStreamNames();
  for (const stream of counts.keys()) union.add(stream);
  _cache = { ts: Date.now(), counts, union };
  return _cache;
}

function getCache(db) {
  if (_cache && (Date.now() - _cache.ts) < KNOWN_STREAMS_TTL_MS) return _cache;
  return refresh(db);
}

// The union of every stream name DomainScout recognizes: the statically registered
// auction/provider streams plus whatever distinct `stream` values currently exist
// in the domains table. Memoized 60s.
function knownStreams(db) {
  return getCache(db).union;
}

// Map<stream, total> from the same memoized 60s grouped COUNT query, for callers
// (e.g. GET /api/streams) that also need per-stream totals alongside the union.
function streamCounts(db) {
  return getCache(db).counts;
}

// True only for a finite, strictly-positive cached total. A missing (undefined)
// or zero entry must never be trusted as "this stream has no rows" — a zero from
// a derived/background cache can simply mean the cache never populated that
// stream, and trusting it would silently suppress rows that actually exist.
function shouldUseCachedTotal(entry) {
  const n = Number(entry);
  return Number.isFinite(n) && n > 0;
}

module.exports = {
  knownStreams,
  streamCounts,
  shouldUseCachedTotal,
};
