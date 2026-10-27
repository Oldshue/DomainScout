'use strict';

// Child-process entry for the near-live CT launch detector:
// `node server/ct-launch-worker.js`. One tailer per data volume (lock file
// with a liveness check). Exit 0 = stopped cleanly, 3 = another tailer holds
// the lock, 1 = failure. SIGTERM/SIGINT persist positions and stop. A worker
// orphaned by its server (parent gone) stops itself.

const fs = require('fs');
const path = require('path');
const { createCtLaunchDetector, ctPaths } = require('./ct-launches');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const holder = Number(fs.readFileSync(file, 'utf8'));
  if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && alive(holder)) return false;
  fs.writeFileSync(file, String(process.pid));
  return true;
}

async function main() {
  const dataDir = process.env.DOMAINSCOUT_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
  const universeDir = process.env.DOMAINSCOUT_UNIVERSE_DIR || path.join(dataDir, 'universe');
  const lock = ctPaths(dataDir).lock;
  if (!acquireLock(lock)) { console.error('[CtLaunches] another tailer holds the lock; exiting'); process.exitCode = 3; return; }
  const parent = process.ppid;
  const detector = createCtLaunchDetector({ dataDir, universeDir });
  let stopping = null;
  const stop = () => {
    if (!stopping) stopping = detector.stop().catch(error => console.error(`[CtLaunches] stop failed: ${error.message}`))
      .finally(() => { try { if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.rmSync(lock, { force: true }); } catch { /* gone */ } });
    return stopping;
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stop().then(() => process.exit(0)); });
  setInterval(() => { if (process.ppid !== parent) stop().then(() => process.exit(0)); }, 30000).unref();
  const started = await detector.start();
  console.log(`[CtLaunches] tailing ${started.logs.length} CT logs (${started.logs.map(l => `${l.name}@${l.position ?? 'head'}`).join(', ')})`);
  // Keep the process alive; the tail loops hold timers.
  setInterval(() => {}, 1 << 30);
}

main().catch(error => {
  console.error(`[CtLaunches] failed: ${error.stack || error.message}`);
  process.exit(1);
});
