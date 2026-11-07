'use strict';

// Off-main Sale Watch probe wave (child process).
//
// 2026-11-07 outage: runProbeWave ran on the HTTP thread with the main
// sale_watch.db handle. A synchronous SQLite call / fs.readSync in D state
// (21 GB db, 4 GB -wal, 537 MB discovery file, three days of backlog) froze
// the event loop; stage timeouts cannot interrupt synchronous work. Every
// wave now runs here, in its own process with its OWN writable connection.
// The main thread (server/sale-watch-wave-supervisor.js) only spawns this
// process, watches its heartbeat and SIGKILLs it when it hangs; a real
// process boundary makes that termination possible where an in-thread
// deadline cannot.
//
// Same spawn style as server/sale-watch-scheduler.js (process.execPath + a
// script), with an IPC channel for the job and status.
//
// Protocol (parent -> child, first message):
//   { type: 'run', dbPath, busyTimeoutMs, heartbeatMs, options }
//   { type: 'record-abandoned', dbPath, busyTimeoutMs, runId, reason, detail }
// Protocol (child -> parent):
//   { type: 'heartbeat', at }     every heartbeatMs while the loop is free
//   { type: 'run', runId }        sale_watch_wave_runs row id
//   { type: 'stage', stage, wal } stage change (wal = last checkpoint)
//   { type: 'index-request', pass, options } search/assess pass for the parent's indexer
//   { type: 'done', summary }     wave finished
//   { type: 'recorded', changes } abandoned run recorded
//   { type: 'error', error }      failure

const Database = require('better-sqlite3');
const recon = require('./sale-watch-reconstruction');

function send(message) {
  return new Promise(resolve => {
    try {
      if (!process.send || !process.connected) return resolve(false);
      process.send(message, () => resolve(true));
    } catch (_) { resolve(false); }
  });
}

function openDb(dbPath, busyTimeoutMs) {
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${Number(busyTimeoutMs) > 0 ? Math.floor(Number(busyTimeoutMs)) : 30000}`);
  recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  return db;
}

// Test-only injection (synthetic slow/hanging stages). Never active in
// production: requires the explicit env opt-in.
function applyTestHook(job, opts, db) {
  if (!job.testHook) return;
  if (process.env.DOMAINSCOUT_SALE_WATCH_WAVE_TEST_HOOKS !== '1') throw new Error('wave test hooks are disabled');
  require(job.testHook)(opts, db, job);
}

async function runWave(job) {
  const db = openDb(job.dbPath, job.busyTimeoutMs);
  const heartbeatMs = Number(job.heartbeatMs) > 0 ? Math.floor(Number(job.heartbeatMs)) : 5000;
  const beat = setInterval(() => { void send({ type: 'heartbeat', at: Date.now() }); }, heartbeatMs);
  try {
    void send({ type: 'heartbeat', at: Date.now() });
    const opts = {
      ...(job.options || {}),
      checkpointBetweenStages: true,
      onStage: (stage, wal) => { void send({ type: 'stage', stage, wal: wal || null, at: Date.now() }); },
      onWaveRun: runId => { void send({ type: 'run', runId }); },
      // Index / assess passes belong to the main process's single indexer
      // (a worker started here would die with this child and overlap it).
      requestSearchIndexPass: (_db, req) => {
        void send({ type: 'index-request', pass: req && req.pass, options: (req && req.options) || {} });
        return { inProcess: false, started: false, queued: true, forwarded: true };
      },
      // Due selection runs in a worker thread on its own connection so this
      // process's event loop (and its heartbeat timer) stays free even when a
      // selection is slow on a cold page cache (wave 1162, 2026-11-07).
      selectDueCandidates: (_db, sel = {}) => require('./sale-watch-select-worker').selectDueOffThread(job.dbPath, {
        now: sel.now || null, limit: sel.limit || null, busyTimeoutMs: job.busyTimeoutMs,
        testDelayMs: Number((job.options || {}).testSelectDelayMs) || 0,
      }),
      // The other wave-child reads over sale_watch_candidates (the wave-size
      // backlog count, the adoption-kit window pass and first-probe health)
      // run the same way, each on its own worker connection.
      computeWaveSize: (_db, a = {}) => offThread('computeWaveSize', a, Number((job.options || {}).testWaveSizeDelayMs) || 0),
      markAdoptionKits: (_db, a = {}) => offThread('markAdoptionKits', a, 0),
      firstProbeHealth: (_db, a = {}) => offThread('firstProbeHealth', a, 0),
    };
    function offThread(name, a, testDelayMs) {
      const args = {};
      if (a && a.now != null) args.now = new Date(a.now).toISOString();
      return require('./sale-watch-select-worker').runOffThread(job.dbPath, name, args, {
        busyTimeoutMs: Number(job.busyTimeoutMs) > 0 ? Number(job.busyTimeoutMs) : 30000, testDelayMs,
      });
    }
    applyTestHook(job, opts, db);
    const summary = await recon.runProbeWave(db, opts);
    await send({ type: 'done', summary });
  } finally {
    clearInterval(beat);
    try { db.close(); } catch (_) { /* ignore */ }
  }
}

// Records a wave the supervisor terminated. Runs in a fresh child so the
// write never touches the HTTP thread. Also closes any older run row left
// unfinished by a crashed or killed wave.
function recordAbandoned(job) {
  const db = openDb(job.dbPath, job.busyTimeoutMs);
  try {
    const at = new Date().toISOString();
    const detail = JSON.stringify({ stageErrors: [{ stage: job.stage || 'unknown', error: job.detail || 'terminated by supervisor', code: 'WAVE_TERMINATED', at }], terminated: true });
    let changes = 0;
    if (job.runId != null) {
      changes += db.prepare('UPDATE sale_watch_wave_runs SET finished_at = ?, reason = ?, summary_json = ? WHERE id = ? AND finished_at IS NULL')
        .run(at, job.reason || 'abandoned', detail, Number(job.runId)).changes;
    }
    changes += db.prepare("UPDATE sale_watch_wave_runs SET finished_at = ?, reason = 'abandoned', summary_json = ? WHERE finished_at IS NULL AND id < COALESCE(?, (SELECT MAX(id) + 1 FROM sale_watch_wave_runs))")
      .run(at, detail, job.runId == null ? null : Number(job.runId)).changes;
    if (job.runId == null) {
      // The wave never reported its row: record the termination as its own row.
      changes += db.prepare('INSERT INTO sale_watch_wave_runs(started_at, stage, finished_at, reason, summary_json) VALUES(?, ?, ?, ?, ?)')
        .run(job.startedAt || at, job.stage || 'unknown', at, job.reason || 'abandoned', detail).changes;
    }
    return changes;
  } finally {
    try { db.close(); } catch (_) { /* ignore */ }
  }
}

async function main(job) {
  try {
    if (!job || !job.dbPath) throw new Error('wave child: missing dbPath');
    if (job.type === 'record-abandoned') await send({ type: 'recorded', changes: recordAbandoned(job) });
    else await runWave(job);
    process.exit(0);
  } catch (error) {
    await send({ type: 'error', error: String((error && error.message) || error) });
    process.exit(1);
  }
}

if (require.main === module) {
  // Parent gone: never keep writing as an orphan.
  process.on('disconnect', () => process.exit(2));
  process.once('message', job => { void main(job); });
}

module.exports = { recordAbandoned };
