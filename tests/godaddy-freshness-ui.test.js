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

test('desktop open refresh obeys the server freshness contract', () => {
  const start = app.indexOf('async refreshGoDaddyPricesOnOpen()');
  const end = app.indexOf('\n  formatInventoryAge(', start);
  const refreshOnOpen = app.slice(start, end);
  assert.match(refreshOnOpen, /if \(!before\) return/);
  assert.match(refreshOnOpen, /before\?\.refreshMaxAgeMs/);
  assert.match(refreshOnOpen, /before\?\.inventory\?\.current/);
  assert.doesNotMatch(refreshOnOpen, /maxAgeMs\) < 2 \* 60 \* 1000/);
});

test('a transient desktop request failure retries until the verified auction page renders', () => {
  assert.match(app, /Waiting for verified auction list/);
  assert.match(app, /_goDaddyLoadRetryAttempt/);
  assert.match(app, /Math\.min\(10000, 1000 \* \(2 \*\* \(attempt - 1\)\)\)/);
  assert.match(app, /_inventoryWarmRetryTimer = setTimeout\(\(\) => this\.loadDomains\(\), retryMs\)/);
  assert.match(app, /this\._goDaddyLoadRetryAttempt = 0/);
});

test('post-refresh warm-up parses large inventory only in the query worker', () => {
  const helperStart = server.indexOf('function prewarmGoDaddyQueryWorker');
  const helperEnd = server.indexOf('\nfunction startGoDaddyRefreshWorker', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'worker pre-warm helper must exist');
  const helper = server.slice(helperStart, helperEnd);
  assert.match(helper, /goDaddyWorkerQuery/);
  assert.doesNotMatch(helper, /readGoDaddyInventory(?:Index|DomainMap|Cache)/);

  assert.match(server, /if \(code === 0\) recycleGoDaddyQueryWorker\(\['godaddy-auction'\]\)/);
  assert.match(server, /prewarmGoDaddyQueryWorker\(\['godaddy-closeout'\]\)/);
});

test('post-refresh worker recycle frees the previous parsed generation before warming', () => {
  const recycleStart = server.indexOf('function recycleGoDaddyQueryWorker');
  const recycleEnd = server.indexOf('\nasync function goDaddyWorkerQuery', recycleStart);
  const recycle = server.slice(recycleStart, recycleEnd);
  assert.match(recycle, /worker\.terminate\(\)/);
  assert.ok(recycle.indexOf('worker.terminate()') < recycle.lastIndexOf('prewarmGoDaddyQueryWorker(streams)'));
  assert.match(server, /if \(_gdWorkerRecyclePromise\) await _gdWorkerRecyclePromise/);
  assert.match(server, /if \(_gdWorker !== w\) return/);
});

