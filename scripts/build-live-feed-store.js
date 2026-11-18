#!/usr/bin/env node
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { advanceDay } = require('../server/live-sites-public-store');
const { snapshotFiles, removeSnapshot } = require('../server/live-sites-public-snapshot');
const { releaseOwnFileCache } = require('../server/file-cache-advice');

async function main() {
  const universeDir = path.resolve(process.argv[2] || process.env.DOMAINSCOUT_UNIVERSE_DIR || 'data/universe');
  const limit = Math.max(1, Math.min(30, Number(process.argv[3]) || 7));
  const all = (await fsp.readdir(universeDir, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)).map(entry => entry.name).sort().reverse();
  const days = all.slice(0, limit); // newest first: the days read most are ready soonest
  const results = [];
  for (const day of days) {
    const result = await advanceDay({ universeDir, day });
    results.push(result); console.log(JSON.stringify(result));
  }
  // The reader holds only the newest days in memory; older days keep their store and shed the copy.
  for (const day of all.slice(limit + 1)) removeSnapshot(path.join(universeDir, day, 'sites'));
  const cacheFiles = days.flatMap(day => {
    const sites = path.join(universeDir, day, 'sites');
    return ['observations.jsonl', 'observations.partial.jsonl', 'ct-launches.jsonl', 'public-feed-v2.sqlite', 'public-feed-v2.sqlite-wal']
      .map(name => path.join(sites, name)).concat(snapshotFiles(sites));
  });
  const fileCache = await releaseOwnFileCache(cacheFiles);
  console.log(JSON.stringify({ ok: true, universeDir, results, fileCache }));
}
main().catch(error => { console.error(`[live-feed-store] ${error.stack || error.message}`); process.exitCode = 1; });
