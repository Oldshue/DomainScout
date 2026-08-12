'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getMarketStreamContract, registerMarketStreamContract } = require('../server/market-stream-capabilities');

test('auction providers expose only capability-backed columns and field provenance', () => {
  const goDaddy = getMarketStreamContract('godaddy-auction');
  const namecheap = getMarketStreamContract('namecheap-auction');
  for (const contract of [goDaddy, namecheap]) {
    assert.equal(contract.columns.includes('wayback_snapshots'), false);
    assert.equal(contract.columns.includes('expiry_date'), false);
    assert.equal(contract.columns.includes('discovered_at'), false);
    assert.equal(contract.fields.bid_count.supported, true);
    assert.equal(contract.fields.auction_price.supported, true);
    assert.ok(contract.fields.auction_price.source);
  }
  assert.equal(goDaddy.fields.bid_count.liveRefresh, true);
  assert.equal(namecheap.fields.bid_count.liveRefresh, false);
});

test('unrelated provider uses the same catalog contract without core branching', () => {
  registerMarketStreamContract({
    stream: 'sedo-fixed-price',
    columns: ['domain', 'tld', 'auction_price', 'actions'],
    fields: {
      bid_count: { supported: false },
      auction_price: { supported: true, source: 'signed-partner-feed', maxAgeMs: 600000 },
    },
  });
  const sedo = getMarketStreamContract('sedo-fixed-price');
  assert.deepEqual(sedo.columns, ['domain', 'tld', 'auction_price', 'actions']);
  assert.equal(sedo.fields.bid_count.supported, false);
  assert.equal(sedo.fields.auction_price.source, 'signed-partner-feed');
});

test('desktop preserves sibling criteria across providers and consumes server capabilities', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(app, /Sibling criteria are universal market filters/);
  assert.match(app, /clearStreamScopedFilters\(previousStream, nextStream\) \{\s*return false;/);
  assert.match(app, /data\.viewCapabilities \|\| null/);
  assert.match(app, /applyViewCapabilities/);
  assert.doesNotMatch(app, /Current live auction price unavailable">live —/);
});

test('all registered compact providers use the worker and receive a presentation contract', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  assert.match(server, /const streams = listLargeProviderStreams\(\)/);
  assert.match(server, /DOMAINSCOUT_PROVIDER_WORKER !== '0'/);
  assert.match(server, /viewCapabilities: getMarketStreamContract\(stream\)/);
  assert.match(server, /requireCompleteMarketSiblingCoverage\(req\.query, stream, meta\)/);
});
