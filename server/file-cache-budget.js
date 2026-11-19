'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { releaseOwnFileCache } = require('./file-cache-advice');

const GIB = 1024 ** 3;

function fileCacheBytes(readFile = fs.readFileSync) {
  try {
    const text = String(readFile('/sys/fs/cgroup/memory.stat', 'utf8'));
    const row = text.split('\n').find(line => line.startsWith('file '));
    const value = Number(row && row.slice(5));
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch (_) { return null; }
}

function ownedCacheFiles(dataDir, io = fs) {
  const files = ['domains.db', 'sale_watch.db', 'zone_index.db', 'universe_summary.db', 'sale-watch-discovery.json']
    .flatMap(name => [path.join(dataDir, name), path.join(dataDir, `${name}-wal`)]);
  files.push(path.join(dataDir, 'universe', 'ct', 'launches.db'), path.join(dataDir, 'universe', 'ct', 'launches.db-wal'));
  let days = [];
  try { days = io.readdirSync(path.join(dataDir, 'universe')).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().slice(-30); } catch (_) {}
  for (const day of days) {
    const base = path.join(dataDir, 'universe', day, 'sites');
    files.push(path.join(base, 'public-feed-v2.sqlite'), path.join(base, 'public-feed-v2.sqlite-wal'));
  }
  return files.filter(file => { try { return io.statSync(file).isFile(); } catch (_) { return false; } });
}

function createFileCacheBudget({ dataDir, busy = () => false, thresholdBytes = 4 * GIB,
  protectedFile = () => false, readFile = fs.readFileSync, io = fs, advise = releaseOwnFileCache, log = console } = {}) {
  let running = null;
  async function run(reason = 'scheduled') {
    if (running) return running;
    if (busy()) return { ran: false, reason: 'busy' };
    const before = fileCacheBytes(readFile);
    if (before === null) return { ran: false, reason: 'unsupported' };
    if (before < thresholdBytes) return { ran: false, reason: 'below-budget', before, thresholdBytes };
    running = (async () => {
      const files = ownedCacheFiles(dataDir, io).filter(file => !protectedFile(file));
      if (!files.length) return { ran: false, reason: 'all-protected', before, thresholdBytes };
      const advice = await advise(files);
      const after = fileCacheBytes(readFile);
      const result = { ran: true, reason, before, after, files: files.length, advice };
      log.log?.(`[FileCache] ${reason}: ${Math.round(before / 1048576)}MB -> ${after === null ? 'unknown' : `${Math.round(after / 1048576)}MB`} (${advice.advised || 0} files advised)`);
      return result;
    })().finally(() => { running = null; });
    return running;
  }
  return { run };
}

function startFileCacheBudget(options = {}) {
  const budget = createFileCacheBudget(options);
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  // The budget is only as tight as the clock that checks it. Checked every five
  // minutes, a 4 GiB budget let the cache stand at 6-7.6 GiB for about half of
  // every cycle (measured: 4.3 GiB average against the 4 GiB ceiling), and that
  // overshoot is billed like any other memory. Reading one cgroup file is
  // nearly free, so look every 30 seconds and release as soon as the budget is
  // actually exceeded. Releases themselves stay at least two minutes apart: a
  // working set larger than the budget must not turn into continuous re-reads.
  const intervalMs = Math.max(15_000, Number(options.intervalMs) || 30_000);
  const minReleaseGapMs = Math.max(0, options.minReleaseGapMs === undefined ? 2 * 60_000 : Number(options.minReleaseGapMs) || 0);
  const initialDelayMs = Math.max(30_000, Number(options.initialDelayMs) || 2 * 60_000);
  const busyRetryMs = Math.max(15_000, Number(options.busyRetryMs) || 60_000);
  let timer = null, stopped = false, first = true, lastReleaseAt = -Infinity;
  // Every release counts, whoever asked for it (a finished provider query too).
  const run = async reason => {
    const result = await budget.run(reason);
    if (result?.ran) lastReleaseAt = now();
    return result;
  };
  const schedule = delay => {
    if (stopped) return;
    timer = setTimer(async () => {
      const wait = lastReleaseAt + minReleaseGapMs - now();
      if (wait > 0) return schedule(Math.min(wait, intervalMs));
      let result = null;
      try { result = await run(first ? 'startup-idle' : 'scheduled-idle'); } catch (_) {}
      first = false;
      schedule(result?.reason === 'busy' ? busyRetryMs : intervalMs);
    }, delay);
    timer?.unref?.();
  };
  schedule(initialDelayMs);
  return { ...budget, run, stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

function cleanupAfterResponse(budget, response, { delayMs = 1_000, setTimer = setTimeout } = {}) {
  if (!budget || !response?.once) return false;
  response.once('finish', () => {
    const timer = setTimer(() => budget.run('post-provider-query').catch(() => {}), delayMs);
    timer?.unref?.();
  });
  return true;
}

module.exports = { GIB, fileCacheBytes, ownedCacheFiles, createFileCacheBudget, startFileCacheBudget, cleanupAfterResponse };
