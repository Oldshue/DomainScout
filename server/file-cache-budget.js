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
  readFile = fs.readFileSync, io = fs, advise = releaseOwnFileCache, log = console } = {}) {
  let running = null;
  async function run(reason = 'scheduled') {
    if (running) return running;
    if (busy()) return { ran: false, reason: 'busy' };
    const before = fileCacheBytes(readFile);
    if (before === null) return { ran: false, reason: 'unsupported' };
    if (before < thresholdBytes) return { ran: false, reason: 'below-budget', before, thresholdBytes };
    running = (async () => {
      const files = ownedCacheFiles(dataDir, io);
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
  const intervalMs = Math.max(5 * 60_000, Number(options.intervalMs) || 15 * 60_000);
  const initialDelayMs = Math.max(30_000, Number(options.initialDelayMs) || 2 * 60_000);
  const first = setTimeout(() => { void budget.run('startup-idle'); }, initialDelayMs);
  const timer = setInterval(() => { void budget.run('scheduled-idle'); }, intervalMs);
  first.unref?.(); timer.unref?.();
  return { ...budget, stop() { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { GIB, fileCacheBytes, ownedCacheFiles, createFileCacheBudget, startFileCacheBudget };
