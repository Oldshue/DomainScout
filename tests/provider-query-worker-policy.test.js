'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { providerSnapshotQueryWorkerEnabled } = require('../server/provider-query-worker-policy');

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
