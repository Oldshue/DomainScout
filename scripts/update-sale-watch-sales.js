#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { discoverSaleLeads } = require('../server/sale-watch-discovery');

const outputPath = path.resolve(process.argv[2] || path.join(__dirname, '../data/sale-watch-discovery.json'));
const controlsPath = path.resolve(process.env.DOMAINSCOUT_SALE_WATCH_CONTROLS_PATH || path.join(__dirname, '../config/sale-watch-controls.json'));
const days = Math.max(1, Math.min(30, Number(process.env.DOMAINSCOUT_SALE_WATCH_DAYS || 7)));
const concurrency = Math.max(1, Math.min(40, Number(process.env.DOMAINSCOUT_SALE_WATCH_CONCURRENCY || 20)));

function readPreviousDiscovery(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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
    retiredEntries: [...retiredByDomain.values()],
  };
}

async function main() {
  const previous = readPreviousDiscovery(outputPath);
  const rechecks = [...(previous?.entries || [])].sort((a,b) => String(a.lastObservedAt || '').localeCompare(String(b.lastObservedAt || ''))).slice(0, 250).map(row => ({ domain: row.domain, sellerNameservers: row.sellerNameservers || [], providers: [row.venue || 'Historical seller'], departureDate: row.discovery?.departureDate || row.reportDate, sourceKind: 'retained-recheck' }));
  const latest = await discoverSaleLeads({
    previousEntries: previous?.entries || [],
    days,
    concurrency,
    watchedCandidates: [...readControls(controlsPath), ...rechecks],
    onProgress: ({ completed, total, domain }) => {
      if (completed === 1 || completed === total || completed % 25 === 0) {
        process.stderr.write(`[Sale Watch] inspected ${completed}/${total}: ${domain}\n`);
      }
    },
  });
  const result = mergeDiscoveryHistory(previous, latest);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, outputPath);
  process.stdout.write(`${JSON.stringify({ outputPath, mode: result.mode, coverage: result.coverage })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[Sale Watch] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { readPreviousDiscovery, readControls, mergeDiscoveryHistory };
