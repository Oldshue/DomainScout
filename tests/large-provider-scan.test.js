'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scanLargeProviderIndex } = require('../server/large-provider-scan');

const columns = [
  'domain', 'tld', 'stream', 'source', 'auction_price', 'auction_end', 'auction_url',
  'age_years', 'bid_count', 'length', 'has_numbers', 'has_hyphens', 'metrics',
];
const positions = Object.fromEntries(columns.map((column, index) => [column, index]));
const tuple = row => columns.map(column => row[column] ?? null);
const index = {
  stream: 'sedo-auction',
  generatedAt: '2026-08-13T08:00:00.000Z',
  count: 5,
  excludeEnded: true,
  compactColumns: columns,
  compactColumnIndex: positions,
  compactRows: [
    tuple({ domain: 'ended.shop', tld: '.shop', auction_end: '2026-08-13T07:59:00.000Z', auction_price: 1 }),
    tuple({ domain: 'alpha.shop', tld: '.shop', auction_end: '2026-08-13T09:00:00.000Z', auction_price: 2 }),
    tuple({ domain: 'bravo.dev', tld: '.dev', auction_end: '2026-08-13T10:00:00.000Z', auction_price: 3 }),
    tuple({ domain: 'charlie.com', tld: '.com', auction_end: '2026-08-13T11:00:00.000Z', auction_price: 4 }),
    tuple({ domain: 'delta.shop', tld: '.shop', auction_end: '2026-08-13T12:00:00.000Z', auction_price: 5 }),
  ],
};

test('unrelated provider scan walks each tuple once with a stable raw cursor', () => {
  const first = scanLargeProviderIndex(index, {
    offset: 0,
    limit: 2,
    fields: 'domain,tld,auction_price,auction_end',
    tlds: 'shop,dev',
    nowMs: Date.parse('2026-08-13T08:00:00.000Z'),
  });
  assert.deepEqual(first.columns, ['domain', 'tld', 'auction_price', 'auction_end']);
  assert.deepEqual(first.rows.map(row => row[0]), ['alpha.shop', 'bravo.dev']);
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 3);
  assert.equal(first.scanned, 3);
  assert.equal(first.done, false);

  const second = scanLargeProviderIndex(index, {
    offset: first.nextOffset,
    limit: 2,
    fields: 'domain,tld,auction_price,auction_end',
    tlds: 'shop,dev',
    nowMs: Date.parse('2026-08-13T08:00:00.000Z'),
  });
  assert.deepEqual(second.rows.map(row => row[0]), ['delta.shop']);
  assert.equal(second.nextOffset, index.count);
  assert.equal(second.scanned, 2);
  assert.equal(second.done, true);
});

test('scan boundaries reject oversized pages, unknown fields, and invalid TLDs', () => {
  const base = { nowMs: Date.parse('2026-08-13T08:00:00.000Z') };
  assert.throws(() => scanLargeProviderIndex(index, { ...base, limit: 10_001 }), /limit must be an integer/);
  assert.throws(() => scanLargeProviderIndex(index, { ...base, fields: 'domain,secret' }), /unsupported provider snapshot field/);
  assert.throws(() => scanLargeProviderIndex(index, { ...base, tlds: '../shop' }), /invalid TLD filter/);
  assert.throws(() => scanLargeProviderIndex(index, { ...base, offset: 6 }), /offset must be an integer/);
});

test('HTTP scan contract is off-main, generation-bound, and independent of the disabled agent API', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const routeStart = source.indexOf("app.get('/api/provider-snapshots/scan'");
  const routeEnd = source.indexOf("app.get('/api/domains'", routeStart);
  assert.ok(routeStart > 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /largeProviderWorkerQuery/);
  assert.match(route, /snapshotSha256/);
  assert.match(route, /provider-snapshot-changed/);
  assert.doesNotMatch(route, /requireAgentForgeApiEnabled/);
  assert.doesNotMatch(route, /godaddy-auction|namecheap-auction/);
});
