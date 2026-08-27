'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { CloudPrefixCorpusWriter, readCloudPrefixCorpus } = require('../server/cloud-prefix-corpus');
const { indexedPrefixNames, indexedTldsForDate, indexedPrefixNamesSince, indexedTldsSince } = require('../server/czds-prefix-scan');
const { renderPrefixReport } = require('../server/prefix-report');

function memoryStore() {
  const objects = new Map();
  return {
    descriptor: { version: 1, provider: 'fixture', bucket: 'test', prefix: 'fixture/v1' },
    objects,
    async putJson(key, value) {
      objects.set(key, structuredClone(value));
      return { key: `fixture/v1/${key}`, sha256: 'a'.repeat(64), bytes: 1, storedBytes: 1 };
    },
    async getJson(key) {
      return objects.has(key) ? { key, sha256: 'a'.repeat(64), value: structuredClone(objects.get(key)) } : null;
    },
  };
}

test('cloud corpus publishes exact deterministic extension counts for an unrelated prefix', async () => {
  const store = memoryStore();
  const writer = new CloudPrefixCorpusWriter({
    store, prefix: 'solar', totalTlds: 3, startedAt: '2026-08-20T12:00:00.000Z',
  });
  await writer.start();
  await writer.recordTld('com', ['solar', 'solargrid', 'solargrid'], 'fixture-zone');
  await writer.recordTld('.net', ['solargrid', 'solarpanel'], 'fixture-zone');
  await writer.recordTld('org', [], 'fixture-zone');
  const receipt = await writer.finish();

  assert.equal(receipt.complete, true);
  assert.equal(receipt.checked_tlds, 3);
  assert.equal(receipt.failed_tlds, 0);
  assert.equal(receipt.names, 3);
  assert.equal(receipt.hits, 4);
  const corpus = await readCloudPrefixCorpus(store, 'solar');
  assert.deepEqual(corpus.rows, [
    { base_name: 'solargrid', tld_count: 2, tld_list: ['.com', '.net'] },
    { base_name: 'solar', tld_count: 1, tld_list: ['.com'] },
    { base_name: 'solarpanel', tld_count: 1, tld_list: ['.net'] },
  ]);
});

test('partial cloud corpus never replaces the last complete pointer', async () => {
  const store = memoryStore();
  const writer = new CloudPrefixCorpusWriter({
    store, prefix: 'warehouse', totalTlds: 2, startedAt: '2026-08-20T13:00:00.000Z',
  });
  await writer.start();
  await writer.recordTld('com', ['warehouseops']);
  await writer.recordFailure('net', new Error('registry timeout'));
  const receipt = await writer.finish();
  assert.equal(receipt.complete, false);
  assert.equal(receipt.status, 'partial');
  assert.equal(store.objects.has('prefix-corpora/warehouse/latest.json'), false);
});

test('cloud prefix scan treats a missing local zone-index schema as an empty optional cache', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-prefix-cache-'));
  const dbPath = path.join(directory, 'zone_index.db');
  new Database(dbPath).close();

  assert.deepEqual([...indexedTldsForDate('2026-08-20', dbPath)], []);
  assert.equal(indexedPrefixNames('solar', 'com', '2026-08-20', dbPath), null);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('cloud prefix scan reuses any fresh indexed snapshot and rejects a stale unrelated zone', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-prefix-fresh-cache-'));
  const dbPath = path.join(directory, 'zone_index.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE zone_indexed_tlds (tld TEXT PRIMARY KEY, file_date TEXT NOT NULL);
    CREATE TABLE zone_names (base_name TEXT NOT NULL, tld TEXT NOT NULL, PRIMARY KEY(base_name, tld));
  `);
  db.prepare('INSERT INTO zone_indexed_tlds (tld, file_date) VALUES (?, ?)').run('shop', '2026-08-26');
  db.prepare('INSERT INTO zone_indexed_tlds (tld, file_date) VALUES (?, ?)').run('museum', '2026-08-24');
  db.prepare('INSERT INTO zone_names (base_name, tld) VALUES (?, ?)').run('solargrid', '.shop');
  db.close();

  assert.deepEqual([...indexedTldsSince('2026-08-26', dbPath)], ['shop']);
  assert.deepEqual(indexedPrefixNamesSince('solar', 'shop', '2026-08-26', dbPath), {
    fileDate: '2026-08-26', names: ['solargrid'],
  });
  assert.equal(indexedPrefixNamesSince('solar', 'museum', '2026-08-26', dbPath), null);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('an unrelated complete prefix renders a portable evidence report in deterministic order', () => {
  const html = renderPrefixReport({
    prefix: 'solar',
    coverage: { complete: true, total_tlds: 3, checked_tlds: 3, failed_tlds: 0, hits: 4, runId: 'run-solar' },
    rows: [
      { base_name: 'solargrid', tld_count: 2, tld_list: ['.com', '.net'] },
      { base_name: 'solar', tld_count: 1, tld_list: ['.com'] },
    ],
    generatedAt: '2026-08-20T12:00:00.000Z',
  });
  assert.match(html, /DomainScout solar universe — 2 names across 3 zones/);
  assert.ok(html.indexOf('solargrid') < html.indexOf('<td>solar</td>'));
  assert.match(html, /3 \/ 3/);
  assert.match(html, /run-solar/);
});
