'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const importer = fs.readFileSync(path.join(root, 'server/czds-drop-importer.js'), 'utf8');
const walWatchdog = fs.readFileSync(path.join(root, 'scripts/zone-wal-watchdog.sh'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'scripts/install-macos-app.sh'), 'utf8');

function functionBody(name, nextName) {
  const start = server.indexOf(`async function ${name}`);
  const end = server.indexOf(`\n${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} must remain discoverable`);
  return server.slice(start, end);
}

test('scheduled CZDS maintenance never imports on the HTTP event loop', () => {
  const body = functionBody('runCzdsDropImportMaintenance', "app.post('/api/czds-sync'");
  assert.match(body, /spawn\(command, childArgs/);
  assert.match(body, /childArgs = \['-n', '10', process\.execPath, \.\.\.args\]/);
  assert.match(body, /czds-drop-importer\.js/);
  assert.match(body, /--summary-json/);
  assert.doesNotMatch(body, /await importCzdsDropCandidates/);
  assert.doesNotMatch(server, /require\('\.\/czds-drop-importer'\)/);
});

test('CZDS worker emits a bounded single-line summary for its coordinator', () => {
  assert.match(importer, /process\.argv\.includes\('--summary-json'\)/);
  assert.match(importer, /summaryJson \? 0 : 2/);
  assert.match(importer, /imported: result\.imported/);
  assert.doesNotMatch(importer.slice(importer.indexOf('const output = summaryJson'), importer.indexOf(': result;')), /receipts:/);
});

test('overlapping scheduled maintenance reuses the one bounded worker slot', () => {
  const body = functionBody('runCzdsDropImportMaintenance', "app.post('/api/czds-sync'");
  assert.match(body, /if \(czdsDropImportChild\)/);
  assert.match(body, /running: true/);
  assert.match(body, /if \(czdsDropImportChild === child\) czdsDropImportChild = null/);
});

test('CZDS maintenance is offset from five-minute provider refresh boundaries', () => {
  assert.match(server, /cron\.schedule\('7,22,37,52 \* \* \* \*'/);
  assert.doesNotMatch(server, /cron\.schedule\('\*\/15 \* \* \* \*'/);
});

test('active zone maintenance is checkpointed and durably supervised', () => {
  assert.doesNotMatch(walWatchdog, /pgrep[\s\S]{0,160}continue/);
  assert.match(walWatchdog, /CZDS_ACTIVE="\$czds_active"/);
  assert.match(walWatchdog, /writerActive \? "RESTART" : "TRUNCATE"/);
  assert.match(walWatchdog, /wal_checkpoint\("\+mode\+"\)/);
  assert.match(walWatchdog, /DOMAINSCOUT_WAL_WATCHDOG_INTERVAL_SECONDS:-60/);
  assert.match(installer, /function start_wal_watchdog|start_wal_watchdog\(\)/);
  assert.match(installer, /start_wal_watchdog/);
  assert.match(installer, /stop_one wal-watchdog/);
});
