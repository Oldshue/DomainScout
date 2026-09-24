'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  extractEmbeddedData,
  hasSellerNameserver,
  hasParkingNameserver,
  publicSellerDepartures,
} = require('../server/sale-watch-discovery');
const { readSaleWatchLedger } = require('../server/sale-watch');
const { mergeDiscoveryHistory } = require('../scripts/update-sale-watch-sales');

test('extractEmbeddedData reads the final DNS Coffee page payload', () => {
  const html = '<script>var data = {"wrong":true};</script>\n<script>var data = {"name":"example.com","archive_domains":[{"name":"sold.com","last_seen":"2026-08-30T00:00:00Z"}]};</script>';
  assert.deepEqual(extractEmbeddedData(html), {
    name: 'example.com',
    archive_domains: [{ name: 'sold.com', last_seen: '2026-08-30T00:00:00Z' }],
  });
});

test('known seller nameserver matching does not confuse generic buyer DNS', () => {
  assert.equal(hasSellerNameserver(['ns1.afternic.com']), true);
  assert.equal(hasSellerNameserver(['lily.ns.cloudflare.com']), false);
  assert.equal(hasParkingNameserver(['launch1.spaceship.net']), true);
  assert.equal(hasParkingNameserver(['ns1.abovedomains.com']), true);
  assert.equal(hasParkingNameserver(['ns1.dns-expired.com']), true);
  assert.equal(hasParkingNameserver(['ns1-domain-expired.myhostadmin.net']), true);
  assert.equal(hasParkingNameserver(['ns2-suspended.zxcs.be']), true);
  assert.equal(hasParkingNameserver(['lily.ns.cloudflare.com']), false);
});

test('embedded JSON extraction tolerates braces inside strings', () => {
  const html = '<script>var data = {"title":"a {literal} brace","ok":true};</script>';
  assert.deepEqual(extractEmbeddedData(html), { title: 'a {literal} brace', ok: true });
});

test('public reverse-nameserver discovery deduplicates paired seller DNS', async () => {
  const fetchImpl = async url => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    url: String(url),
    text: async () => `<script>var data = {"archive_domain_count":99,"archive_domains":[{"name":"Sold.com","first_seen":"2024-01-01T00:00:00Z","last_seen":"2026-08-30T00:00:00Z"}]};</script>`,
  });
  const result = await publicSellerDepartures({
    after: '2026-08-25',
    fetchImpl,
    sellerNameservers: [
      { provider: 'Afternic', nameserver: 'ns1.afternic.com' },
      { provider: 'Afternic', nameserver: 'ns2.afternic.com' },
    ],
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].domain, 'sold.com');
  assert.deepEqual(result.candidates[0].sellerNameservers, ['ns1.afternic.com', 'ns2.afternic.com']);
});

test('native ledger merges dynamic probable and suspected leads without replacing reported evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-sale-watch-'));
  const seed = path.join(root, 'seed.json');
  const discovery = path.join(root, 'discovery.json');
  fs.writeFileSync(seed, JSON.stringify({ generatedAt: '2026-08-30T00:00:00Z', entries: [
    { domain: 'reported.com', tier: 'verified', sourceUrl: 'https://reports.example/sold', buyer: 'Reported', sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['one.ns.cloudflare.com'], rationale: 'reported' },
  ] }));
  fs.writeFileSync(discovery, JSON.stringify({ generatedAt: '2026-08-31T00:00:00Z', mode: 'public-reverse-nameserver', coverage: { uniqueDeparturesInspected: 100 }, entries: [
    { domain: 'probable.com', tier: 'probable', buyer: 'Probable', sellerNameservers: ['ns1.afternic.com'], buyerNameservers: ['two.ns.cloudflare.com'], rationale: 'probable' },
    { domain: 'suspected.com', tier: 'suspected', buyer: 'Suspected', sellerNameservers: ['ns1.sedoparking.com'], buyerNameservers: ['three.ns.cloudflare.com'], rationale: 'suspected' },
  ] }));
  const ledger = readSaleWatchLedger(seed, discovery);
  assert.deepEqual(ledger.counts, { verified: 1, probable: 0, suspected: 2, admitted: 3, auctionPricesShown: 0 });
  assert.equal(ledger.coverage.nameserverDeparturesInspected, 100);
  assert.equal(ledger.generatedAt, '2026-08-31T00:00:00Z');
});

test('scheduled discovery chronicles old leads and retires contradicted ones', () => {
  const previous = {
    generatedAt: '2026-08-30T00:00:00Z',
    entries: [
      { domain: 'persists.com', tier: 'suspected', observationCount: 2 },
      { domain: 'disproved.com', tier: 'suspected', observationCount: 1 },
      { domain: 'upgraded.com', tier: 'suspected', observationCount: 1 },
    ],
  };
  const latest = {
    generatedAt: '2026-08-31T00:00:00Z',
    coverage: { probable: 1, suspected: 0 },
    entries: [{ domain: 'upgraded.com', tier: 'probable', rationale: 'stronger evidence' }],
    ruledOut: [{ domain: 'disproved.com', tier: 'ruled-out', rationale: 'returned to parking' }],
  };
  const merged = mergeDiscoveryHistory(previous, latest);
  assert.deepEqual(merged.entries.map(row => row.domain).sort(), ['persists.com', 'upgraded.com']);
  assert.equal(merged.entries.find(row => row.domain === 'persists.com').observationStatus, 'retained-history');
  assert.equal(merged.entries.find(row => row.domain === 'upgraded.com').tier, 'probable');
  assert.equal(merged.entries.find(row => row.domain === 'upgraded.com').observationCount, 2);
  assert.equal(merged.retiredEntries[0].domain, 'disproved.com');
  assert.equal(merged.coverage.chronicledTotal, 2);
  assert.equal(merged.coverage.retiredAfterContradictoryEvidence, 1);
});

