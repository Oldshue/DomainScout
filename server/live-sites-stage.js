'use strict';

/**
 * Supervisor for the live-sites observation stage (server/live-sites.js).
 *
 * - trigger({ day }) is called from the universe lane's completion hooks
 *   (pull supervisor onDayPublished, ns-movement import, observed-zone
 *   capture). It only enqueues and returns immediately; it never throws and
 *   never awaits network work, so the lane is never blocked or slowed.
 * - Days run one at a time in a child process (server/live-sites-worker.js)
 *   bounded by a wall-clock timeout; a crash/timeout keeps the resume journal.
 * - backfill({ days }) enqueues the most recent tape days that lack a
 *   complete observation summary.
 * - health() reports running/queued days, the last run, per-day summaries
 *   and alerts. Failures are written to <dataDir>/universe/live-sites-health.json
 *   and surface under `liveSites` in GET /api/universe/health.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { listObservationDays, CLASSIFIER_VERSION } = require('./live-sites');
const { judgementPending, judgeConfigured } = require('./live-sites-judge');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RUN_TIMEOUT_MS = 4 * 3600 * 1000;

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  await fsp.writeFile(part, JSON.stringify(value, null, 2));
  await fsp.rename(part, file);
}

function spawnRunner({ env, spawnImpl, timeoutMs, universeDir, dataDir }) {
  return ({ day, force, judge }) => new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(process.execPath, [path.join(__dirname, 'live-sites-worker.js'), day, ...(force ? ['--force'] : []), ...(judge ? ['--judge'] : [])], {
        env: { ...env, DOMAINSCOUT_UNIVERSE_DIR: universeDir, DOMAINSCOUT_DATA_DIR: dataDir },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (error) {
      return resolve({ ok: false, error: `spawn failed: ${error.message}` });
    }
    let settled = false;
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 15000).unref?.();
      done({ ok: false, error: `worker exceeded ${timeoutMs}ms; journal retained for resume` });
    }, timeoutMs);
    timer.unref?.();
    child.once('error', error => done({ ok: false, error: error.message }));
    child.once('exit', (code, signal) => {
      if (code === 0) done({ ok: true });
      else if (code === 2) done({ ok: false, noTape: true, error: `no movement tape for ${day}` });
      else done({ ok: false, error: `worker exited ${signal || code}` });
    });
  });
}

function createLiveSitesStage({
  universeDir,
  dataDir,
  env = process.env,
  spawnImpl = spawn,
  runDay,
  now = () => new Date(),
  log = console,
} = {}) {
  if (!universeDir) throw new Error('universeDir is required');
  const healthPath = path.join(dataDir || universeDir, 'universe', 'live-sites-health.json');
  const enabled = env.DOMAINSCOUT_LIVE_SITES_ENABLED !== '0';
  const timeoutMs = Number(env.DOMAINSCOUT_LIVE_SITES_RUN_TIMEOUT_MS) > 0 ? Number(env.DOMAINSCOUT_LIVE_SITES_RUN_TIMEOUT_MS) : DEFAULT_RUN_TIMEOUT_MS;
  const runner = runDay || spawnRunner({ env, spawnImpl, timeoutMs, universeDir, dataDir: dataDir || universeDir });
  const queue = [];
  let current = null;
  let draining = null;

  async function record(update) {
    try {
      const previous = (await readJson(healthPath).catch(() => null)) || {};
      const failures = { ...(previous.failures || {}) };
      if (update.failedDay) failures[update.failedDay] = { error: update.error, at: now().toISOString() };
      if (update.okDay) delete failures[update.okDay];
      await atomicJson(healthPath, {
        schema: 'domainscout.live-sites-health/v1',
        lastRun: update.lastRun || previous.lastRun || null,
        lastSuccess: update.okDay ? { day: update.okDay, at: now().toISOString() } : previous.lastSuccess || null,
        failures,
      });
    } catch (error) {
      log?.error?.(`[LiveSites] health write failed: ${error.message}`);
    }
  }

  async function drain() {
    while (queue.length) {
      const job = queue.shift();
      current = { ...job, startedAt: now().toISOString() };
      let result;
      try { result = await runner({ day: job.day, force: job.force, judge: !!job.judge }); }
      catch (error) { result = { ok: false, error: error?.message || String(error) }; }
      const finishedAt = now().toISOString();
      const lastRun = { day: job.day, reason: job.reason, startedAt: current.startedAt, finishedAt, ok: !!result?.ok, error: result?.ok ? null : (result?.error || 'unknown failure') };
      if (result?.ok) await record({ lastRun, okDay: job.day });
      else {
        log?.error?.(`[LiveSites] ${job.day} failed: ${lastRun.error}`);
        await record({ lastRun, failedDay: job.day, error: lastRun.error });
      }
      current = null;
    }
  }

  /** Enqueues one day; returns synchronously. Never throws, never blocks the caller. */
  function trigger({ day, force = false, judge = false, reason = 'lane-complete' } = {}) {
    try {
      if (!enabled) return { queued: false, reason: 'disabled' };
      if (!DAY_PATTERN.test(String(day || ''))) return { queued: false, reason: 'invalid-day' };
      if (current?.day === day && !force) return { queued: false, reason: 'running' };
      const existing = queue.find(job => job.day === day);
      // A full observation run includes judgement, so it absorbs a judge-only job.
      if (existing) { existing.force = existing.force || force; existing.judge = existing.judge && judge; return { queued: true, day, duplicate: true }; }
      queue.push({ day, force, judge, reason, queuedAt: now().toISOString() });
      queue.sort((a, b) => b.day.localeCompare(a.day));
      if (!draining) {
        draining = Promise.resolve().then(drain)
          .catch(error => log?.error?.(`[LiveSites] drain failed: ${error.message}`))
          .finally(() => { draining = null; });
      }
      return { queued: true, day };
    } catch (error) {
      log?.error?.(`[LiveSites] trigger failed: ${error.message}`);
      return { queued: false, reason: 'error', error: error.message };
    }
  }

  /**
   * Enqueues up to `days` most recent tape days whose observation is missing,
   * incomplete or from an older classifier, plus a judge-only run for each of
   * the newest `judgeDays` (default 2) complete days that still have
   * unlabelled rows (when DEEPSEEK_API_KEY is set).
   */
  async function backfill({ days = 3, force = false, judgeDays = 2 } = {}) {
    const limit = Math.max(1, Math.min(30, Math.trunc(Number(days)) || 3));
    const all = await listObservationDays(universeDir);
    const listed = all.filter(entry => entry.hasTape).slice(0, limit);
    const queued = [];
    for (const entry of listed) {
      const complete = entry.summary?.status === 'complete' && entry.summary.version === CLASSIFIER_VERSION;
      if (complete && !force) continue;
      if (trigger({ day: entry.day, force, reason: 'backfill' }).queued) queued.push(entry.day);
    }
    const judgeQueued = [];
    if (judgeConfigured(env)) {
      const newest = all.filter(entry => entry.summary?.status === 'complete').slice(0, Math.max(0, Math.trunc(Number(judgeDays)) || 0));
      for (const entry of newest) {
        if (queued.includes(entry.day) || !judgementPending(entry.summary)) continue;
        if (trigger({ day: entry.day, judge: true, reason: 'judge-backfill' }).queued) judgeQueued.push(entry.day);
      }
    }
    return { considered: listed.map(entry => entry.day), queued, judgeQueued };
  }

  async function health({ days = 7 } = {}) {
    const stored = (await readJson(healthPath).catch(error => ({ readError: error.message }))) || {};
    let recent = [];
    let listError = null;
    try { recent = (await listObservationDays(universeDir)).slice(0, days); }
    catch (error) { listError = error.message; }
    const alerts = [];
    if (stored.readError) alerts.push(`Live-sites health unreadable: ${stored.readError}`);
    if (listError) alerts.push(`Live-sites day listing failed: ${listError}`);
    for (const [day, failure] of Object.entries(stored.failures || {})) alerts.push(`Live-sites observation failed for ${day}: ${failure.error}`);
    for (const entry of recent) {
      const status = entry.summary?.status;
      const active = current?.day === entry.day || queue.some(job => job.day === entry.day);
      if (entry.hasTape && !active && status && status !== 'complete' && !(stored.failures || {})[entry.day]) {
        alerts.push(`Live-sites observation for ${entry.day} is ${status}${entry.summary?.error ? `: ${entry.summary.error}` : ''}`);
      }
      const judgement = entry.summary?.judgement;
      if (status === 'complete' && judgement && Number(judgement.unlabelled) > 0 && !active) {
        alerts.push(`Live-sites judgement for ${entry.day} is ${judgement.status}: ${judgement.unlabelled} of ${judgement.eligible} rows unlabelled${judgement.error ? ` (${judgement.error})` : ''}`);
      }
    }
    const latestTape = recent.find(entry => entry.hasTape);
    const latestObserved = latestTape?.summary?.status === 'complete' && latestTape.summary.version === CLASSIFIER_VERSION;
    if (enabled && latestTape && !latestObserved && current?.day !== latestTape.day && !queue.some(job => job.day === latestTape.day)) {
      alerts.push(`Latest movement day ${latestTape.day} has no complete site observation`);
    }
    const status = !enabled ? 'disabled' : current ? 'running' : alerts.length ? 'failed' : latestTape ? 'ok' : 'idle';
    return {
      status,
      enabled,
      classifierVersion: CLASSIFIER_VERSION,
      judgeConfigured: judgeConfigured(env),
      running: current ? { day: current.day, reason: current.reason, startedAt: current.startedAt } : null,
      queued: queue.map(job => job.day),
      lastRun: stored.lastRun || null,
      lastSuccess: stored.lastSuccess || null,
      alerts,
      days: recent.map(entry => ({
        day: entry.day,
        hasTape: entry.hasTape,
        status: entry.summary?.status || 'missing',
        total: entry.summary?.total ?? null,
        observed: entry.summary?.observed ?? null,
        counts: entry.summary?.counts || null,
        built: entry.summary?.built || null,
        kits: entry.summary ? { count: entry.summary.kits?.count ?? null, names: entry.summary.kits?.names ?? null } : null,
        judgement: entry.summary?.judgement ? {
          status: entry.summary.judgement.status, eligible: entry.summary.judgement.eligible, labelled: entry.summary.judgement.labelled,
          unlabelled: entry.summary.judgement.unlabelled, withheld: entry.summary.judgement.withheld, counts: entry.summary.judgement.counts,
          failedBatches: entry.summary.judgement.failedBatches, error: entry.summary.judgement.error,
        } : null,
        durationMs: entry.summary?.durationMs ?? null,
        finishedAt: entry.summary?.finishedAt || null,
      })),
    };
  }

  return {
    trigger, backfill, health,
    isRunning: () => !!current,
    idle: () => draining || Promise.resolve(),
    healthPath,
  };
}

module.exports = { createLiveSitesStage };
