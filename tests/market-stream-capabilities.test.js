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
    assert.equal(contract.lifecycle.endTimestamp, 'terminal');
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
    lifecycle: { endTimestamp: 'historical' },
  });
  const sedo = getMarketStreamContract('sedo-fixed-price');
  assert.deepEqual(sedo.columns, ['domain', 'tld', 'auction_price', 'actions']);
  assert.equal(sedo.fields.bid_count.supported, false);
  assert.equal(sedo.fields.auction_price.source, 'signed-partner-feed');
  assert.equal(sedo.lifecycle.endTimestamp, 'historical');
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
  assert.match(server, /prewarmGoDaddyQueryWorker\(listLargeProviderStreams\(\)\)/);
  assert.match(server, /prewarmDefaultSiblingView\(stream\)/);
  assert.match(server, /const takenInEvidenceProjectionCache = new Map\(\)/);
  assert.match(server, /invalidateTakenInEvidenceProjectionCache\(\)/);
});

test('verified sibling projections are cached by provider snapshot and scan revision', () => {
  const worker = fs.readFileSync(path.join(__dirname, '../server/large-provider-worker.js'), 'utf8');
  assert.match(worker, /const siblingProjectionCache = new Map\(\)/);
  assert.match(worker, /index\.stream.*index\.generatedAt.*revision/);
  assert.match(worker, /compactRows: rows/);
  assert.match(worker, /takenInEvidence\?\.revision/);
});

test('snapshot-complete sibling scans use the provider-neutral snapshot registry', () => {
  const worker = fs.readFileSync(path.join(__dirname, '../server/market-sibling-scan-worker.js'), 'utf8');
  assert.match(worker, /readLargeProviderSnapshotIndex\(stream\)/);
  assert.match(worker, /readLargeProviderSnapshotMeta\(stream\)/);
  assert.doesNotMatch(worker, /readGoDaddyInventoryIndex/);
  assert.doesNotMatch(worker, /getGoDaddyInventoryCacheMeta/);
});

test('closeout entry uses its indexed transition order without applying auction expiry semantics', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(app, /stream === 'godaddy-closeout'[\s\S]{0,400}state\.sortField = 'auction_end';[\s\S]{0,120}state\.sortDir = 'DESC';/);
  assert.match(app, /rowIsCurrentListing\(domain, nowMs = Date\.now\(\), contract = this\._viewCapabilities\)/);
  assert.match(app, /contract\?\.lifecycle\?\.endTimestamp !== 'terminal'/);
  assert.doesNotMatch(app, /rowIsCurrentListing[\s\S]{0,500}\['godaddy-auction', 'namecheap-auction'\]/);
  assert.match(app, /domains\.filter\(\(domain\) => this\.rowIsCurrentListing\(domain, now\)\)/);
  assert.match(app, /if \(!this\.rowIsCurrentListing\(d\)\) return '';/);
  assert.doesNotMatch(app, /renderRow\(d\) \{\s*if \(state\.stream === 'godaddy-auction'\)/);
  assert.doesNotMatch(app, /state\.sortField === 'auction_end' && state\.sortDir === 'ASC'\)\s*\? domains\.filter/);
});

test('closeout deep links and transient reconnects cannot present counted blank inventory', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(app, /state\.stream === 'godaddy-closeout' && state\.sortField === 'auction_end' && state\.sortDir === 'ASC'/);
  assert.match(app, /descending\.textContent = 'Recently entered closeout'/);
  assert.match(app, /this\.updatePagination\(0, 1, state\.limit, false, 0\)/);
  assert.match(app, /Reconnecting to verified auction inventory/);
  assert.match(app, /Math\.min\(4000, 750 \* \(2 \*\* \(attempt - 1\)\)\)/);
});