test('full-board refresh yields CPU to interactive desktop requests', () => {
  const workerStart = server.indexOf('function startGoDaddyRefreshWorker');
  const workerEnd = server.indexOf('\nfunction attachZoneIndex', workerStart);
  const worker = server.slice(workerStart, workerEnd);
  assert.match(worker, /fs\.existsSync\('\/usr\/bin\/nice'\)/);
  assert.match(worker, /args = \['-n', '10', process\.execPath, \.\.\.childArgs\]/);
  assert.match(worker, /spawn\(command, args/);
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

test('expired diagnostics never race the auction page or its filters', () => {
  const initStart = app.indexOf('async init()');
  const initEnd = app.indexOf('\n  async refreshGoDaddyPricesOnOpen', initStart);
  const init = app.slice(initStart, initEnd);
  assert.doesNotMatch(init, /Promise\.all\(\[this\.loadDomains\(\), this\.checkConfig\(\)\]\)/);
  assert.match(init, /await this\.loadDomains\(\);\s*if \(this\.isExpiredView\(\)\) this\.checkConfig\(\);/);
  assert.match(init, /setInterval\(\(\) => \{\s*if \(this\.isExpiredView\(\)\) this\.checkConfig\(\);/);

  const streamStart = app.indexOf('setStream(stream)');
  const streamEnd = app.indexOf('\n  // ── TLD filter', streamStart);
  const setStream = app.slice(streamStart, streamEnd);
  assert.match(setStream, /const pageLoad = this\.loadDomains\(\)/);
  assert.match(setStream, /if \(this\.isExpiredView\(\)\) \{\s*pageLoad\.then/);
  assert.match(app, /fetch\(`\$\{API\}\/api\/config-status\?full=1`\)/);
});

test('legacy config polling is lightweight and cannot strand auction filters', () => {
  const routeStart = server.indexOf("app.get('/api/config-status'");
  const routeEnd = server.indexOf('\nlet czdsSyncRunning', routeStart);
  const route = server.slice(routeStart, routeEnd);
  const compatibilityReturn = route.indexOf("if (req.query.lightweight === '1' || auctionDesktopCompatibilityRequest)");
  const expensiveProjection = route.indexOf('const zoneStats = getZoneIndexStats()');
  assert.ok(compatibilityReturn >= 0 && compatibilityReturn < expensiveProjection);
  assert.match(route.slice(compatibilityReturn, expensiveProjection), /lightweight: true/);
  assert.match(route.slice(compatibilityReturn, expensiveProjection), /return res\.json/);
  assert.match(route.slice(0, expensiveProjection), /stream=godaddy-/);
});

test('a cold sidebar stats cache cannot block the auction request loop', () => {
  const routeStart = server.indexOf("app.get('/api/stats'");
  const routeEnd = server.indexOf("app.patch('/api/domains/:id'", routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /if \(STATS_REFRESH_ENABLED\) refreshStatsCache\(\{ force: true \}\)/);
  assert.match(route, /warming: STATS_REFRESH_ENABLED/);
  assert.doesNotMatch(route, /const stats = buildStats\(\)/);
});

test('a serveable auction page is delivered before a due provider refresh starts', () => {
  const routeStart = server.indexOf("app.get('/api/domains'");
  const routeEnd = server.indexOf("app.get('/api/domain/", routeStart);
  const route = server.slice(routeStart, routeEnd);
  const blockedRefresh = route.indexOf("startGoDaddyRefreshWorker('stale-live-view')");
  const finishHook = route.indexOf("res.once('finish'");
  const deferredRefresh = route.indexOf("startGoDaddyRefreshWorker('stale-live-view')", blockedRefresh + 1);
  assert.ok(blockedRefresh >= 0, 'a blocked snapshot must repair immediately');
  assert.ok(finishHook > blockedRefresh, 'serveable refresh must be attached to response completion');
  assert.ok(deferredRefresh > finishHook, 'the large refresh must start only after rows are delivered');
  assert.match(route, /setTimeout\(\(\) => startGoDaddyRefreshWorker\('stale-live-view'\), 1_000\)/);
});

test('cache-backed GoDaddy filters divert before SQLite query planning', () => {
  const routeStart = server.indexOf("app.get('/api/domains'");
  const routeEnd = server.indexOf("app.get('/api/domain/", routeStart);
  const route = server.slice(routeStart, routeEnd);
  const earlyWorker = route.indexOf('const earlySortBy');
  const sqlPlanning = route.indexOf('const conditions = []');
  assert.ok(earlyWorker >= 0 && earlyWorker < sqlPlanning);
  assert.match(route.slice(earlyWorker, sqlPlanning), /serveGoDaddyViaWorker/);
  assert.match(route.slice(earlyWorker, sqlPlanning), /canUseGoDaddyCacheForDomainRequest/);
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

test('on-view live bid enrichment cannot freeze the desktop SQLite thread', () => {
  const start = server.indexOf('async function refreshLiveForDomains');
  const end = server.indexOf('\nfunction normalizeSaleInfo', start);
  assert.ok(start >= 0 && end > start, 'on-view live lookup must exist');
  const lookup = server.slice(start, end);
  assert.match(lookup, /await dbReadQuery\(/);
  assert.match(lookup, /15_000/);
  assert.match(lookup, /if \(!liveListings\.ENABLED\) return/);
  assert.doesNotMatch(lookup, /db\.prepare/);
});
