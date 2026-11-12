'use strict';

// Process-backed read worker with the worker_threads surface the read pool
// uses (postMessage / on / removeAllListeners / terminate / unref).
//
// better-sqlite3 cannot cancel a running statement, and worker.terminate()
// only takes effect once the native call returns. A statement that outlived
// its deadline therefore kept running on its retired thread and kept its WAL
// read snapshot: 2026-11-12, a candidate-tape read that timed out at 20 s ran
// on for more than 20 minutes, no checkpoint could reset the log (700 MB) and
// the freshness verdict went degraded. A child process can be killed outright,
// and the kernel drops its locks the moment it dies, so a read on these lanes
// holds a snapshot for at most its own deadline.
//
// The child runs the same server/db-read-worker.js (it detects that it was
// forked). 'advanced' serialization keeps structured-clone semantics for the
// rows it returns.
const child_process = require('child_process');
const { EventEmitter } = require('events');

const DATA_ENV = 'DOMAINSCOUT_DB_READ_WORKER_DATA';

function createProcessWorker(file, { workerData = {}, fork = child_process.fork, env = process.env } = {}) {
  const emitter = new EventEmitter();
  const child = fork(file, [], {
    env: { ...env, [DATA_ENV]: JSON.stringify(workerData) },
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let exited = false;
  child.on('message', message => emitter.emit('message', message));
  child.on('error', error => emitter.emit('error', error));
  child.on('exit', (code, signal) => { exited = true; emitter.emit('exit', code == null ? signal : code); });
  return {
    pid: child.pid,
    postMessage(message) {
      if (exited || !child.connected) return;
      // A send that races the child's death surfaces through 'exit'.
      try { child.send(message, () => {}); } catch (_) { /* reported by exit */ }
    },
    on(event, listener) { emitter.on(event, listener); return this; },
    removeAllListeners() { emitter.removeAllListeners(); return this; },
    /** Kills the process at once; resolves when it has exited. */
    terminate() {
      return new Promise(resolve => {
        if (exited) { resolve(0); return; }
        child.once('exit', () => resolve(1));
        try { child.kill('SIGKILL'); } catch (_) { resolve(0); }
      });
    },
    unref() {
      try { child.unref(); } catch (_) { /* ignore */ }
      try { if (child.channel && child.channel.unref) child.channel.unref(); } catch (_) { /* ignore */ }
    },
  };
}

module.exports = { createProcessWorker, DATA_ENV };
