'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

test('exact marketplace quotes precede static discovery rows', () => {
  const start = server.indexOf('async function resolveLanderUncached');
  const end = server.indexOf('\nasync function resolveLander(', start);
  const resolver = server.slice(start, end);
  assert.ok(resolver.indexOf('await quoteListing') < resolver.indexOf("source: 'db-listing-fallback'"));
  assert.doesNotMatch(resolver, /source: 'db',\s*price: dbRow\.auction_price/);
  assert.match(resolver, /source: 'db-listing-fallback'/);
  assert.match(resolver, /price: null/);
});

test('price rendering preserves provider currency and progressively updates small batches', () => {
  assert.match(app, /_formatMarketplacePrice\(data\.price, data\.currency\)/);
  assert.match(app, /const CHUNK = 20/);
  assert.match(app, /Array\.from\(\{ length: 10 \}/);
  assert.match(app, /this\._landerCheckGen\+\+/);
  assert.match(app, /const gen = this\._landerCheckGen/);
});

test('name-research rank key: legacy row counts never outrank zone truth', () => {
  assert.match(server, /resultMap\[n\.base_name\]\.tlds_taken == null\) \{/);
  assert.doesNotMatch(
    server,
    /n\.tlds_taken > resultMap\[n\.base_name\]\.tlds_taken/
  );
});
