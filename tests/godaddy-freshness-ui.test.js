'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('GoDaddy UI requests fail closed when validated inventory is stale', () => {
  assert.match(server, /goDaddyStreamHealth\(streamForCache\)/);
  assert.match(server, /status\(503\)\.json\(\{/);
  assert.match(server, /error: 'inventory-not-current'/);
  assert.match(server, /stale rows are withheld/);
});

test('desktop projection visibly distinguishes verified, refreshing, and blocked inventory', () => {
  assert.match(html, /id="inventory-status"/);
  assert.match(app, /Verified current/);
  assert.match(app, /Refreshing verified inventory/);
  assert.match(app, /Inventory not current/);
  assert.match(app, /Stale auction list withheld/);
});

test('an open desktop view rechecks freshness so rows cannot silently age in place', () => {
  assert.match(app, /setInterval\(\(\) => this\.monitorGoDaddyInventory\(\), 60000\)/);
  assert.match(app, /health\.generatedAt !== state\.currentInventoryGeneratedAt/);
});

test('post-refresh warm-up parses large inventory only in the query worker', () => {
  const helperStart = server.indexOf('function prewarmGoDaddyQueryWorker');
  const helperEnd = server.indexOf('\nfunction startGoDaddyRefreshWorker', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'worker pre-warm helper must exist');
  const helper = server.slice(helperStart, helperEnd);
  assert.match(helper, /goDaddyWorkerQuery/);
  assert.doesNotMatch(helper, /readGoDaddyInventory(?:Index|DomainMap|Cache)/);

  assert.match(server, /prewarmGoDaddyQueryWorker\(\['godaddy-auction', 'godaddy-closeout'\]\)/);
  assert.match(server, /prewarmGoDaddyQueryWorker\(\['godaddy-closeout'\]\)/);
});

test('desktop startup and worker failures preserve web responsiveness', () => {
  assert.match(server, /DOMAINSCOUT_GODADDY_STARTUP_PREWARM/);
  assert.match(server, /queryIndex: goDaddyQueryReadiness\(\)/);
  assert.match(server, /_gdWorkerReadyByStream/);
  assert.match(server, /for \(const stream of \['godaddy-auction'\]\)/);
  assert.match(server, /startup refresh skipped — verified cache is current/);
  assert.match(server, /error: 'inventory-index-warming'/);
  assert.doesNotMatch(server, /\[godaddy-worker\] fallback to sync/);
  assert.match(server, /startup-current-inventory/);
  assert.match(server, /background-current-inventory/);
  assert.match(server, /GODADDY_BACKGROUND_REFRESH_MAX_AGE_MS/);
  assert.match(app, /Preparing verified auction list/);
  assert.match(app, /_inventoryWarmRetryTimer/);
  assert.ok(app.indexOf('this.loadDomains()') < app.indexOf('this.loadStats();'));
});

test('synchronous FTS maintenance can be kept out of the desktop web process', () => {
  assert.match(server, /DOMAINSCOUT_FTS_SYNC_ENABLED/);
  assert.match(server, /db\.domainFtsReady && DOMAIN_FTS_SYNC_ENABLED/);
  assert.match(server, /\[FTS\] Background sync disabled/);
});

test('desktop GoDaddy pages can avoid all main-thread SQLite enrichment', () => {
  assert.match(server, /DOMAINSCOUT_GODADDY_MAIN_THREAD_ENRICHMENT/);
  assert.match(server, /hydrateDb: GODADDY_MAIN_THREAD_ENRICHMENT_ENABLED/);
  assert.match(server, /if \(GODADDY_MAIN_THREAD_ENRICHMENT_ENABLED\) \{\s*domains = overlayLiveListings\(enrichPageTldCounts\(domains\)\)/);
});

test('startup hot-listing selection never scans SQLite on the web thread', () => {
  const pollStart = server.indexOf('async function pollHotListings');
  const pollEnd = server.indexOf('\nif (liveListings.ENABLED)', pollStart);
  assert.ok(pollStart >= 0 && pollEnd > pollStart, 'hot-listing poll must exist');
  const poll = server.slice(pollStart, pollEnd);
  assert.match(poll, /await dbReadQuery/);
  assert.doesNotMatch(poll, /db\.prepare/);
});
