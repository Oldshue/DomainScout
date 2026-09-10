'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const { createUniversePuller } = require('../server/universe-puller');

function mkTmp(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function gz(text) {
  return zlib.gzipSync(Buffer.from(text, 'utf8'));
}

function gzLabels(labels) {
  return gz(labels.map(l => `${l}\n`).join(''));
}

function zoneUrl(tld) {
  return `https://czds-api.icann.org/czds/downloads/${tld}.zone`;
}

// Tiny fixture zone files. 'com' is an ANCHOR. Rule matches lines like
// 'label.tld.' (3 dot-parts, last empty) exactly like the real extractor.
const TODAY_ZONE_TEXT = {
  com: 'alpha.com.\t3600\tin\tns\ta.gtld-servers.net.\nns1.alpha.com.\t3600\tin\tns\tb.gtld-servers.net.\ngamma.com.\t3600\tin\tns\ta.gtld-servers.net.\n',
  net: 'delta.net.\t3600\tin\tns\ta.gtld-servers.net.\nepsilon.net.\t3600\tin\tns\ta.gtld-servers.net.\n',
  xyz: 'zulu.xyz.\t3600\tin\tns\ta.gtld-servers.net.\n',
};

function makeSummaryStub() {
  const calls = { build: [], import: [] };
  return {
    calls,
    buildUniverseSummaryTape: async opts => {
      calls.build.push(opts);
      await fsp.mkdir(opts.outDir, { recursive: true });
      const tapePath = path.join(opts.outDir, `universe-summary-${opts.day}.tsv.gz`);
      await fsp.writeFile(tapePath, gz('stub-tape\n'));
      return { tapePath, zones: 3, day: opts.day, namesTotal: 3, namesMulti: 3 };
    },
    importUniverseSummaryTape: async opts => {
      calls.import.push(opts);
      return { day: opts.day, zones: 3 };
    },
    openUniverseSummary: () => null,
  };
}

function makeFetch({ failTld } = {}) {
  const attemptsByTld = {};
  return async (url) => {
    if (url === 'https://account-api.icann.org/api/authenticate') {
      return { ok: true, status: 200, json: async () => ({ accessToken: 'test-token' }) };
    }
    if (url === 'https://czds-api.icann.org/czds/downloads/links') {
      return { ok: true, status: 200, json: async () => Object.keys(TODAY_ZONE_TEXT).map(zoneUrl) };
    }
    const tld = Object.keys(TODAY_ZONE_TEXT).find(t => url === zoneUrl(t));
    if (!tld) return { ok: false, status: 404 };
    attemptsByTld[tld] = (attemptsByTld[tld] || 0) + 1;
    if (failTld && tld === failTld) return { ok: false, status: 500 };
    return { ok: true, status: 200, body: Readable.from(gz(TODAY_ZONE_TEXT[tld])) };
  };
}

async function setupWorld({ anchors = 'com' } = {}) {
  const dataDir = await mkTmp('universe-puller-data-');
  const universeDir = await mkTmp('universe-puller-lane-');
  const prevDay = '2026-09-08';
  const namesRoot = path.join(dataDir, 'universe', 'names');
  await fsp.mkdir(path.join(namesRoot, prevDay), { recursive: true });
  await fsp.writeFile(path.join(namesRoot, prevDay, 'com.names.gz'), gzLabels(['alpha', 'beta']));
  await fsp.writeFile(path.join(namesRoot, prevDay, 'net.names.gz'), gzLabels(['delta']));
  // no xyz.names.gz for prevDay: exercises empty-baseline
  const oldDay = '2026-09-06';
  await fsp.mkdir(path.join(namesRoot, oldDay), { recursive: true });
  await fsp.writeFile(path.join(namesRoot, oldDay, 'com.names.gz'), gzLabels(['ancient']));
  const pullDir = path.join(dataDir, 'universe', 'pull');
  await fsp.mkdir(pullDir, { recursive: true });
  await fsp.writeFile(path.join(pullDir, `${prevDay}.json`), JSON.stringify({
    day: prevDay, startedAt: '2026-09-08T06:40:00.000Z', updatedAt: '2026-09-08T06:45:00.000Z',
    finishedAt: '2026-09-08T06:45:00.000Z', zonesListed: 2,
    ok: [{ tld: 'com', labels: 2, bytes: 12 }, { tld: 'net', labels: 1, bytes: 6 }],
    failed: [], anchorsMissing: [], complete: true,
  }));
  const summary = makeSummaryStub();
  return { dataDir, universeDir, prevDay, oldDay, namesRoot, summary,
    env: { CZDS_USER: 'u', CZDS_PASS: 'p', DOMAINSCOUT_UNIVERSE_ANCHOR_ZONES: anchors, DOMAINSCOUT_UNIVERSE_PULL_CONCURRENCY: '1' } };
}

test('runDay: all zones OK writes names, tape, pull record, health, and prunes old names', async () => {
  const world = await setupWorld();
  const today = '2026-09-09';
  const puller = createUniversePuller({
    dataDir: world.dataDir, universeDir: world.universeDir, env: world.env,
    fetchImpl: makeFetch(), log: { log() {}, error() {} }, summary: world.summary,
    now: () => new Date('2026-09-09T06:45:00Z'),
  });
  const result = await puller.runDay({ day: today });
  assert.equal(result.complete, true);
  assert.equal(result.failed, 0);

  for (const tld of ['com', 'net', 'xyz']) {
    assert.ok(fs.existsSync(path.join(world.namesRoot, today, `${tld}.names.gz`)), `${tld} names file exists`);
  }

  const tapeDir = path.join(world.universeDir, today, 'tape');
  const adds = await fsp.readFile(path.join(tapeDir, 'adds.tsv'), 'utf8');
  const drops = await fsp.readFile(path.join(tapeDir, 'drops.tsv'), 'utf8');
  assert.equal(adds, `gamma\tcom\t${world.prevDay}\nepsilon\tnet\t${world.prevDay}\nzulu\txyz\t${world.prevDay}\n`);
  assert.equal(drops, `beta\tcom\t${world.prevDay}\n`);

  const zones = JSON.parse(await fsp.readFile(path.join(tapeDir, 'zones.json'), 'utf8'));
  assert.deepEqual(zones, {
    com: { status: 'ok', window_start: world.prevDay, baseline_count: 2, today_count: 2, adds: 1, drops: 1 },
    net: { status: 'ok', window_start: world.prevDay, baseline_count: 1, today_count: 2, adds: 1, drops: 0 },
    xyz: { status: 'empty-baseline', window_start: world.prevDay, baseline_count: 0, today_count: 1, adds: 1, drops: 0 },
  });

  const record = JSON.parse(await fsp.readFile(path.join(world.dataDir, 'universe', 'pull', `${today}.json`), 'utf8'));
  assert.equal(record.complete, true);
  assert.equal(record.failed.length, 0);
  assert.equal(record.zonesListed, 3);

  const health = await puller.health();
  assert.equal(health.status, 'ok');
  assert.equal(health.lastCompleteDay, today);

  assert.equal(world.summary.calls.build.length, 1);
  assert.equal(world.summary.calls.import.length, 1);
  assert.equal(world.summary.calls.import[0].requireZones.includes('com'), true);

  assert.equal(fs.existsSync(path.join(world.namesRoot, world.oldDay)), false, 'names dir older than prevDay is pruned');
  assert.equal(fs.existsSync(path.join(world.namesRoot, world.prevDay)), true, 'prevDay names kept');
});

test('runDay: one zone failing all attempts leaves the day incomplete and skips tape/summary', async () => {
  const world = await setupWorld();
  const today = '2026-09-09';
  const puller = createUniversePuller({
    dataDir: world.dataDir, universeDir: world.universeDir, env: world.env,
    fetchImpl: makeFetch({ failTld: 'net' }), log: { log() {}, error() {} }, summary: world.summary,
    now: () => new Date('2026-09-09T06:45:00Z'),
  });
  const result = await puller.runDay({ day: today });
  assert.equal(result.complete, false);
  assert.equal(result.failed, 1);

  assert.equal(fs.existsSync(path.join(world.universeDir, today, 'tape')), false);

  const record = JSON.parse(await fsp.readFile(path.join(world.dataDir, 'universe', 'pull', `${today}.json`), 'utf8'));
  assert.equal(record.complete, false);
  assert.equal(record.failed.length, 1);
  assert.equal(record.failed[0].tld, 'net');
  assert.equal(record.failed[0].attempts, 3);

  const health = await puller.health();
  assert.equal(health.status, 'incomplete');
  assert.ok(health.alerts.some(a => a.includes('net') && a.includes('3 attempts')), 'alert names the failed zone');

  assert.equal(world.summary.calls.build.length, 0, 'summary tape never built for an incomplete day');
  assert.equal(world.summary.calls.import.length, 0, 'summary import never invoked for an incomplete day');
});

test('runDay: a zone missing from the CZDS listing is reported as anchorsMissing', async () => {
  const world = await setupWorld({ anchors: 'com,missingtld' });
  const today = '2026-09-09';
  const puller = createUniversePuller({
    dataDir: world.dataDir, universeDir: world.universeDir, env: world.env,
    fetchImpl: makeFetch(), log: { log() {}, error() {} }, summary: world.summary,
    now: () => new Date('2026-09-09T06:45:00Z'),
  });
  const result = await puller.runDay({ day: today });
  assert.equal(result.complete, true);
  const record = JSON.parse(await fsp.readFile(path.join(world.dataDir, 'universe', 'pull', `${today}.json`), 'utf8'));
  assert.deepEqual(record.anchorsMissing, ['missingtld']);
  const health = await puller.health();
  assert.ok(health.alerts.some(a => a.includes('missingtld')), 'alert names the missing anchor');
});

test('runDay: a lock prevents a second concurrent run', async () => {
  const world = await setupWorld();
  const puller = createUniversePuller({
    dataDir: world.dataDir, universeDir: world.universeDir, env: world.env,
    fetchImpl: makeFetch(), log: { log() {}, error() {} }, summary: world.summary,
    now: () => new Date('2026-09-09T06:45:00Z'),
  });
  const first = puller.runDay({ day: '2026-09-09' });
  const second = puller.runDay({ day: '2026-09-09' });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(secondResult, { skipped: 'running' });
  assert.equal(firstResult.complete, true);
});
