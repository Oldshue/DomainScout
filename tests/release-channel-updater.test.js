'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UPDATER = path.join(ROOT, 'scripts', 'update-from-release-channel.sh');
const INSTALLER = path.join(ROOT, 'scripts', 'install-macos-app.sh');
const SERVER = path.join(ROOT, 'server', 'index.js');

test('production updater passes bash syntax and check-only validation', () => {
  assert.equal(spawnSync('bash', ['-n', UPDATER]).status, 0);
  const result = spawnSync('bash', [UPDATER, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Check-only mode: validation complete, no mutation performed/);
});

test('production updater rejects an insecure desired-state channel before mutation', () => {
  const result = spawnSync('bash', [UPDATER, '--check'], {
    encoding: 'utf8',
    env: { ...process.env, DOMAINSCOUT_RELEASE_CHANNEL_URL: 'http://example.test/release' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use HTTPS/);
});

test('updater binds an immutable production commit, branch ancestry, tests, rollback release, and receipt', () => {
  const source = fs.readFileSync(UPDATER, 'utf8');
  assert.match(source, /\^\[a-f0-9\]\{40\}\$/);
  assert.match(source, /merge-base --is-ancestor/);
  assert.match(source, /npm ci --silent && npm test --silent/);
  assert.match(source, /release-local-macos\.sh/);
  assert.match(source, /--prevalidated-commit=\$DESIRED_COMMIT/);
  assert.match(source, /DOMAINSCOUT_UPDATER_ACTIVE=1/);
  assert.match(source, /domainscout\.device-release-receipt\/v1/);
  assert.match(source, /receipt_matches/);
  assert.match(source, /write_receipt current/);
  assert.match(source, /write_receipt updated/);
  assert.match(source, /Another update check is already active/);
});

test('installer persists and starts the same generic device updater contract', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(source, /com\.hamp\.domainscout\.updater/);
  assert.match(source, /update-from-release-channel\.sh/);
  assert.match(source, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(source, /DOMAINSCOUT_RELEASE_CHANNEL_URL/);
  assert.match(source, /launchctl kickstart -k "gui\/\$\{UID\}\/\$\{UPDATER_LABEL\}"/);
  assert.match(source, /DOMAINSCOUT_UPDATER_ACTIVE/);
  assert.match(source, /launchctl print "gui\/\$\{UID\}"/);
  assert.match(source, /# domainscout-production-updater/);
  assert.match(source, /# domainscout-headless-services/);
  assert.match(source, /headless-supervisor\.sh/);
  assert.match(source, /run-production-update\.sh/);
  assert.match(source, /replace_headless_cron install/);
});

test('headless supervision is exact, idempotent, and removed when Aqua launchd is available', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(source, /pid_matches\(\)/);
  assert.match(source, /ps -p "\$pid" -o command=/);
  assert.match(source, /\*"\$script_path"\*/);
  assert.match(source, /replace_headless_cron remove/);
  assert.match(source, /"\$HEADLESS_SUPERVISOR" stop/);
  assert.match(source, /"\$HEADLESS_SUPERVISOR" restart/);
  assert.match(source, /DOMAINSCOUT_UPDATER_ACTIVE/);
});

test('release channel is public metadata and precedes the authentication boundary', () => {
  const source = fs.readFileSync(SERVER, 'utf8');
  const route = source.indexOf("app.get('/api/release-channel'");
  const auth = source.indexOf('app.use(requireAuth)', route);
  assert.ok(route >= 0 && auth > route);
  assert.match(source.slice(route, auth), /RAILWAY_GIT_COMMIT_SHA/);
  assert.match(source.slice(route, auth), /domainscout\.release-channel\/v1/);
  assert.match(source.slice(route, auth), /Cache-Control', 'no-store'/);
});

test('unrelated local service behavior remains isolated from updater desired state', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(source, /com\.hamp\.domainscout\.tldworker/);
  assert.match(source, /DOMAINSCOUT_GODADDY_WORKER/);
  assert.match(source, /consolidate-macos-app-launchers\.sh/);
});
