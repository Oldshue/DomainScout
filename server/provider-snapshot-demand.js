'use strict';

// Pure demand-source extraction from an immutable GoDaddy provider snapshot index
// (the value returned by readGoDaddyInventoryIndex(stream) in server/godaddy-cache.js).
// No DB access, no side effects — mirrors the extraction style of compactCandidates
// in server/market-sibling-scan-worker.js, but keeps the soonest auction_end per
// base name so callers can prioritize/schedule work by urgency.

function consider(map, rawDomain, rawEnd, nowMs) {
  const domain = String(rawDomain || '').toLowerCase();
  const dot = domain.indexOf('.');
  if (dot <= 0) return;
  const baseName = domain.slice(0, dot);
  const endStr = rawEnd || null;
  const endMs = endStr ? Date.parse(endStr) : NaN;
  if (Number.isFinite(endMs) && endMs <= nowMs) return; // ended — skip
  const newMs = Number.isFinite(endMs) ? endMs : null;
  const existing = map.get(baseName);
  if (!existing) {
    map.set(baseName, { auction_end: endStr, endMs: newMs });
    return;
  }
  if (existing.endMs === null && newMs !== null) {
    map.set(baseName, { auction_end: endStr, endMs: newMs });
  } else if (existing.endMs !== null && newMs !== null && newMs < existing.endMs) {
    map.set(baseName, { auction_end: endStr, endMs: newMs });
  }
  // otherwise keep the existing (already-soonest) entry
}

function snapshotDemandCandidates(index, { nowMs = Date.now() } = {}) {
  if (!index) return [];
  const map = new Map();
  if (Array.isArray(index.compactRows) && index.compactColumnIndex) {
    const domainCol = index.compactColumnIndex.domain;
    const endCol = index.compactColumnIndex.auction_end;
    for (const tuple of index.compactRows) consider(map, tuple[domainCol], tuple[endCol], nowMs);
  } else if (Array.isArray(index.rows)) {
    for (const row of index.rows) consider(map, row.domain, row.auction_end, nowMs);
  } else {
    return [];
  }

  const result = [...map.entries()].map(([base_name, v]) => ({
    base_name, auction_end: v.auction_end, _endMs: v.endMs,
  }));
  result.sort((a, b) => {
    const aMissing = a._endMs === null;
    const bMissing = b._endMs === null;
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (!aMissing && a._endMs !== b._endMs) return a._endMs - b._endMs;
    return a.base_name < b.base_name ? -1 : a.base_name > b.base_name ? 1 : 0;
  });
  return result.map(({ base_name, auction_end }) => ({ base_name, auction_end }));
}

module.exports = { snapshotDemandCandidates };
