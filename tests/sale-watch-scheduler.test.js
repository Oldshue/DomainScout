'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { enabledByEnvironment, seedFromBaseline, DEFAULT_INTERVAL_MS } = require('../server/sale-watch-scheduler');

test('Sale Watch discovery defaults on for desktop and off for Railway', () => {
  assert.equal(enabledByEnvironment({}), true);
  assert.equal(enabledByEnvironment({ RAILWAY_ENVIRONMENT: 'production' }), false);
  assert.equal(enabledByEnvironment({ RAILWAY_ENVIRONMENT: 'production', DOMAINSCOUT_SALE_WATCH_DISCOVERY_ENABLED: '1' }), true);
  assert.equal(enabledByEnvironment({ DOMAINSCOUT_SALE_WATCH_DISCOVERY_ENABLED: '0' }), false);
  assert.equal(DEFAULT_INTERVAL_MS, 60 * 60_000);
});

test('desktop startup seeds an absent durable ledger without overwriting newer history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-sale-watch-seed-'));
  const baseline = path.join(root, 'baseline.json');
  const output = path.join(root, 'data', 'discovery.json');
  fs.writeFileSync(baseline, '{"generatedAt":"baseline"}\n');
  assert.equal(seedFromBaseline(output, baseline), true);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).generatedAt, 'baseline');
  fs.writeFileSync(output, '{"generatedAt":"newer"}\n');
  assert.equal(seedFromBaseline(output, baseline), false);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).generatedAt, 'newer');
});
