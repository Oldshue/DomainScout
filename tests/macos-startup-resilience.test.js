'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'DomainScoutApp.swift'), 'utf8');

test('desktop readiness opens the shell without blocking on provider inventory', () => {
  assert.match(source, /api\/desktop-readiness/);
  assert.match(source, /URLSession\.shared\.dataTask/);
  assert.doesNotMatch(source, /private func isServerListening/);
  const readinessCheck = source.match(/private func checkServerReady[\s\S]*?\n  }\n\n  private func loadDomainScout/)?.[0] || '';
  assert.match(readinessCheck, /json\["ready"\].*true/);
  assert.match(readinessCheck, /json\["frontend"\].*true/);
  assert.match(readinessCheck, /timeoutInterval: 1\.0/);
  assert.doesNotMatch(readinessCheck, /api\/domains|domains\.isEmpty|auctionHealth|godaddyInventory/);
  assert.doesNotMatch(source, /URL\(string: "http:\/\/127\.0\.0\.1:\\\(config\.port\\\)\/api\/godaddy-refresh"\)/);
});

test('desktop navigation starts immediately and is gated to the immutable installed build', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const start = source.indexOf('private func startServerAndLoad');
  const end = source.indexOf('\n  private func startServer()', start);
  const launch = source.slice(start, end);
  assert.ok(launch.indexOf('loadDomainScout()') < launch.indexOf('checkServerReady'));
  assert.match(source, /URLQueryItem\(name: "expectedBuild", value: expectedBuild\)/);
  assert.match(source, /shellHasRendered/);
  assert.match(source, /rendered shell ended native readiness polling/);
  assert.match(server, /const runningSourceCommit/);
  assert.match(server, /runningSourceCommit === expectedBuild/);
  assert.match(server, /http-equiv="refresh" content="0\.25"/);
  assert.ok(server.indexOf("app.get('/', (req, res, next)") < server.indexOf('app.use(express.static'));
});

test('readiness recovery reloads a WebKit about:blank shell after an early navigation race', () => {
  assert.match(source, /private var needsDomainScoutLoad: Bool/);
  assert.match(source, /guard !shellHasRendered else \{ return false \}/);
  assert.match(source, /url\.scheme == "about"/);
  assert.match(source, /if self\.needsDomainScoutLoad \{ self\.loadDomainScout\(\) \}/);
});

test('desktop readiness route stays cheap and provider-neutral', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const routeStart = server.indexOf("app.get('/api/desktop-readiness'");
  const domainsStart = server.indexOf("app.get('/api/domains'");
  assert.ok(routeStart > 0 && routeStart < domainsStart, 'readiness route must precede the inventory route');
  const route = server.slice(routeStart, server.indexOf('\n});', routeStart) + 4);
  assert.match(route, /ready: true/);
  assert.match(route, /frontend: true/);
  assert.doesNotMatch(route, /godaddy|namecheap|\.ai|db\.|prepare\(|readFile|Snapshot|QueryReadiness/i);
});

