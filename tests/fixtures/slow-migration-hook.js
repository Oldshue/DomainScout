'use strict';

// Test-only hook for the real 'migrate' job in server/sale-watch-wave-child.js
// (active only with DOMAINSCOUT_SALE_WATCH_WAVE_TEST_HOOKS=1). It stands in for
// a partial CREATE INDEX scanning a 21 GB table: it holds the migration child
// for SLOW_MIGRATION_HOOK_MS before the real ensureReconstructionSchema runs.
module.exports = async function slowMigrationHook() {
  const ms = Number(process.env.SLOW_MIGRATION_HOOK_MS || 6000);
  await new Promise(resolve => setTimeout(resolve, ms));
};
