'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const modulePath = path.resolve(__dirname, '../server/live-listings.js');

function inspectPolicy(env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.DOMAINSCOUT_ENABLE_HEADED_LIVE_BIDS;
  Object.assign(childEnv, env);
  const result = spawnSync(process.execPath, ['-e', `
    const live = require(${JSON.stringify(modulePath)});
    process.stdout.write(JSON.stringify({ enabled: live.ENABLED, status: live.status() }));
  `], { env: childEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('headed provider automation is disabled by default', () => {
  const policy = inspectPolicy();
  assert.equal(policy.enabled, false);
  assert.equal(policy.status.available, false);
  assert.equal(policy.status.unavailable, 'headed-browser-disabled');
});

test('headed provider automation requires an explicit opt-in', () => {
  const policy = inspectPolicy({ DOMAINSCOUT_ENABLE_HEADED_LIVE_BIDS: '1' });
  assert.equal(policy.enabled, true);
  assert.notEqual(policy.status.unavailable, 'headed-browser-disabled');
});
