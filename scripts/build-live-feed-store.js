#!/usr/bin/env node
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { advanceDay } = require('../server/live-sites-public-store');

async function main() {
  const universeDir = path.resolve(process.argv[2] || process.env.DOMAINSCOUT_UNIVERSE_DIR || 'data/universe');
  const limit = Math.max(1, Math.min(30, Number(process.argv[3]) || 7));
  const days = (await fsp.readdir(universeDir, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)).map(entry => entry.name).sort().reverse().slice(0, limit).reverse();
  const results = [];
  for (const day of days) {
    const result = await advanceDay({ universeDir, day });
    results.push(result); console.log(JSON.stringify(result));
  }
  console.log(JSON.stringify({ ok: true, universeDir, results }));
}
main().catch(error => { console.error(`[live-feed-store] ${error.stack || error.message}`); process.exitCode = 1; });
