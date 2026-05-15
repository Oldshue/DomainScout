require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { runCZDS } = require('../scrapers/czds');
const { indexAllPendingZoneFiles, getZoneIndexStats, rebuildNameSummary } = require('./zone-indexer');

function readNumberArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  if (!arg) return undefined;
  const n = Number(arg.slice(prefix.length));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main() {
  const full = process.argv.includes('--full');
  const maxTlds = readNumberArg('max-tlds');
  const maxZoneMb = readNumberArg('max-zone-mb');

  console.log(`[CZDS Worker] Starting ${full ? 'full' : 'fast'} sync`);
  await runCZDS({
    fast: !full,
    includeHeavy: full,
    maxTlds,
    maxZoneMb,
  });
  await indexAllPendingZoneFiles();

  let stats = getZoneIndexStats();
  if (stats.names > 0 && stats.summaryNames === 0) {
    console.log('[CZDS Worker] Summary empty; building name_summary once');
    rebuildNameSummary();
    stats = getZoneIndexStats();
  }
  console.log(`[CZDS Worker] Complete: ${stats.tlds} TLDs, ${stats.names.toLocaleString()} names indexed`);
}

main().catch(err => {
  console.error('[CZDS Worker] Failed:', err.message);
  process.exitCode = 1;
});
