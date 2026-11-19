'use strict';

function matchesTldWorkerIdentity(lock, { currentPid = process.pid, currentStartedAt = Date.now() - process.uptime() * 1000, readCommand = () => '' } = {}) {
  if (!lock || !Number.isInteger(Number(lock.pid))) return false;
  const lockStartedAt = Date.parse(String(lock.startedAt || ''));
  if (Number(lock.parentPid) === Number(currentPid) && Number.isFinite(lockStartedAt) && lockStartedAt >= currentStartedAt - 5000) return true;
  try {
    return String(readCommand(Number(lock.pid)) || '').includes('tlds-worker.js');
  } catch {
    return false;
  }
}

// Process ids are reused: after a container restart the pid recorded in a lock
// left on the persistent volume can belong to an unrelated live process (the web
// server itself, in the incident that kept the worker down from 2026-11-07).
// A lock therefore blocks a new worker only when its pid is alive AND that
// process is a tlds-worker.
function readProcessCommand(pid) {
  const fs = require('fs');
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    const { execFileSync } = require('child_process');
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  }
}

function lockHeldByLiveTldWorker(lock, {
  selfPid = process.pid,
  isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
  readCommand = readProcessCommand,
} = {}) {
  const pid = Number(lock?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === Number(selfPid)) return false;
  if (!isAlive(pid)) return false;
  try {
    return String(readCommand(pid) || '').includes('tlds-worker.js');
  } catch {
    return false;
  }
}

module.exports = { matchesTldWorkerIdentity, lockHeldByLiveTldWorker, readProcessCommand };
