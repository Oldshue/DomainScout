'use strict';

// Child-process entry for one live-sites day: `node server/live-sites-worker.js <day> [--force] [--retry-errors]`.
// Runs outside the web process so ~40k homepage fetches never load the
// server's event loop. Exit 0 = day complete (or already complete),
// 2 = no movement tape, 1 = failure. SIGTERM aborts and keeps the resume journal.

const path = require('path');
const { observeDay } = require('./live-sites');

async function main() {
  const day = process.argv[2];
  const force = process.argv.includes('--force');
  const retryErrors = process.argv.includes('--retry-errors');
  const dataDir = process.env.DOMAINSCOUT_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
  const directory = process.env.DOMAINSCOUT_UNIVERSE_DIR || path.join(dataDir, 'universe');
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
  try {
    const result = await observeDay({ directory, day, force, retryErrors, signal: controller.signal });
    if (result.skipped) console.log(`[LiveSites] ${day}: already ${result.skipped === 'reobserved' ? 're-observed once' : 'complete'}`);
    process.exitCode = 0;
  } catch (error) {
    console.error(`[LiveSites] ${day} failed: ${error.message}`);
    process.exitCode = error.code === 'NO_TAPE' ? 2 : 1;
  }
}

main().finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100).unref());
