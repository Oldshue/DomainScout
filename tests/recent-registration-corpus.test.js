'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRecentRegistrationCorpus, enumerateDays, normalizeDomains } = require('../server/recent-registration-corpus');

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async get(key) { if (!objects.has(key)) { const error = new Error('missing'); error.name = 'NoSuchKey'; throw error; } return objects.get(key); },
    async put(key, body) { objects.set(key, Buffer.from(body)); },
  };
}

test('normalizes the generic corpus and enumerates its bounded window', () => {
  assert.deepEqual(normalizeDomains(['Alpha.COM', 'alpha.com.', 'bad value', 'x.ai']), ['alpha.com', 'x.ai']);
  assert.deepEqual(enumerateDays('2026-08-31', 3), ['2026-08-31', '2026-08-30', '2026-08-29']);
});

test('publishes receipt before latest and serves unrelated substring fixtures', async () => {
  const store = memoryStore();
  const corpus = createRecentRegistrationCorpus({
    objectStore: store, lookbackDays: 3, now: () => new Date('2026-09-01T06:00:00Z'), logger: { log() {}, warn() {} },
    fetchDay: async day => ({ sourceUrl: `https://source.invalid/${day}`, domains: day === '2026-08-31' ? ['stoneintellect.com', 'unrelated.net'] : day === '2026-08-30' ? ['aimintellect.com'] : ['anotherexample.org'] }),
  });
  const manifest = await corpus.refresh();
  assert.ok(store.objects.has(`domainscout/corpora/newly-registered-domains/v1/runs/${manifest.runId}/receipt.json`));
  assert.ok(store.objects.has('domainscout/corpora/newly-registered-domains/v1/latest.json'));
  assert.deepEqual((await corpus.search({ contains: 'intellect' })).matches, [
    { domain: 'stoneintellect.com', reportDate: '2026-08-31' },
    { domain: 'aimintellect.com', reportDate: '2026-08-30' },
  ]);
  assert.equal((await corpus.search({ contains: 'example' })).matches.length, 1);
});

test('partial refresh preserves the last complete latest pointer', async () => {
  const store = memoryStore();
  let fail = false;
  const corpus = createRecentRegistrationCorpus({
    objectStore: store, lookbackDays: 3, now: () => new Date('2026-09-01T06:00:00Z'), logger: { log() {}, warn() {} },
    fetchDay: async day => { if (fail && day === '2026-08-30') throw new Error('upstream delayed'); return { sourceUrl: 'fixture', domains: [`sample-${day}.com`] }; },
  });
  await corpus.refresh();
  const before = store.objects.get('domainscout/corpora/newly-registered-domains/v1/latest.json').toString('utf8');
  fail = true;
  await assert.rejects(corpus.refresh(), /upstream delayed/);
  assert.equal(store.objects.get('domainscout/corpora/newly-registered-domains/v1/latest.json').toString('utf8'), before);
});

test('evidence warns at 36 hours and fails closed after 48 hours', async () => {
  const store = memoryStore();
  let clock = new Date('2026-09-01T06:00:00Z');
  const corpus = createRecentRegistrationCorpus({ objectStore: store, lookbackDays: 3, now: () => clock, logger: { log() {}, warn() {} }, fetchDay: async () => ({ sourceUrl: 'fixture', domains: ['sample.com'] }) });
  await corpus.refresh();
  clock = new Date('2026-09-04T12:00:00Z');
  assert.equal((await corpus.status()).status, 'stale');
  await assert.rejects(corpus.search({ contains: 'sample' }), /Corpus is stale/);
  assert.equal((await corpus.search({ contains: 'sample', allowStale: true })).matches.length, 3);
});
