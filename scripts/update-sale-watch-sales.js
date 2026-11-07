#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { discoverSaleLeads } = require('../server/sale-watch-discovery');
const { readDiscovery, writeDiscovery } = require('../server/sale-watch-discovery-io');

const outputPath = path.resolve(process.argv[2] || path.join(__dirname, '../data/sale-watch-discovery.json'));
const controlsPath = path.resolve(process.env.DOMAINSCOUT_SALE_WATCH_CONTROLS_PATH || path.join(__dirname, '../config/sale-watch-controls.json'));
const days = Math.max(1, Math.min(30, Number(process.env.DOMAINSCOUT_SALE_WATCH_DAYS || 7)));
const concurrency = Math.max(1, Math.min(40, Number(process.env.DOMAINSCOUT_SALE_WATCH_CONCURRENCY || 20)));
// Event history (movementHistory, departureAssociations, retiredEntries) is
// pruned past this many days so the published file stays bounded; the durable
// record of every ingested departure lives in the reconstruction database.
const DEFAULT_RETENTION_DAYS = 120;
function retentionDays(env = process.env) {
  const value = Number(env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_RETENTION_DAYS);
  return Number.isFinite(value) && value >= 30 ? Math.floor(value) : DEFAULT_RETENTION_DAYS;
}

// Bounded incremental read (any file size). A malformed or truncated previous
// file throws DiscoveryReadError, so main() exits non-zero without replacing
// the existing file: existing data is never lost to a bad read.
function readPreviousDiscovery(filePath, options = {}) {
  const value = readDiscovery(filePath, options);
  return value && typeof value === 'object' ? value : null;
}

function pruneDiscoveryHistory(result, { days = retentionDays(), now = result.generatedAt || new Date().toISOString() } = {}) {
  const cutoff = Date.parse(now) - days * 86400000;
  if (!Number.isFinite(cutoff)) return result;
  const keep = value => { const at = Date.parse(value); return !Number.isFinite(at) || at >= cutoff; };
  // Retained-history entries (absent from the latest scan) were never pruned, so
  // the file grew without bound. Probable-tier names stay: they are the
  // Probably sold list. Everything else ages out with the event history.
  const entries = (result.entries || []).filter(row => row.observationStatus !== 'retained-history' || row.tier === 'probable' || keep(row.lastObservedAt));
  return {
    ...result,
    entries,
    movementHistory: (result.movementHistory || []).filter(row => keep(row.departureDate || row.lastObservedAt)),
    departureAssociations: (result.departureAssociations || []).filter(row => keep(row.departureDate)),
    retiredEntries: (result.retiredEntries || []).filter(row => keep(row.retiredAt || row.lastObservedAt)),
    retention: { days, prunedBefore: new Date(cutoff).toISOString() },
  };
}

