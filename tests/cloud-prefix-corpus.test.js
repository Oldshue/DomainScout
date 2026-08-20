'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudPrefixCorpusWriter, readCloudPrefixCorpus } = require('../server/cloud-prefix-corpus');

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
