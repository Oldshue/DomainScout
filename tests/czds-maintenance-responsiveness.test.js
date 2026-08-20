'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const importer = fs.readFileSync(path.join(root, 'server/czds-drop-importer.js'), 'utf8');
const syncWorker = fs.readFileSync(path.join(root, 'server/czds-sync.js'), 'utf8');

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

test('full-universe refresh defers repeated summary work and rebuilds it once', () => {
  assert.match(server, /CZDS_SKIP_SUMMARY_REFRESH: options\.includeHeavy/);
  assert.match(syncWorker, /summaryWasDeferred = process\.env\.CZDS_SKIP_SUMMARY_REFRESH === '1'/);
  assert.match(syncWorker, /newZones > 0 \|\| summaryWasDeferred/);
});

test('full-zone and prefix workers share one bounded CZDS download lane', () => {
  assert.match(server, /if \(prefixScanRunning\) \{[\s\S]*czdsFullSyncPending = true/);
  assert.match(server, /if \(czdsSyncRunning\) \{\s*return \{ ok: false, error: 'Deep prefix scan deferred/);
  assert.match(server, /if \(czdsFullSyncPending\) \{[\s\S]*startCzdsSync\('deferred full coverage'/);
});
