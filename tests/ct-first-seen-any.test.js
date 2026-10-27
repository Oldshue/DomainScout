'use strict';

// All-zone CT first-seen rule: off until the first-seen store holds 90 days of
// tailing history (simulated clock, persisted across restarts), then a first
// certificate on any zone is a launch tagged ct-first-seen; health counts down.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ct = require('../server/ct-launches');

const DAY_MS = 86400000;
const START = Date.parse('2026-07-01T00:00:00Z');
const quiet = { log() {}, warn() {}, error() {} };
const siteFetch = async url => new Response(`<html><head><title>${new URL(url).hostname.split('.')[0]} Studio Works</title></head><body>${'Handmade furniture built to order in our workshop. '.repeat(10)}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });

async function tmp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-ct-any-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const universeDir = path.join(root, 'universe');
  await fs.mkdir(universeDir, { recursive: true });
  return { dataDir: root, universeDir };
}

test('ct-first-seen on any zone stays off for 90 days of history, then launches first sightings only', async t => {
  const { dataDir, universeDir } = await tmp(t);
  let now = START;
  const make = () => ct.createCtLaunchDetector({
    dataDir, universeDir, env: {}, clock: () => now, log: quiet, siteFetchImpl: siteFetch, logList: { operators: [] },
    config: { recheckMs: 0, healthEveryMs: 3600000, indexRefreshMs: 3600000, logListRefreshMs: 3600000 },
  });
  const a = make();
  await a.start();
  assert.equal(a.health().firstSeen.daysRemaining, 90);
  assert.equal(a.health().firstSeen.active, false);
  assert.deepEqual(a.processDomains([{ domain: 'renewing-shop.com', zone: 'com' }]), [], 'off before history exists');
  now += 60 * DAY_MS;
  assert.deepEqual(a.processDomains([{ domain: 'midway.net', zone: 'net' }]), []);
  const mid = a.health().firstSeen;
  assert.equal(mid.daysRemaining, 30);
  assert.equal(mid.active, false);
  await a.stop();

  // Downtime does not count as tailing history.
  now += 20 * DAY_MS;
  const b = make();
  await b.start();
  assert.equal(b.health().firstSeen.daysRemaining, 30, 'history persisted in state.json; downtime excluded');
  now += 29 * DAY_MS;
  assert.deepEqual(b.processDomains([{ domain: 'almost.org', zone: 'org' }]), []);
  assert.equal(b.health().firstSeen.daysRemaining, 1);
  now += DAY_MS;
  assert.equal(b.health().firstSeen.active, true);
  assert.equal(b.health().firstSeen.daysRemaining, 0);
  // Domains sighted during the history window are renewals, never launches.
  assert.deepEqual(b.processDomains([{ domain: 'renewing-shop.com', zone: 'com' }, { domain: 'midway.net', zone: 'net' }, { domain: 'almost.org', zone: 'org' }]), []);
  const launches = b.processDomains([{ domain: 'brand-new-studio.com', zone: 'com' }, { domain: 'fresh.co.uk', zone: 'co.uk' }]);
  assert.deepEqual(launches.map(j => [j.domain, j.rule, j.source]), [['brand-new-studio.com', 'first-seen-any', 'ct-first-seen'], ['fresh.co.uk', 'first-seen-any', 'ct-first-seen']]);
  assert.deepEqual(b.processDomains([{ domain: 'brand-new-studio.com', zone: 'com' }]), [], 'emitted once');
  await b.observer.idle();
  assert.equal(b.health().counters.sources['ct-first-seen'], 2);
  await b.writeHealth();
  const read = await ct.readCtHealth({ dataDir, env: { DOMAINSCOUT_UNIVERSE_PULL_ENABLED: '1' }, now: () => now });
  assert.equal(read.firstSeen.active, true);
  await b.stop();
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = fss.readFileSync(path.join(universeDir, day, 'sites', ct.JOURNAL_FILE), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => [r.domain, r.launchSource]).sort(), [['brand-new-studio.com', 'ct-first-seen'], ['fresh.co.uk', 'ct-first-seen']]);
});

test('recent-registration launches keep their rule and are tagged ct-recent-registration; zone-diff rows are tagged by the stage', async t => {
  const { universeDir } = await tmp(t);
  const dir = path.join(universeDir, '2026-10-25', 'tape');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'adds.tsv'), 'justadded\tcom\t2026-10-24\n');
  const store = ct.openLaunchStore(':memory:');
  t.after(() => store.close());
  const nowMs = Date.parse('2026-10-27T10:00:00Z');
  await ct.refreshRecentIndex({ store, universeDir, windowDays: 14, now: nowMs });
  const config = ct.resolveCtConfig({});
  const v = ct.evaluateLaunch({ domain: 'justadded.com', zone: 'com' }, { store, config, nowMs, warmedUp: true, firstSeenReady: false });
  assert.equal(v.source, 'ct-recent-registration');
  assert.equal(ct.evaluateLaunch({ domain: 'unknown.com', zone: 'com' }, { store, config, nowMs, warmedUp: true, firstSeenReady: false }).launch, false, 'old .com renewal still not a launch before 90 days');
  assert.equal(ct.launchSourceOf('went-live'), 'ct-recent-registration');
  assert.equal(ct.LAUNCH_SOURCES.zoneDiff, 'zone-diff');
  assert.equal(config.firstSeenHistoryDays, 90);
});
