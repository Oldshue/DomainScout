#!/usr/bin/env node
// Off-main GoDaddy closeout cache refresh.
//
// The closeout live feed updates ~hourly, so refreshCloseoutCacheLive runs every 2h.
// Doing the rebuild INLINE on the server's main thread froze the event loop for ~1.7s
// each run — writeGoDaddyInventoryCache sorts ~273k rows and synchronously
// JSON.stringify's + writeFileSync's two ~90MB files. Running it in this short-lived
// child keeps the main server responsive (the parent re-parses off its own worker on the
// file's mtime change). Closeout-only, so it stays as light as the old inline fetch —
// unlike the full --godaddy-cache-only refresh which also re-downloads the auction feed.
require('dotenv').config({ path: require('path').join(__dirname, '../.env'), quiet: true });

const { fetchLiveCloseouts } = require('../scrapers/godaddy');
const {
  recordGoDaddyRefreshEvent,
  validateGoDaddyInventorySnapshot,
  writeGoDaddyInventoryCache,
} = require('../server/godaddy-cache');

(async () => {
  const startedAt = new Date().toISOString();
  recordGoDaddyRefreshEvent('godaddy-closeout', {
    status: 'running',
    reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'closeout-refresh',
    startedAt,
  });
  try {
    const domains = await fetchLiveCloseouts();
    if (!Array.isArray(domains) || domains.length === 0) {
      console.log('[refresh-closeout] feed returned no rows; keeping prior cache');
      recordGoDaddyRefreshEvent('godaddy-closeout', {
        status: 'failed',
        reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'closeout-refresh',
        startedAt,
        completedAt: new Date().toISOString(),
        error: 'Provider returned an empty snapshot; prior validated snapshot retained.',
      });
      process.exit(2); // distinct code: nothing written (parent skips scrape_log)
    }
    const validation = validateGoDaddyInventorySnapshot('godaddy-closeout', domains);
    if (!validation.ok) throw new Error(`Closeout snapshot validation failed: ${validation.errors.join('; ')}`);
    const generatedAt = new Date().toISOString();
    writeGoDaddyInventoryCache('godaddy-closeout', domains, {
      generatedAt,
      evidence: domains.snapshotEvidence || null,
      validation,
    });
    recordGoDaddyRefreshEvent('godaddy-closeout', {
      status: 'succeeded',
      reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'closeout-refresh',
      startedAt,
      completedAt: generatedAt,
      count: domains.length,
    });
    console.log(`[refresh-closeout] wrote ${domains.length} closeouts`);
    // Emit the count on a parseable line so the parent can log scrape_log without re-fetching.
    console.log(`[refresh-closeout:count] ${domains.length}`);
    process.exit(0);
  } catch (err) {
    recordGoDaddyRefreshEvent('godaddy-closeout', {
      status: 'failed',
      reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'closeout-refresh',
      startedAt,
      completedAt: new Date().toISOString(),
      error: String(err?.message || err).slice(0, 1000),
    });
    console.error('[refresh-closeout] failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
