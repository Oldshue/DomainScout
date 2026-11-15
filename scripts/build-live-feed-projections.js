#!/usr/bin/env node
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { buildProjectionFromSource, validProjection } = require('../server/live-sites-public-projection');

async function main() {
  const universeDir = path.resolve(process.argv[2] || process.env.DOMAINSCOUT_UNIVERSE_DIR || 'data/universe');
  const limit = Math.max(1, Math.min(30, Number(process.argv[3]) || 7));
  const days = (await fsp.readdir(universeDir, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)).map(entry => entry.name).sort().reverse().slice(0, limit).reverse();
  const results = [];
  for (const day of days) {
    for (const source of ['observations.jsonl', 'ct-launches.jsonl']) {
      const sourcePath = path.join(universeDir, day, 'sites', source);
      try {
        const existing = await validProjection(sourcePath);
        if (existing) { results.push({ day, source, status: 'current', rows: existing.meta.rows }); continue; }
        const built = await buildProjectionFromSource({ sourcePath, day });
        results.push({ day, source, status: 'built', rows: built.meta.rows, bytes: built.meta.projectionBytes, searchBytes: built.meta.searchBytes });
        console.log(JSON.stringify(results.at(-1)));
      } catch (error) {
        if (error.code === 'ENOENT') { results.push({ day, source, status: 'no-source' }); continue; }
        throw error;
      }
    }
  }
  console.log(JSON.stringify({ ok: true, universeDir, results }));
}

main().catch(error => { console.error(`[live-feed-projection] ${error.stack || error.message}`); process.exitCode = 1; });
