'use strict';

// Child-process entry for one live-sites day: `node server/live-sites-worker.js <day> [--force] [--judge]`.
// --judge only labels the day's unlabelled on-disk rows (judgement backfill).
// Runs outside the web process so ~40k homepage fetches never load the
// server's event loop. Exit 0 = day complete (or already complete),
// 2 = no movement tape, 1 = failure. SIGTERM aborts and keeps the resume journal.

const path = require('path');
const { observeDay } = require('./live-sites');
const { judgeDay } = require('./live-sites-judge');

async function main() {
  const day = process.argv[2];
  const force = process.argv.includes('--force');
  const judgeOnly = process.argv.includes('--judge');
  const dataDir = process.env.DOMAINSCOUT_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
  const directory = process.env.DOMAINSCOUT_UNIVERSE_DIR || path.join(dataDir, 'universe');
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
  try {
    if (judgeOnly) {
      const result = await judgeDay({ directory, day, signal: controller.signal });
      if (result.skipped) console.log(`[LiveSites] ${day}: judgement skipped (${result.skipped})`);
      process.exitCode = 0;
      return;
    }
    const result = await observeDay({ directory, day, force, signal: controller.signal });
    if (result.skipped) console.log(`[LiveSites] ${day}: already complete`);
    process.exitCode = 0;
  } catch (error) {
    console.error(`[LiveSites] ${day} failed: ${error.message}`);
    process.exitCode = error.code === 'NO_TAPE' ? 2 : 1;
  }
}

main().finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100).unref());
