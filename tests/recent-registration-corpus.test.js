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
    { domain: 'stoneintellect.com', reportDate: '2026-08-31', feedDate: '2026-08-31', registrationDate: null, registrationDateVerified: false },
    { domain: 'aimintellect.com', reportDate: '2026-08-30', feedDate: '2026-08-30', registrationDate: null, registrationDateVerified: false },
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


test('a new feed day refreshes even while the prior feed is under the freshness warning', async () => {
  let clock = new Date('2026-09-07T04:10:00Z');
  const corpus = createRecentRegistrationCorpus({ objectStore: memoryStore(), lookbackDays: 3, now: () => clock, logger: { log() {}, warn() {} }, fetchDay: async day => ({ sourceUrl: 'fixture', domains: [`orchard-${day}.com`] }) });
  await corpus.refresh();
  assert.equal((await corpus.refreshIfDue()).refreshed, false);
  clock = new Date('2026-09-08T04:10:00Z');
  const before = await corpus.status();
  assert.equal(before.status, 'current');
  assert.equal(before.refreshDue, true);
  const result = await corpus.refreshIfDue();
  assert.equal(result.refreshed, true);
  assert.equal(result.freshness.latestFeedDate, '2026-09-07');
  assert.equal(result.freshness.refreshDue, false);
});

test('legacy manifests expose source dates without inventing registry creation dates', async () => {
  const store = memoryStore();
  const opts = { objectStore: store, lookbackDays: 3, now: () => new Date('2026-09-08T04:10:00Z'), logger: { log() {}, warn() {} }, fetchDay: async () => ({ sourceUrl: 'fixture', domains: ['orchard.com'] }) };
  await createRecentRegistrationCorpus(opts).refresh();
  const key = 'domainscout/corpora/newly-registered-domains/v1/latest.json';
  const manifest = JSON.parse(store.objects.get(key));
  delete manifest.dateBasis; delete manifest.registrationDateVerified; delete manifest.dateNotice;
  for (const day of manifest.days) { delete day.feedDate; delete day.dateBasis; delete day.registrationDateVerified; delete day.dateNotice; }
  await store.put(key, JSON.stringify(manifest));
  const corpus = createRecentRegistrationCorpus(opts);
  const result = await corpus.search({ contains: 'orchard' });
  assert.equal(result.dateBasis, 'source_feed_date');
  assert.equal(result.registrationDateVerified, false);
  assert.equal(result.freshness.dateBasis, 'source_feed_date');
  assert.equal(result.matches[0].registrationDate, null);
  assert.equal(result.matches[0].feedDate, '2026-09-07');
});

test('a replaced immutable snapshot cannot reuse cached rows from the same feed date', async () => {
  const store = memoryStore();
  const opts = { objectStore: store, lookbackDays: 3, now: () => new Date('2026-09-08T04:10:00Z'), logger: { log() {}, warn() {} }, fetchDay: async () => ({ sourceUrl: 'fixture', domains: ['orchard.com'] }) };
  const corpus = createRecentRegistrationCorpus(opts);
  const manifest = await corpus.refresh();
  assert.equal((await corpus.search({ contains: 'orchard' })).matches.length, 3);
  // Simulate a manifest generation switching its object identity, including
  // a corrupted object, while an earlier generation's rows are cached.
  manifest.days[0] = { ...manifest.days[0], key: 'replacement.gz', digest: 'sha256:invalid' };
  await store.put('replacement.gz', require('node:zlib').gzipSync('neworchard.com\n'));
  await assert.rejects(corpus.search({ contains: 'orchard' }), /Digest mismatch/);
});