function readControls(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return (value.entries || []).map(entry => ({
      domain: String(entry.domain || '').toLowerCase(),
      providers: [String(entry.provider || 'Targeted control')],
      sellerNameservers: (entry.nameservers || []).map(value => String(value).toLowerCase()),
      sourceUrls: [],
      watchReason: String(entry.watchReason || ''),
      sourceKind: 'targeted-control',
    })).filter(entry => entry.domain && entry.sellerNameservers.length);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function mergeDiscoveryHistory(previous, latest) {
  const observedAt = latest.generatedAt;
  const previousEntries = new Map((previous?.entries || []).map(entry => [entry.domain, entry]));
  const latestEntries = new Map((latest.entries || []).map(entry => [entry.domain, entry]));
  const latestRuledOut = new Map((latest.ruledOut || []).map(entry => [entry.domain, entry]));
  const entries = [];

  for (const current of latestEntries.values()) {
    const prior = previousEntries.get(current.domain);
    entries.push({
      ...prior,
      ...current,
      firstObservedAt: prior ? (prior.firstObservedAt || prior.lastObservedAt || previous?.generatedAt || observedAt) : observedAt,
      lastObservedAt: observedAt,
      observationCount: Number(prior?.observationCount || 0) + 1,
      observationStatus: 'observed-in-latest-scan',
    });
  }

  for (const prior of previousEntries.values()) {
    if (latestEntries.has(prior.domain) || latestRuledOut.has(prior.domain)) continue;
    entries.push({
      ...prior,
      firstObservedAt: prior.firstObservedAt || previous?.generatedAt || observedAt,
      lastObservedAt: prior.lastObservedAt || previous?.generatedAt || observedAt,
      observationCount: Number(prior.observationCount || 1),
      observationStatus: 'retained-history',
    });
  }

  const retiredByDomain = new Map((previous?.retiredEntries || []).map(entry => [entry.domain, entry]));
  for (const domain of latestEntries.keys()) retiredByDomain.delete(domain);
  for (const [domain, ruledOut] of latestRuledOut) {
    const prior = previousEntries.get(domain);
    if (!prior) continue;
    retiredByDomain.set(domain, {
      ...prior,
      retiredAt: observedAt,
      retirementReason: ruledOut.rationale || 'Latest scan no longer supports end-user acquisition classification.',
      latestEvidence: ruledOut.discovery || null,
    });
  }

  // Candidate state is domain-keyed; the event history must not be. Preserve
  // earlier departures even when a later scan updates or retires the same name.
  const movementHistory = new Map();
  for (const value of [previous, latest]) {
    for (const row of [...(value?.movementHistory || []), ...(value?.entries || []), ...(value?.ruledOut || []), ...(value?.retiredEntries || [])]) {
      const day = row.departureDate || row.discovery?.departureDate || row.assessment?.departureDay;
      if (!row.domain || !day) continue;
      const before = [...new Set(row.sellerNameservers || [])].sort();
      const after = [...new Set(row.buyerNameservers || [])].sort();
      const key = JSON.stringify([row.domain, day, before, after]);
      const old = movementHistory.get(key);
      const at = row.lastObservedAt || value.generatedAt || observedAt;
      if (old && String(old.lastObservedAt || '') > String(at)) continue;
      movementHistory.set(key, {
        domain: row.domain, departureDate: day, sellerNameservers: before,
        buyerNameservers: after, venue: row.venue || null, tier: row.tier,
        classification: row.classification, rationale: row.rationale,
        sourceUrl: row.sourceUrl, firstObservedAt: old?.firstObservedAt || row.firstObservedAt || value.generatedAt || observedAt,
        lastObservedAt: at, assessment: row.assessment || null,
        discovery: { departureDate: day, movement: row.discovery?.movement || null,
          parentDelegation: row.discovery?.parentDelegation || null,
          transferEvidence: row.discovery?.transferEvidence || null,
          homepage: row.discovery?.homepage || null, rdap: row.discovery?.rdap || null,
          buyerUse: row.discovery?.buyerUse || false, structurallyMoved: row.discovery?.structurallyMoved || false },
      });
    }
  }
  const departureAssociations = new Map();
  for (const row of [...(previous?.departureAssociations || []), ...(latest.departureAssociations || [])]) {
    departureAssociations.set(JSON.stringify([row.domain,row.departureDate,row.sellerNameserver]),row);
  }

  const probable = entries.filter(row => row.tier === 'probable').length;
  const suspected = entries.filter(row => row.tier === 'suspected').length;
  return {
    ...latest,
    coverage: {
      ...latest.coverage,
      currentProbable: latest.coverage?.probable || 0,
      currentSuspected: latest.coverage?.suspected || 0,
      chronicledProbable: probable,
      chronicledSuspected: suspected,
      chronicledTotal: entries.length,
      retiredAfterContradictoryEvidence: retiredByDomain.size,
    },
    entries,
    movementHistory: [...movementHistory.values()],
    departureAssociations: [...departureAssociations.values()],
    retiredEntries: [...retiredByDomain.values()],
  };
}

async function main() {
  const previous = readPreviousDiscovery(outputPath);
  const rechecks = [...(previous?.entries || [])].sort((a,b) => String(a.lastObservedAt || '').localeCompare(String(b.lastObservedAt || ''))).slice(0, 250).map(row => ({ domain: row.domain, sellerNameservers: row.sellerNameservers || [], providers: [row.venue || 'Historical seller'], departureDate: row.discovery?.departureDate || row.reportDate, sourceKind: 'retained-recheck' }));
  const firstDeferred = previous?.sourceResults?.find(row => row.error);
  const sourceSchedule = previous?.sourceSchedule || (firstDeferred ? { nextNameserver: firstDeferred.nameserver, notBefore: firstDeferred.deferredUntil || null } : null);
  const latest = await discoverSaleLeads({
    previousEntries: previous?.entries || [],
    sourceSchedule,
    days,
    concurrency,
    watchedCandidates: [...readControls(controlsPath), ...rechecks],
    onProgress: ({ completed, total, domain }) => {
      if (completed === 1 || completed === total || completed % 25 === 0) {
        process.stderr.write(`[Sale Watch] inspected ${completed}/${total}: ${domain}\n`);
      }
    },
  });
  const result = pruneDiscoveryHistory(mergeDiscoveryHistory(previous, latest));
  writeDiscovery(outputPath, result, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ outputPath, mode: result.mode, coverage: result.coverage })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[Sale Watch] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { readPreviousDiscovery, readControls, mergeDiscoveryHistory, pruneDiscoveryHistory, retentionDays, DEFAULT_RETENTION_DAYS };
