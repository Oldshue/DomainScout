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
  assert.equal(config.seenAnyMax, 0, 'age retention, not a fixed row count, governs the default evidence window');
});

test('seen-any retention refreshes repeated names with bounded writes and prunes by evidence age', () => {
  const store = ct.openLaunchStore(':memory:');
  try {
    const first = START;
    assert.equal(store.markSeenAny('repeated.example', first), true);
    assert.equal(store.markSeenAny('old.example', first), true);
    assert.equal(store.markSeenAny('repeated.example', first + DAY_MS / 2), false);
    assert.equal(store.db.prepare('SELECT at FROM seen_any WHERE h=?').pluck().get(ct.domainHash('repeated.example')), first,
      'duplicates inside one day do not rewrite the hot row');
    assert.equal(store.markSeenAny('repeated.example', first + 2 * DAY_MS), false);
    assert.equal(store.db.prepare('SELECT at FROM seen_any WHERE h=?').pluck().get(ct.domainHash('repeated.example')), first + 2 * DAY_MS,
      'a later observation renews exact membership in the evidence window');
    const trimmed = store.trimSeenAnyBefore(first + DAY_MS);
    assert.equal(trimmed.removed, 1);
    assert.equal(trimmed.throughAt, first);
    assert.equal(store.seenAnyCount(), 1);
    assert.equal(store.markSeenAny('repeated.example', first + 3 * DAY_MS), false, 'retained repeats never become launches');
    assert.equal(store.markSeenAny('old.example', first + 3 * DAY_MS), true, 'discarded history is truthfully treated as unavailable evidence');
  } finally { store.close(); }
});

test('offline time never advances retained first-seen coverage after a trim', async t => {
  const { dataDir, universeDir } = await tmp(t);
  const paths = ct.ctPaths(dataDir);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.state, JSON.stringify({
    firstStartedAt: new Date(START).toISOString(),
    tailedMs: 100 * DAY_MS,
    seenAnyTailedMs: 100 * DAY_MS,
    seenAnyTrimmedThrough: START,
    updatedAt: new Date(START + 10 * DAY_MS).toISOString(),
  }));
  const detector = ct.createCtLaunchDetector({
    dataDir, universeDir, clock: () => START + 100 * DAY_MS, log: quiet, siteFetchImpl: siteFetch,
    logList: { operators: [] }, config: { firstSeenHistoryDays: 90 },
  });
  assert.equal(detector.health().firstSeen.coveredDays, 10);
  assert.equal(detector.health().firstSeen.active, false);
  await detector.stop();
});

test('the evidence store reserves physical space and counts reusable SQLite pages', async t => {
  const { dataDir } = await tmp(t);
  const store = ct.openLaunchStore(path.join(dataDir, 'capacity.db'));
  try {
    const low = store.seenAnyCapacity(0, () => ({ bavail: 1, bsize: 4096, blocks: 10_000_000 }));
    assert.equal(low.ok, false);
    assert.equal(low.reserveBytes, 4 * 1024 ** 3);
    const configured = store.seenAnyCapacity(8192, () => ({ bavail: 3, bsize: 4096, blocks: 100 }));
    assert.equal(configured.ok, true);
  } finally { store.close(); }
});

test('a history write failure invalidates coverage and bounded maintenance resumes recording', async t => {
  const { dataDir, universeDir } = await tmp(t);
  const store = ct.openLaunchStore(path.join(dataDir, 'write-failure.db'));
  t.after(() => store.close());
  let now = START;
  const detector = ct.createCtLaunchDetector({
    dataDir, universeDir, store, clock: () => now, log: quiet, siteFetchImpl: siteFetch,
    logList: { operators: [] }, indexLoader: async () => ({ days: 0, files: 0, rows: 0, pruned: 0 }),
    config: { healthEveryMs: 3600000, indexRefreshMs: 3600000, logListRefreshMs: 3600000 },
  });
  await detector.start();
  const realMark = store.markSeenAny;
  store.markSeenAny = () => { const error = new Error('database or disk is full'); error.code = 'SQLITE_FULL'; throw error; };
  now += DAY_MS;
  assert.throws(() => detector.processDomains([{ domain: 'cannot-record.example', zone: 'example' }]), /disk is full/);
  let health = detector.health();
  assert.equal(health.firstSeen.recording, false);
  assert.equal(health.firstSeen.coveredDays, 0);
  store.markSeenAny = realMark;
  await detector.refreshIndex();
  assert.equal(detector.health().firstSeen.recording, true, 'the bounded maintenance pass resumes after capacity recovers');
  now += DAY_MS;
  detector.processDomains([{ domain: 'recording-again.example', zone: 'example' }]);
  health = detector.health();
  assert.equal(health.firstSeen.coveredDays, 1);
  assert.equal(store.markSeenAny('recording-again.example', now), false);
  await detector.stop();
});
