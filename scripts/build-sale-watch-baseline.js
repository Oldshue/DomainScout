#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function buildBaseline(discovery) {
  return {
    schema: discovery.schema,
    generatedAt: discovery.generatedAt,
    window: discovery.window,
    mode: discovery.mode,
    baseline: true,
    coverage: discovery.coverage,
    sourceResults: discovery.sourceResults || [],
    entries: discovery.entries || [],
    retiredEntries: discovery.retiredEntries || [],
  };
}

function main() {
  const inputPath = path.resolve(process.argv[2] || 'data/sale-watch-discovery.json');
  const outputPath = path.resolve(process.argv[3] || 'config/sale-watch-discovery-baseline.json');
  const discovery = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const baseline = buildBaseline(discovery);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, outputPath);
  process.stdout.write(`${JSON.stringify({ inputPath, outputPath, entries: baseline.entries.length })}\n`);
}

if (require.main === module) main();

module.exports = { buildBaseline };