test('a slow server remains recoverable instead of becoming a permanent error screen', () => {
  assert.match(source, /continuing readiness checks/);
  assert.match(source, /This window will recover automatically/);
  assert.match(source, /waiting without restarting it/);
  assert.match(source, /launchctl", \["print", target\]/);
  assert.match(source, /startupRecoveryAttempt == 0/);
  assert.match(source, /bounded startup recovery kickstart result/);
  assert.match(source, /Restarting DomainScout server automatically/);
  assert.doesNotMatch(source, /server did not become ready/);
});

test('direct fallback preserves the desktop service isolation flags', () => {
  assert.match(source, /DOMAINSCOUT_EXPIRED_DOGFOOD_ENABLED"\] = "0"/);
  assert.match(source, /DOMAINSCOUT_EXPIRED_DOGFOOD_AFTER_AVAILABILITY"\] = "0"/);
  assert.match(source, /DOMAINSCOUT_TLD_ACCURACY_WORKER"\] = "0"/);
  assert.match(source, /DOMAINSCOUT_GODADDY_MAIN_THREAD_ENRICHMENT"\] = "0"/);
  assert.match(source, /DOMAINSCOUT_GODADDY_BACKGROUND_REFRESH_MAX_AGE_MS"\] = "900000"/);
  assert.match(source, /DOMAINSCOUT_GODADDY_SERVE_MAX_AGE_MS"\] = "1800000"/);
  assert.match(source, /DOMAINSCOUT_FTS_SYNC_ENABLED"\] = "0"/);
  assert.match(source, /DOMAINSCOUT_CCTLD_INDEX_WORKER"\] = "0"/);
  assert.match(source, /DOMAINSCOUT_MARKET_SIBLING_AUTOSCAN"\] = "0"/);
});

test('the installed login service keeps the expensive TLD backfill out of desktop startup', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-macos-app.sh'), 'utf8');
  assert.match(installer, /<key>DOMAINSCOUT_TLD_ACCURACY_WORKER<\/key>\s*<string>0<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_STARTUP_PREWARM<\/key>\s*<string>1<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_BACKGROUND_REFRESH_MAX_AGE_MS<\/key>\s*<string>900000<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_SERVE_MAX_AGE_MS<\/key>\s*<string>1800000<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_MAIN_THREAD_ENRICHMENT<\/key>\s*<string>0<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_FTS_SYNC_ENABLED<\/key>\s*<string>0<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_CCTLD_INDEX_WORKER<\/key>\s*<string>0<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_MARKET_SIBLING_AUTOSCAN<\/key>\s*<string>0<\/string>/);
  assert.match(installer, /TLD_WORKER_LABEL="com\.hamp\.domainscout\.tldworker"/);
  assert.match(installer, /<string>server\/tlds-worker\.js<\/string>/);
  assert.match(installer, /<key>TLDS_WORKER_USE_ZONE<\/key>\s*<string>1<\/string>/);
  assert.doesNotMatch(installer, /<key>DOMAINSCOUT_DNS_ONLY_UNIVERSE<\/key>/);
  assert.match(installer, /<key>RunAtLoad<\/key>\s*<true\/>[\s\S]*<key>KeepAlive<\/key>\s*<true\/>/);
});

test('a freshly bootstrapped on-demand service is started for bounded health verification', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-macos-app.sh'), 'utf8');
  const reloadBlock = installer.match(/if \[ "\$RELOAD_SERVICE" = "1" \]; then([\s\S]*?)\nfi/)?.[1] || '';
  const helperBlock = installer.match(/reload_gui_service\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(helperBlock, /launchctl bootstrap/);
  assert.match(helperBlock, /launchctl kickstart -k/);
  assert.equal((reloadBlock.match(/reload_gui_service/g) || []).length, 3);
  assert.match(reloadBlock, /reload_gui_service "\$LABEL" "\$PLIST" 1/);
  assert.match(reloadBlock, /TLD_WORKER_LABEL/);
  assert.match(installer, /UPDATER_LABEL/);
});

test('generated app and LaunchAgent targets cannot retain stale provenance', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-macos-app.sh'), 'utf8');
  assert.match(installer, /clear_generated_provenance\(\)/);
  assert.match(installer, /xattr -dr com[.]apple[.]provenance/);
  assert.match(installer, /clear_generated_provenance "\$APP_DIR"[\s\S]*codesign --force --sign - "\$APP_DIR"/);
  assert.match(installer, /clear_generated_provenance "\$PLIST"/);
  assert.match(installer, /clear_generated_provenance "\$UPDATER_PLIST"/);
  assert.doesNotMatch(installer, /xattr[^\n]+-c/);
});

test('the injected diagnostics relay remains syntactically balanced', () => {
  assert.equal((source.match(/window\.addEventListener\('error'/g) || []).length, 1);
});

test('the desktop accepts a controller-backed shell while provider rows keep loading', () => {
  assert.match(source, /probeRenderedContent\(attempt: 0, generation: renderProbeGeneration\)/);
  assert.match(source, /#domain-tbody \.domain-name/);
  assert.match(source, /rows > 0 && !names\.isEmpty/);
  assert.match(source, /let shellReady = bodyLength > 200 && readyState == "complete"/);
  assert.match(source, /appType == "object" && !resultCount\.isEmpty/);
  assert.match(source, /DOM shell ready after/);
  assert.match(source, /attempt < 40/);
  assert.match(source, /loadingCopy\(for: selectedStream\)/);
  assert.match(source, /case "namecheap-auction": descriptor = "Namecheap auctions"/);
  assert.match(source, /case "godaddy-auction": descriptor = "GoDaddy auctions"/);
  assert.match(source, /default: descriptor = "DomainScout results"/);
  assert.match(source, /DOM ready after/);
  assert.match(source, /DOM render timeout/);
  assert.doesNotMatch(source, /func webView\([\s\S]{0,200}statusLabel\.isHidden = true/);
});

test('a controller-less or blank page self-heals without misclassifying slow inventory', () => {
  assert.match(source, /renderProbeGeneration/);
  assert.match(source, /guard generation == self\.renderProbeGeneration else \{ return \}/);
  assert.match(source, /self\.renderRecoveryAttempt \+= 1/);
  assert.match(source, /let delays: \[Double\] = \[0\.5, 1\.0, 2\.0, 4\.0, 8\.0, 15\.0\]/);
  assert.match(source, /self\.loadDomainScout\(\)/);
  assert.match(source, /loadingCopy\(for: selectedStream, recovering: true\)/);
  assert.doesNotMatch(source, /Press ⌘R to retry/);
});

test('loading and empty views settle without erasing state or cancelling their request', () => {
  assert.match(source, /let shellReady = bodyLength > 200/);
  assert.match(source, /appType == "object" && !resultCount\.isEmpty/);
  assert.doesNotMatch(source, /let emptyStateReady = rows == 0/);
  assert.match(source, /Data loading and retries belong to the web controller/);
});

test('shell readiness is provider-neutral across unrelated inventory projections', () => {
  const shellReadyBlock = source.match(/let shellReady[\s\S]*?if shellReady \{[\s\S]*?\n        \}/)?.[0] || '';
  assert.match(shellReadyBlock, /bodyLength > 200/);
  assert.match(shellReadyBlock, /appType == "object"/);
  assert.doesNotMatch(shellReadyBlock, /godaddy|namecheap|\.ai|\.bot/i);
  assert.match(source, /case "namecheap-auction": descriptor = "Namecheap auctions"/);
  assert.match(source, /case "godaddy-closeout": descriptor = "GoDaddy closeouts"/);
});

test('a terminated WebKit renderer visibly recovers the current filtered view', () => {
  assert.match(source, /func webViewWebContentProcessDidTerminate\(_ webView: WKWebView\)/);
  assert.match(source, /WebKit content process terminated at/);
  assert.match(source, /Recovering DomainScout view/);
  assert.match(source, /webView\.reloadFromOrigin\(\)/);
});

test('render timeout evidence identifies whether the controller script ran', () => {
  assert.match(source, /readyState: document\.readyState/);
  assert.match(source, /appType: typeof app/);
  assert.match(source, /resultCount: resultCount \? resultCount\.textContent\.trim\(\) : ''/);
  assert.match(source, /emptyMessage: emptyMessage \? emptyMessage\.textContent\.trim\(\) : ''/);
});

test('the app log identifies the exact installed build', () => {
  assert.match(source, /applicationDidFinishLaunching build=/);
  assert.match(source, /values\["BuildCommit"\]/);
});

test('background updater relaunches cannot activate DomainScout over the user\'s current app', () => {
  const release = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release-local-macos.sh'), 'utf8');
  assert.match(source, /window\.orderFront\(nil\)/);
  assert.doesNotMatch(source, /NSApp\.activate\(/);
  assert.doesNotMatch(source, /window\.makeKeyAndOrderFront\(nil\)/);
  assert.match(release, /open -g "\$APP_DIR"/);
  assert.match(release, /open -g -a "DomainScout"/);
});

test('every supervised server launch verifies production convergence before Node starts', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-macos-app.sh'), 'utf8');
  assert.match(installer, /CURRENT_SERVER_RUNNER=.*run-current-server\.sh/);
  const runner = installer.match(/cat > "\$CURRENT_SERVER_RUNNER" <<RUNNER([\s\S]*?)\nRUNNER/)?.[1] || '';
  assert.match(runner, /UPDATER_SCRIPT/);
  assert.match(runner, /DOMAINSCOUT_UPDATER_ACTIVE/);
  assert.match(runner, /export PATH=/);
  assert.match(runner, /exec .*NODE_BIN.*ROOT\/server\/index\.js/);
  const serverPlist = installer.match(/cat > "\$PLIST" <<PLIST([\s\S]*?)\nPLIST/)?.[1] || '';
  assert.match(serverPlist, /CURRENT_SERVER_RUNNER/);
  assert.doesNotMatch(serverPlist, /<string>server\/index\.js<\/string>/);
});

test('zone maintenance is launched with background CPU and disk policy', () => {
  const supervisor = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'zone-fast-supervisor.sh'), 'utf8');
  assert.match(supervisor, /taskpolicy -b -d throttle -c maintenance/);
  assert.match(supervisor, /nice -n 20/);
  assert.match(supervisor, /run_maintenance server\/czds-sync\.js --full/);
});

test('headless supervision demotes maintenance workers but never the interactive server', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-macos-app.sh'), 'utf8');
  const serverStart = installer.indexOf('start_server()');
  const workerStart = installer.indexOf('start_tld_worker()', serverStart);
  const watchdogStart = installer.indexOf('start_wal_watchdog()', workerStart);
  const serverBlock = installer.slice(serverStart, workerStart);
  const workerBlock = installer.slice(workerStart, watchdogStart);
  assert.doesNotMatch(serverBlock, /taskpolicy|nice -n 20/);
  assert.match(workerBlock, /taskpolicy -b -d throttle -c maintenance/);
  assert.match(workerBlock, /nice -n 20/);
  assert.match(workerBlock, /exec nohup "\$\{maintenance_runner\[@\]\}" env/);
});

test('headless supervision adopts only the exact owned listener after updater handoff', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-macos-app.sh'), 'utf8');
  const adoptionStart = installer.indexOf('adopt_exact_server()');
  const adoptionEnd = installer.indexOf('\nstop_one()', adoptionStart);
  const adoption = installer.slice(adoptionStart, adoptionEnd);
  assert.match(adoption, /data\/server\.lock\.json/);
  assert.match(adoption, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(adoption, /kill -0/);
  assert.match(adoption, /NODE_BIN \$\{ROOT\}\/server\/index\.js/);
  assert.match(adoption, /lsof -a -p/);
  assert.match(adoption, /\[ "\$cwd" = "\$ROOT" \]/);
  assert.match(installer, /adopt_exact_server "\$pid_file" \|\| true/);
});

test('the desktop opens the verified GoDaddy auction projection instead of the blocking all-stream query', () => {
  assert.match(source, /URLQueryItem\(name: "stream", value: "godaddy-auction"\)/);
  assert.match(source, /URLQueryItem\(name: "sortField", value: "auction_end"\)/);
  assert.match(source, /URLQueryItem\(name: "sortDir", value: "ASC"\)/);
  assert.match(source, /URLQueryItem\(name: "page", value: "1"\)/);
  assert.match(source, /URLQueryItem\(name: "limit", value: "250"\)/);
});

test('desktop controller assets cannot remain stale across an installed release', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /express\.static\([\s\S]*Cache-Control/, 'static assets must set an explicit cache policy');
  assert.match(server, /Cache-Control', 'no-store'/);
});

test('startup and background market writes cannot monopolize the desktop event loop', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const tldWorker = fs.readFileSync(path.join(__dirname, '..', 'server', 'tlds-worker.js'), 'utf8');
  assert.match(server, /SELECT 1 AS present FROM domains LIMIT 1/);
  assert.doesNotMatch(server, /SELECT COUNT\(\*\) as n FROM domains'\)\.get\(\)\.n/);
  assert.match(server, /function storeLiveResults[\s\S]*busy_timeout = 75[\s\S]*cache write deferred/);
  assert.match(server, /if \(storeLiveResults\(res\.results\)\) updated \+= res\.results\.length/);
  assert.match(tldWorker, /Math\.min\([\s\S]*NAME_CONCURRENCY,[\s\S]*TLDS_WORKER_FETCH/);
  assert.doesNotMatch(tldWorker, /const FETCH_SIZE = Math\.max\(1, parseInt\(process\.env\.TLDS_WORKER_FETCH \|\| '200'/);
});
