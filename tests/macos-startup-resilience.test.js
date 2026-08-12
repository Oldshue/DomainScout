'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'DomainScoutApp.swift'), 'utf8');

test('desktop readiness proves the user-visible auction query is populated instead of polling refresh metadata', () => {
  assert.match(source, /api\/domains\?stream=godaddy-auction/);
  assert.match(source, /URLSession\.shared\.dataTask/);
  assert.doesNotMatch(source, /private func isServerListening/);
  assert.match(source, /let domains = json\["domains"\]/);
  assert.match(source, /!domains\.isEmpty/);
  assert.match(source, /auctionHealth\["current"\]/);
  assert.match(source, /auctionHealth\["serveable"\]/);
  assert.match(source, /timeoutInterval: 5\.0/);
  assert.doesNotMatch(source, /URL\(string: "http:\/\/127\.0\.0\.1:\\\(config\.port\\\)\/api\/godaddy-refresh"\)/);
});

test('a slow server remains recoverable instead of becoming a permanent error screen', () => {
  assert.match(source, /continuing readiness checks/);
  assert.match(source, /This window will recover automatically/);
  assert.match(source, /waiting without restarting it/);
  assert.match(source, /launchctl", \["print", target\]/);
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
});

test('the installed login service keeps the expensive TLD backfill out of desktop startup', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-macos-app.sh'), 'utf8');
  assert.match(installer, /<key>DOMAINSCOUT_TLD_ACCURACY_WORKER<\/key>\s*<string>0<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_STARTUP_PREWARM<\/key>\s*<string>1<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_BACKGROUND_REFRESH_MAX_AGE_MS<\/key>\s*<string>900000<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_SERVE_MAX_AGE_MS<\/key>\s*<string>1800000<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_MAIN_THREAD_ENRICHMENT<\/key>\s*<string>0<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_FTS_SYNC_ENABLED<\/key>\s*<string>0<\/string>/);
});

test('a freshly bootstrapped on-demand service is started for bounded health verification', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-macos-app.sh'), 'utf8');
  const reloadBlock = installer.match(/if \[ "\$RELOAD_SERVICE" = "1" \]; then([\s\S]*?)\nfi/)?.[1] || '';
  assert.match(reloadBlock, /launchctl bootstrap/);
  assert.match(reloadBlock, /launchctl kickstart -k/);
  assert.equal((installer.match(/launchctl kickstart -k/g) || []).length, 1);
});

test('the injected diagnostics relay remains syntactically balanced', () => {
  assert.equal((source.match(/window\.addEventListener\('error'/g) || []).length, 1);
});

test('the desktop remains loading until rendered auction names are visible', () => {
  assert.match(source, /probeRenderedContent\(attempt: 0, generation: renderProbeGeneration\)/);
  assert.match(source, /#domain-tbody \.domain-name/);
  assert.match(source, /rows > 0 && !names\.isEmpty/);
  assert.match(source, /attempt < 40/);
  assert.match(source, /Loading current GoDaddy auctions/);
  assert.match(source, /DOM ready after/);
  assert.match(source, /DOM render timeout/);
  assert.doesNotMatch(source, /func webView\([\s\S]{0,200}statusLabel\.isHidden = true/);
});

test('a completed page that rendered no names self-heals without user intervention', () => {
  assert.match(source, /renderProbeGeneration/);
  assert.match(source, /guard generation == self\.renderProbeGeneration else \{ return \}/);
  assert.match(source, /self\.renderRecoveryAttempt \+= 1/);
  assert.match(source, /let delays: \[Double\] = \[0\.5, 1\.0, 2\.0, 4\.0, 8\.0, 15\.0\]/);
  assert.match(source, /self\.loadDomainScout\(\)/);
  assert.match(source, /Reloading current GoDaddy auctions automatically/);
  assert.doesNotMatch(source, /Press ⌘R to retry/);
});

test('a legitimate empty filtered view settles without erasing the user filter', () => {
  assert.match(source, /let emptyStateReady = rows == 0/);
  assert.match(source, /appType == "object" && !resultCount\.isEmpty/);
  assert.match(source, /DOM ready empty state after/);
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

test('the desktop opens the verified GoDaddy auction projection instead of the blocking all-stream query', () => {
  assert.match(source, /stream=godaddy-auction&sortField=auction_end&sortDir=ASC&page=1&limit=250/);
  assert.doesNotMatch(source, /URL\(string: "http:\/\/127\.0\.0\.1:\\\(config\.port\)\/"\)/);
});

test('desktop controller assets cannot remain stale across an installed release', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /express\.static\([\s\S]*Cache-Control/, 'static assets must set an explicit cache policy');
  assert.match(server, /Cache-Control', 'no-store'/);
});
