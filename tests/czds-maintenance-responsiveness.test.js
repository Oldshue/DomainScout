'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const importer = fs.readFileSync(path.join(root, 'server/czds-drop-importer.js'), 'utf8');

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
