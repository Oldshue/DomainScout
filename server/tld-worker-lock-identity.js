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

module.exports = { matchesTldWorkerIdentity };
