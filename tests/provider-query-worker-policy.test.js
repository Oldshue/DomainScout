'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { providerSnapshotQueryWorkerEnabled, resolveProviderSnapshotSort } = require('../server/provider-query-worker-policy');

const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

test('provider snapshot query workers default on when deployment flags are absent', () => {
  assert.equal(providerSnapshotQueryWorkerEnabled({}), true);
});

test('provider-neutral configuration controls unrelated large inventory adapters', () => {
  assert.equal(providerSnapshotQueryWorkerEnabled({ DOMAINSCOUT_PROVIDER_SNAPSHOT_QUERY_WORKER: '1' }), true);
  assert.equal(providerSnapshotQueryWorkerEnabled({ DOMAINSCOUT_PROVIDER_SNAPSHOT_QUERY_WORKER: 'off' }), false);
  assert.equal(providerSnapshotQueryWorkerEnabled({
    DOMAINSCOUT_PROVIDER_SNAPSHOT_QUERY_WORKER: '1',
    DOMAINSCOUT_GODADDY_WORKER: '0',
    fixtureProvider: 'security-feed',
  }), true);
});

test('legacy explicit opt-out remains supported without becoming the default', () => {
  assert.equal(providerSnapshotQueryWorkerEnabled({ DOMAINSCOUT_GODADDY_WORKER: '0' }), false);
  assert.equal(providerSnapshotQueryWorkerEnabled({ DOMAINSCOUT_GODADDY_WORKER: 'false' }), false);
});

test('a disabled worker fails selected-TLD snapshot requests closed before SQLite planning', () => {
  const routeStart = server.indexOf("app.get('/api/domains'");
  const sqlPlanning = server.indexOf('const conditions = []', routeStart);
  const route = server.slice(routeStart, sqlPlanning);
  assert.match(route, /provider-snapshot-query-worker-disabled/);
  assert.match(route, /isPositiveSelectedTldRequest\(req\.query, selectedTldTargets\)/);
  assert.ok(route.indexOf('provider-snapshot-query-worker-disabled') < route.indexOf('serveGoDaddyViaWorker'));
});

test('resolveProviderSnapshotSort passes through a supported field with normalized direction', () => {
  assert.deepEqual(
    resolveProviderSnapshotSort('auction_price', 'desc', new Set(['auction_price'])),
    { sortBy: 'auction_price', sortDir: 'DESC', coerced: false, requested: 'auction_price' },
  );
});

test('resolveProviderSnapshotSort coerces unsupported sort fields to the worker default', () => {
  const supported = new Set(['auction_end', 'expiring_at']);

  const unsupported = resolveProviderSnapshotSort('discovered_at', 'ASC', supported);
  assert.equal(unsupported.sortBy, 'auction_end');
  assert.equal(unsupported.sortDir, 'ASC');
  assert.equal(unsupported.coerced, true);
  assert.equal(unsupported.requested, 'discovered_at');
  assert.equal(unsupported.reason, 'provider-snapshot-sort-unsupported');

  const empty = resolveProviderSnapshotSort('', 'DESC', supported);
  assert.equal(empty.sortBy, 'auction_end');
  assert.equal(empty.sortDir, 'ASC');
  assert.equal(empty.coerced, true);
  assert.equal(empty.requested, '');
  assert.equal(empty.reason, 'provider-snapshot-sort-unsupported');
});

test('provider-snapshot streams never fall through to SQLite on an unsupported sort', () => {
  const routeStart = server.indexOf('const earlySortBy');
  const sqlPlanning = server.indexOf('const conditions = []', routeStart);
  const route = server.slice(routeStart, sqlPlanning);
  assert.match(route, /resolveProviderSnapshotSort\(earlySortBy, req\.query\.sortDir, GODADDY_CACHE_DOMAIN_SORT_FIELDS\)/);
  assert.match(route, /canUseGoDaddyCacheForDomainRequest\(req, streamForCache, effectiveSortBy\)/);
  assert.match(route, /sortApplied: providerSort,/);
  assert.match(server, /sortApplied: opts\.sortApplied \|\| null,/);
});