test('fetchText retries a network-level failure (no HTTP status) and succeeds within the attempt budget', async () => {
  const { fetchText } = require('../server/sale-watch-discovery');
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new Error('socket hang up');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://example.com/',
      headers: { get: () => null },
      text: async () => 'ok-body',
    };
  };
  const { text } = await fetchText('https://example.com/', { fetchImpl, attempts: 3, timeoutMs: 1000 });
  assert.equal(text, 'ok-body');
  assert.equal(calls, 3, 'the third attempt succeeded after two network-level failures were retried with backoff');
});

test('fetchText exhausts its attempt budget and rejects after repeated network-level failures, recording it as failed rather than retrying forever', async () => {
  const { fetchText } = require('../server/sale-watch-discovery');
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('socket hang up'); };
  await assert.rejects(
    () => fetchText('https://example.com/', { fetchImpl, attempts: 3, timeoutMs: 1000 }),
    /socket hang up/
  );
  assert.equal(calls, 3, 'exactly the configured attempt budget (3) was used before giving up');
});

test('fetchText retries an aborted request (simulating a slow-but-real origin) and succeeds within the attempt budget', async () => {
  const { fetchText } = require('../server/sale-watch-discovery');
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 2) {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: true, status: 200, statusText: 'OK', url: 'https://example.com/',
      headers: { get: () => null }, text: async () => 'recovered',
    };
  };
  const { text } = await fetchText('https://example.com/', { fetchImpl, attempts: 3, timeoutMs: 1000 });
  assert.equal(text, 'recovered');
  assert.equal(calls, 2, 'the aborted first attempt was retried and the second succeeded');
});

test('classifyFetchOutcome treats an HTTP status error (403) as an answer, never a network failure', () => {
  const { classifyFetchOutcome } = require('../server/sale-watch-discovery');
  const httpErr = new Error('403 Forbidden');
  httpErr.status = 403;
  assert.equal(classifyFetchOutcome(httpErr), 'answer');
  const networkErr = new Error('fetch failed');
  assert.equal(classifyFetchOutcome(networkErr), 'failure');
  const abortErr = new Error('This operation was aborted');
  abortErr.name = 'AbortError';
  assert.equal(classifyFetchOutcome(abortErr), 'failure');
});

test('inspectHomepage records a 403 response as answered (not a probe failure)', async () => {
  const { inspectHomepage } = require('../server/sale-watch-discovery');
  const fetchImpl = async () => ({
    ok: false, status: 403, statusText: 'Forbidden', url: 'https://blocked.example/',
    headers: { get: () => null }, text: async () => '',
  });
  const result = await inspectHomepage('blocked.example', fetchImpl, {});
  assert.equal(result.answered, true);
  assert.equal(result.answerStatus, 403);
  assert.equal(result.error, undefined, 'a genuine HTTP answer must never populate .error');
});

test('inspectHomepage still records a genuine network failure (no HTTP answer) with .error set', async () => {
  const { inspectHomepage } = require('../server/sale-watch-discovery');
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  const result = await inspectHomepage('unreachable.example', fetchImpl, { attempts: 1 });
  assert.equal(result.answered, undefined);
  assert.equal(result.error, 'fetch failed');
});

test('mapLimitByHost caps concurrency per key while letting different keys run in parallel', async () => {
  const { mapLimitByHost } = require('../server/sale-watch-discovery');
  let activeForA = 0;
  let maxActiveForA = 0;
  const values = ['a1', 'a2', 'a3', 'b1'];
  const keyOf = v => v[0];
  const results = await mapLimitByHost(values, { concurrency: 4, perKeyLimit: 1, keyOf }, async (v) => {
    if (v[0] === 'a') {
      activeForA += 1;
      maxActiveForA = Math.max(maxActiveForA, activeForA);
      await new Promise(resolve => setTimeout(resolve, 20));
      activeForA -= 1;
    }
    return v;
  });
  assert.equal(maxActiveForA, 1, 'perKeyLimit=1 must serialize same-key work even though overall concurrency allows more');
  assert.deepEqual(results.slice().sort(), values.slice().sort());
});

test('acquireRdapToken paces requests to the same origin via a token bucket', async () => {
  const { acquireRdapToken, __resetRdapPacingForTests } = require('../server/sale-watch-discovery');
  __resetRdapPacingForTests();
  const origin = 'https://rdap.example.test';
  const start = Date.now();
  await acquireRdapToken(origin, { capacity: 1, refillMs: 50 });
  await acquireRdapToken(origin, { capacity: 1, refillMs: 50 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 40, `expected the second acquisition to wait for a token refill, got ${elapsed}ms`);
});
