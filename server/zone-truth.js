'use strict';

// One resolver for zone membership: prefers the daily universe summary when
// it is fresh enough, otherwise falls back to the legacy full zone index.
// Must not require tld-universe.js or index.js (no require cycles).

const path = require('path');
const fs = require('fs');

const CACHE_MS = 30000;
let cache = null; // { result, computedAt, summaryMtimeMs }

function dataDir() {
  return process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
}

function summaryDbPath() {
  return path.join(dataDir(), 'universe_summary.db');
}

function summaryMtimeMs() {
  try { return fs.statSync(summaryDbPath()).mtimeMs; } catch (_) { return null; }
}

let _openUniverseSummary; // undefined = not tried, null = unavailable
function loadOpenUniverseSummary() {
  if (_openUniverseSummary === undefined) {
    try { _openUniverseSummary = require('./universe-summary').openUniverseSummary; }
    catch (_) { _openUniverseSummary = null; }
  }
  return _openUniverseSummary;
}

let _zoneIndexer;
function loadZoneIndexer() {
  if (_zoneIndexer === undefined) {
    try { _zoneIndexer = require('./zone-indexer'); }
    catch (_) { _zoneIndexer = null; }
  }
  return _zoneIndexer;
}

function emptyResult() {
  return {
    source: 'none', asOf: null, tlds: 0, names: 0, minZones: 2, complete: false,
    exactForAbsentLabels: false, anchorTlds: [],
    query: () => [], count: () => 0,
    nameZones: () => ({ exact: false, tlds: [] }),
    zoneMembership: () => ({ exact: false, tlds: [], unresolved: [], source: 'none' }),
    lookupMany: () => new Map(),
    zoneTldSet: () => new Set(),
    completeTldSet: () => new Set(),
  };
}

function buildSummaryResult(handle) {
  const status = handle.status();
  // With single-zone membership in the tape, a label absent from the summary is
  // exactly "in no zone except possibly an anchor". Every non-anchor zone is then
  // complete truth for EVERY label; anchors (default .com) still need one lookup
  // for absent labels and therefore stay on the DNS side of the universe split.
  const exactAbsent = typeof handle.exactForAbsentLabels === 'function' && handle.exactForAbsentLabels() === true;
  const anchorTlds = (status.singleZone && Array.isArray(status.singleZone.anchors) ? status.singleZone.anchors : [])
    .map(zone => (String(zone).startsWith('.') ? String(zone) : `.${zone}`));
  const anchorSet = new Set(anchorTlds);
  return {
    source: 'universe-summary', asOf: status.day, tlds: status.zones,
    names: status.namesMulti, namesSingle: Number(status.namesSingle || 0),
    minZones: status.minZones, complete: false,
    exactForAbsentLabels: exactAbsent, anchorTlds, bytes: status.bytes || null,
    query: (term, mode, opts) => handle.query(term, mode, opts),
    count: (term, mode, opts) => handle.count(term, mode, opts),
    nameZones: (baseName) => handle.nameZones(baseName),
    zoneMembership: (baseName) => (typeof handle.zoneMembership === 'function'
      ? handle.zoneMembership(baseName)
      : { ...handle.nameZones(baseName), unresolved: [], source: 'legacy-summary' }),
    lookupMany: (baseNames) => handle.lookupMany(baseNames),
    zoneTldSet: () => handle.zoneTldSet(),
    completeTldSet: () => (exactAbsent
      ? new Set([...handle.zoneTldSet()].filter(tld => !anchorSet.has(tld)))
      : new Set()),
  };
}

function buildLegacyResult(zi) {
  const { queryZoneIndex, countZoneIndexMatches, getNameTlds, getIndexedTldSet, getZoneIndexAsOf } = zi;
  const tldSet = getIndexedTldSet();
  return {
    source: 'zone-index',
    asOf: typeof getZoneIndexAsOf === 'function' ? getZoneIndexAsOf() : null,
    tlds: tldSet.size, names: null, minZones: 1, complete: true,
    exactForAbsentLabels: true, anchorTlds: [],
    query: (term, mode, opts = {}) => queryZoneIndex(term, mode, opts),
    count: (term, mode, opts) => countZoneIndexMatches(term, mode, opts),
    nameZones: (baseName) => ({ exact: true, tlds: getNameTlds(baseName) }),
    zoneMembership: (baseName) => ({ exact: true, tlds: getNameTlds(baseName), unresolved: [], source: 'zone-index' }),
    lookupMany: (baseNames) => {
      const map = new Map();
      for (const name of (baseNames || []).slice(0, 5000)) {
        const tlds = getNameTlds(name);
        if (tlds.length) map.set(name, { tld_count: tlds.length, tld_list: tlds.join(',') });
      }
      return map;
    },
    zoneTldSet: () => getIndexedTldSet(),
    completeTldSet: () => getIndexedTldSet(),
  };
}

function resolve() {
  const forced = process.env.DOMAINSCOUT_ZONE_TRUTH;
  const zi = loadZoneIndexer();
  const openSummary = loadOpenUniverseSummary();

  let summaryHandle = null;
  if (openSummary) {
    try { summaryHandle = openSummary(dataDir()); } catch (_) { summaryHandle = null; }
  }

  const legacyAsOf = zi && typeof zi.getZoneIndexAsOf === 'function' ? zi.getZoneIndexAsOf() : null;
  const legacyAvailable = !!(zi && zi.getIndexedTldSet && zi.getIndexedTldSet().size > 0);

  if (forced === 'legacy') return legacyAvailable ? buildLegacyResult(zi) : emptyResult();
  if (forced === 'summary') return summaryHandle ? buildSummaryResult(summaryHandle) : emptyResult();

  if (summaryHandle) {
    const status = summaryHandle.status();
    if (!legacyAsOf || (status.day && status.day >= legacyAsOf)) return buildSummaryResult(summaryHandle);
  }
  if (legacyAvailable) return buildLegacyResult(zi);
  return emptyResult();
}

function getZoneTruth() {
  const now = Date.now();
  const mtime = summaryMtimeMs();
  if (cache && (now - cache.computedAt) < CACHE_MS && cache.summaryMtimeMs === mtime) {
    return cache.result;
  }
  const result = resolve();
  cache = { result, computedAt: now, summaryMtimeMs: mtime };
  return result;
}

module.exports = { getZoneTruth };
