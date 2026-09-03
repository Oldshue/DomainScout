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
    query: () => [], count: () => 0,
    nameZones: () => ({ exact: false, tlds: [] }),
    lookupMany: () => new Map(),
    zoneTldSet: () => new Set(),
    completeTldSet: () => new Set(),
  };
}

function buildSummaryResult(handle) {
  const status = handle.status();
  return {
    source: 'universe-summary', asOf: status.day, tlds: status.zones,
    names: status.namesMulti, minZones: status.minZones, complete: false,
    query: (term, mode, opts) => handle.query(term, mode, opts),
    count: (term, mode) => handle.count(term, mode),
    nameZones: (baseName) => handle.nameZones(baseName),
    lookupMany: (baseNames) => handle.lookupMany(baseNames),
    zoneTldSet: () => handle.zoneTldSet(),
    completeTldSet: () => new Set(),
  };
}

function buildLegacyResult(zi) {
  const { queryZoneIndex, countZoneIndexMatches, getNameTlds, getIndexedTldSet, getZoneIndexAsOf } = zi;
  const tldSet = getIndexedTldSet();
  return {
    source: 'zone-index',
    asOf: typeof getZoneIndexAsOf === 'function' ? getZoneIndexAsOf() : null,
    tlds: tldSet.size, names: null, minZones: 1, complete: true,
    query: (term, mode, opts = {}) => queryZoneIndex(term, mode, opts),
    count: (term, mode) => countZoneIndexMatches(term, mode),
    nameZones: (baseName) => ({ exact: true, tlds: getNameTlds(baseName) }),
    lookupMany: (baseNames) => {
      const map = new Map();
      for (const name of (baseNames || []).slice(0, 5000)) map.set(name, getNameTlds(name));
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
