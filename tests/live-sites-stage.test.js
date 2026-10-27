'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLiveSitesStage } = require('../server/live-sites-stage');
const { CLASSIFIER_VERSION } = require('../server/live-sites');

const quiet = { log() {}, warn() {}, error() {} };

async function tapeDir(t, days, { completeDays = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const universeDir = path.join(root, 'universe');
  for (const day of days) {
    const ns = path.join(universeDir, day, 'ns');
    await fs.mkdir(ns, { recursive: true });
    await fs.writeFile(path.join(ns, 'movement.jsonl'), JSON.stringify({ domain: 'a.com', selection: 'went-live' }) + '\n');
    await fs.writeFile(path.join(ns, 'summary.json'), '{}');
  }
  for (const day of completeDays) {
    const sites = path.join(universeDir, day, 'sites');
    await fs.mkdir(sites, { recursive: true });
    await fs.writeFile(path.join(sites, 'summary.json'), JSON.stringify({ status: 'complete', version: CLASSIFIER_VERSION, day, total: 1, observed: 1 }));
  }
  return { universeDir, dataDir: root };
}

test('trigger returns synchronously and never waits on a slow or hung runner', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-20']);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async job => { calls.push(job.day); await gate; return { ok: true }; } });
  const started = Date.now();
  const result = stage.trigger({ day: '2026-10-20' });
  assert.equal(result.queued, true);
  assert.ok(Date.now() - started < 50, 'trigger does not await the run');
  assert.equal(result instanceof Promise, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stage.isRunning(), true);
  assert.equal(stage.trigger({ day: '2026-10-20' }).reason, 'running', 'a running day is not re-queued');
  const health = await stage.health();
  assert.equal(health.status, 'running');
  assert.equal(health.running.day, '2026-10-20');
  release();
  await stage.idle();
  assert.deepEqual(calls, ['2026-10-20']);
});

test('a failing or throwing runner never throws into the caller and is visible in health', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-20', '2026-10-21']);
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async ({ day }) => {
    if (day === '2026-10-21') throw new Error('boom: disk full');
    return { ok: false, error: 'worker exited 1' };
  } });
  assert.doesNotThrow(() => stage.trigger({ day: '2026-10-21' }));
  assert.doesNotThrow(() => stage.trigger({ day: '2026-10-20' }));
  await stage.idle();
  const health = await stage.health();
  assert.equal(health.status, 'failed');
  assert.ok(health.alerts.some(alert => alert.includes('2026-10-21') && alert.includes('boom: disk full')), JSON.stringify(health.alerts));
  assert.ok(health.alerts.some(alert => alert.includes('2026-10-20') && alert.includes('worker exited 1')));
  assert.equal(health.lastRun.ok, false);
  const stored = JSON.parse(await fs.readFile(stage.healthPath, 'utf8'));
  assert.ok(stored.failures['2026-10-21']);
});

test('a later success clears the failure alert for that day', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-20']);
  let fail = true;
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async ({ day }) => {
    if (fail) return { ok: false, error: 'transient' };
    const sites = path.join(universeDir, day, 'sites');
    await fs.mkdir(sites, { recursive: true });
    await fs.writeFile(path.join(sites, 'summary.json'), JSON.stringify({ status: 'complete', version: CLASSIFIER_VERSION, day }));
    return { ok: true };
  } });
  stage.trigger({ day: '2026-10-20' });
  await stage.idle();
  assert.equal((await stage.health()).status, 'failed');
  fail = false;
  stage.trigger({ day: '2026-10-20' });
  await stage.idle();
  const health = await stage.health();
  assert.equal(health.status, 'ok');
  assert.deepEqual(health.alerts, []);
  assert.equal(health.lastSuccess.day, '2026-10-20');
});

test('health alerts when the latest tape day has no complete observation', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-20', '2026-10-21'], { completeDays: ['2026-10-20'] });
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async () => ({ ok: true }) });
  const health = await stage.health();
  assert.equal(health.status, 'failed');
  assert.ok(health.alerts.some(alert => alert.includes('2026-10-21')));
});

test('backfill queues only recent tape days lacking a complete observation, newest first', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'], { completeDays: ['2026-10-20'] });
  const order = [];
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async ({ day }) => { order.push(day); return { ok: true }; } });
  const result = await stage.backfill({ days: 3 });
  assert.deepEqual(result.considered, ['2026-10-21', '2026-10-20', '2026-10-19']);
  assert.deepEqual(result.queued, ['2026-10-21', '2026-10-19']);
  await stage.idle();
  assert.deepEqual(order, ['2026-10-21', '2026-10-19']);
});

test('disabled stage and invalid days are no-ops', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-20']);
  const disabled = createLiveSitesStage({ universeDir, dataDir, env: { DOMAINSCOUT_LIVE_SITES_ENABLED: '0' }, log: quiet, runDay: async () => assert.fail('must not run') });
  assert.equal(disabled.trigger({ day: '2026-10-20' }).queued, false);
  assert.equal((await disabled.health()).status, 'disabled');
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async () => assert.fail('must not run') });
  assert.equal(stage.trigger({ day: '../etc' }).queued, false);
  assert.equal(stage.trigger({}).queued, false);
});

test('the spawned worker runner reports a crashing child as a failure, not silence', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-20']);
  const { EventEmitter } = require('node:events');
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('exit', 1, null));
    return child;
  };
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, spawnImpl });
  stage.trigger({ day: '2026-10-20' });
  await stage.idle();
  const health = await stage.health();
  assert.ok(health.alerts.some(alert => alert.includes('worker exited 1')), JSON.stringify(health.alerts));
});

