'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'DomainScoutApp.swift'), 'utf8');

test('desktop readiness is an HTTP health probe instead of a process-list guess', () => {
  assert.match(source, /api\/godaddy-refresh/);
  assert.match(source, /URLSession\.shared\.dataTask/);
  assert.doesNotMatch(source, /private func isServerListening/);
  assert.match(source, /readyByStream/);
  assert.match(source, /godaddy-auction/);
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
  assert.match(source, /DOMAINSCOUT_FTS_SYNC_ENABLED"\] = "0"/);
});

test('the installed login service keeps the expensive TLD backfill out of desktop startup', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-macos-app.sh'), 'utf8');
  assert.match(installer, /<key>DOMAINSCOUT_TLD_ACCURACY_WORKER<\/key>\s*<string>0<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_STARTUP_PREWARM<\/key>\s*<string>1<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_GODADDY_MAIN_THREAD_ENRICHMENT<\/key>\s*<string>0<\/string>/);
  assert.match(installer, /<key>DOMAINSCOUT_FTS_SYNC_ENABLED<\/key>\s*<string>0<\/string>/);
});

test('the injected diagnostics relay remains syntactically balanced', () => {
  assert.equal((source.match(/window\.addEventListener\('error'/g) || []).length, 1);
});

test('the app log identifies the exact installed build', () => {
  assert.match(source, /applicationDidFinishLaunching build=/);
  assert.match(source, /values\["BuildCommit"\]/);
});

test('the desktop opens the verified GoDaddy auction projection instead of the blocking all-stream query', () => {
  assert.match(source, /stream=godaddy-auction&sortField=auction_end&sortDir=ASC&page=1&limit=250/);
  assert.doesNotMatch(source, /URL\(string: "http:\/\/127\.0\.0\.1:\\\(config\.port\)\/"\)/);
});
