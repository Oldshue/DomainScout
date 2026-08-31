'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DEFAULT_DISCOVERY_PATH } = require('./sale-watch');

const DEFAULT_INTERVAL_MS = 60 * 60_000;
const DEFAULT_BASELINE_PATH = path.join(__dirname, '../config/sale-watch-discovery-baseline.json');

function seedFromBaseline(outputPath, baselinePath = DEFAULT_BASELINE_PATH) {
  if (fs.existsSync(outputPath) || !fs.existsSync(baselinePath)) return false;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(baselinePath, outputPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(outputPath, 0o600);
  return true;
}

function enabledByEnvironment(env = process.env) {
  const configured = String(env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_ENABLED || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(configured)) return true;
  if (['0', 'false', 'no', 'off'].includes(configured)) return false;
  return !env.RAILWAY_ENVIRONMENT && !env.RAILWAY_PROJECT_ID;
}

function startSaleWatchDiscoveryScheduler(options = {}) {
  const env = options.env || process.env;
  if (!enabledByEnvironment(env)) {
    console.log('[Sale Watch] Nameserver discovery disabled in this runtime');
    return { enabled: false, stop() {} };
  }
  const outputPath = path.resolve(env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_PATH || DEFAULT_DISCOVERY_PATH);
  const baselinePath = path.resolve(env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_BASELINE_PATH || DEFAULT_BASELINE_PATH);
  const scriptPath = path.join(__dirname, '../scripts/update-sale-watch-sales.js');
  const intervalMs = Math.max(5 * 60_000, Number(env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_INTERVAL_MS || options.intervalMs || DEFAULT_INTERVAL_MS));
  const initialDelayMs = Math.max(0, Number(env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_INITIAL_DELAY_MS || options.initialDelayMs || 20_000));
  let running = false;
  let stopped = false;
  let child = null;
  if (seedFromBaseline(outputPath, baselinePath)) {
    console.log('[Sale Watch] Seeded the persistent ledger from the packaged nameserver-forensic baseline');
  }

  function run(reason) {
    if (running || stopped) return false;
    running = true;
    console.log(`[Sale Watch] Starting ${reason} nameserver-departure scan`);
    child = spawn(process.execPath, [scriptPath, outputPath], {
      cwd: path.join(__dirname, '..'),
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('exit', (code, signal) => {
      running = false;
      child = null;
      if (code === 0) console.log(`[Sale Watch] ${reason} nameserver-departure scan published`);
      else console.error(`[Sale Watch] ${reason} scan failed (${signal || `exit ${code}`})`);
    });
    return true;
  }

  const startup = setTimeout(() => run('startup'), initialDelayMs);
  const interval = setInterval(() => run('scheduled'), intervalMs);
  startup.unref?.();
  interval.unref?.();
  return {
    enabled: true,
    outputPath,
    run,
    stop() {
      stopped = true;
      clearTimeout(startup);
      clearInterval(interval);
      if (child && !child.killed) child.kill('SIGTERM');
    },
  };
}

module.exports = { DEFAULT_INTERVAL_MS, DEFAULT_BASELINE_PATH, enabledByEnvironment, seedFromBaseline, startSaleWatchDiscoveryScheduler };