test('backfill re-observes a complete day with error share > 90% exactly once, newest first', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-17', '2026-10-18', '2026-10-21', '2026-10-26']);
  const put = async (day, summary) => {
    const sites = path.join(universeDir, day, 'sites');
    await fs.mkdir(sites, { recursive: true });
    await fs.writeFile(path.join(sites, 'summary.json'), JSON.stringify({ status: 'complete', version: CLASSIFIER_VERSION, day, ...summary }));
  };
  await put('2026-10-26', { total: 100, observed: 100, counts: { error: 30 } });
  await put('2026-10-21', { total: 100, observed: 100, counts: { error: 95 } });
  await put('2026-10-18', { total: 100, observed: 100, counts: { error: 91 } });
  await put('2026-10-17', { total: 100, observed: 100, counts: { error: 90 } });
  const jobs = [];
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async job => { jobs.push(job); return { ok: true }; } });
  const first = await stage.backfill({ days: 7 });
  assert.deepEqual(first.reobserve, ['2026-10-21', '2026-10-18']);
  await stage.idle();
  assert.deepEqual(jobs.map(j => [j.day, j.retryErrors, j.force]), [['2026-10-21', true, false], ['2026-10-18', true, false]]);
  const stored = JSON.parse(await fs.readFile(stage.healthPath, 'utf8'));
  assert.equal(stored.reobservations['2026-10-21'].errorShare, 0.95);
  // The runner did not rewrite the summary (still >90%), yet the retry never loops.
  const second = await stage.backfill({ days: 7 });
  assert.deepEqual(second.queued, []);
  await stage.idle();
  assert.equal(jobs.length, 2);
  const health = await stage.health();
  const d21 = health.days.find(d => d.day === '2026-10-21');
  assert.equal(d21.errorShare, 0.95);
  assert.ok(d21.reobservation);
  // A summary already marked as re-observed is never retried, even with a fresh health file.
  await put('2026-10-26', { total: 100, observed: 100, counts: { error: 80 }, reobservation: { at: 'x' } });
  await fs.rm(stage.healthPath, { force: true });
  const fresh = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async () => ({ ok: true }) });
  assert.ok(!(await fresh.backfill({ days: 1 })).queued.includes('2026-10-26'));
});

test('backfill observes every first-pass day before any retry, newest first within each kind', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-17', '2026-10-18', '2026-10-21', '2026-10-26']);
  const put = async (day, summary) => {
    const sites = path.join(universeDir, day, 'sites');
    await fs.mkdir(sites, { recursive: true });
    await fs.writeFile(path.join(sites, 'summary.json'), JSON.stringify({ status: 'complete', version: CLASSIFIER_VERSION, day, ...summary }));
  };
  await put('2026-10-26', { total: 100, observed: 100, counts: { error: 95 } });
  await put('2026-10-21', { total: 100, observed: 100, counts: { error: 92 } });
  await fs.mkdir(path.join(universeDir, '2026-10-17', 'sites'), { recursive: true });
  await fs.writeFile(path.join(universeDir, '2026-10-17', 'sites', 'summary.json'), JSON.stringify({ status: 'running', day: '2026-10-17', total: 70039, observed: 10309 }));
  const order = [];
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async job => { order.push([job.day, !!job.retryErrors]); return { ok: true }; } });
  const result = await stage.backfill({ days: 7 });
  await stage.idle();
  assert.deepEqual(order, [['2026-10-18', false], ['2026-10-17', false], ['2026-10-26', true], ['2026-10-21', true]]);
  assert.deepEqual(result.reobserve, ['2026-10-26', '2026-10-21']);
});

test('a running retry pauses for a waiting first-pass day, then resumes without a failure', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-17', '2026-10-26']);
  const calls = [];
  let retryRuns = 0;
  let retryStarted;
  const started = new Promise(resolve => { retryStarted = resolve; });
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async job => {
    calls.push([job.day, !!job.retryErrors]);
    if (job.day === '2026-10-26') {
      retryRuns += 1;
      if (retryRuns === 1) {
        retryStarted();
        await new Promise(resolve => job.signal.addEventListener('abort', resolve, { once: true }));
        return { ok: false, paused: true, error: 'paused' };
      }
    }
    return { ok: true };
  } });
  stage.trigger({ day: '2026-10-26', retryErrors: true, reason: 'reobserve-errors' });
  await started;
  assert.equal((await stage.health()).running.day, '2026-10-26');
  stage.trigger({ day: '2026-10-17', reason: 'backfill' });
  await stage.idle();
  assert.deepEqual(calls, [['2026-10-26', true], ['2026-10-17', false], ['2026-10-26', true]]);
  const health = await stage.health();
  assert.deepEqual(health.alerts.filter(alert => alert.includes('failed')), []);
  assert.equal(health.lastRun.day, '2026-10-26');
  assert.equal(health.lastRun.ok, true);
  const stored = JSON.parse(await fs.readFile(stage.healthPath, 'utf8'));
  assert.deepEqual(stored.failures, {});
});

test('a retry is not paused by another retry', async t => {
  const { universeDir, dataDir } = await tapeDir(t, ['2026-10-25', '2026-10-26']);
  let signalAborted = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const stage = createLiveSitesStage({ universeDir, dataDir, env: {}, log: quiet, runDay: async job => {
    if (job.day === '2026-10-26') { await gate; signalAborted = job.signal.aborted; }
    return { ok: true };
  } });
  stage.trigger({ day: '2026-10-26', retryErrors: true });
  await new Promise(resolve => setImmediate(resolve));
  stage.trigger({ day: '2026-10-25', retryErrors: true });
  release();
  await stage.idle();
  assert.equal(signalAborted, false);
});
