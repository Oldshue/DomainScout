'use strict';

function matchesTldWorkerIdentity(lock, { currentPid = process.pid, readCommand = () => '' } = {}) {
  if (!lock || !Number.isInteger(Number(lock.pid))) return false;
  if (Number(lock.parentPid) === Number(currentPid)) return true;
  try {
    return String(readCommand(Number(lock.pid)) || '').includes('tlds-worker.js');
  } catch {
    return false;
  }
}

module.exports = { matchesTldWorkerIdentity };
