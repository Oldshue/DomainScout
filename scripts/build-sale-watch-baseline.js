#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function buildBaseline(discovery, { probableDomains = null, ledgerDomains = null } = {}) {
  const selected = probableDomains instanceof Set
    ? (discovery.entries || []).filter(entry => probableDomains.has(entry.domain)
      || entry.observationStatus === 'observed-in-latest-scan')
    : (discovery.entries || []);
  const retainedDomains = new Set([
    ...(probableDomains instanceof Set ? probableDomains : []),
    ...(ledgerDomains instanceof Set ? ledgerDomains : []),
  ]);
  const retiredEntries = probableDomains instanceof Set
    ? (discovery.retiredEntries || []).filter(entry => retainedDomains.has(entry.domain))
    : (discovery.retiredEntries || []);
  return {
    schema: discovery.schema,
    generatedAt: discovery.generatedAt,
    window: discovery.window,
    mode: discovery.mode,
    baseline: true,
    coverage: discovery.coverage,
    sourceResults: discovery.sourceResults || [],
    entries: selected,
    retiredEntries,
  };
}

function readDomainSet(dbPath) {
  if (!dbPath) return null;
  const Database = require('better-sqlite3');
  const db = new Database(path.resolve(dbPath), { readonly: true });
  try {
    return new Set(db.prepare('SELECT domain FROM sale_watch_probable').all().map(row => row.domain));
  } finally {
    db.close();
  }
}

function readLedgerDomains(ledgerPath) {
  if (!ledgerPath) return null;
  const ledger = JSON.parse(fs.readFileSync(path.resolve(ledgerPath), 'utf8'));
  return new Set((ledger.entries || []).map(entry => entry.domain).filter(Boolean));
}

function main() {
  const inputPath = path.resolve(process.argv[2] || 'data/sale-watch-discovery.json');
  const outputPath = path.resolve(process.argv[3] || 'config/sale-watch-discovery-baseline.json');
  const probableDbPath = process.argv[4] || '';
  const ledgerPath = process.argv[5] || '';
  const discovery = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const baseline = buildBaseline(discovery, {
    probableDomains: readDomainSet(probableDbPath),
    ledgerDomains: readLedgerDomains(ledgerPath),
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, outputPath);
  process.stdout.write(`${JSON.stringify({
    inputPath,
    outputPath,
    generatedAt: baseline.generatedAt,
    entries: baseline.entries.length,
    retiredEntries: baseline.retiredEntries.length,
    bounded: Boolean(probableDbPath),
  })}\n`);
}

if (require.main === module) main();

module.exports = { buildBaseline };
