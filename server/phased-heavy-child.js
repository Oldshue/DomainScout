'use strict';

const { runWithHeavyJobGate } = require('./heavy-job-gate');

// Own the shared bulk-memory gate only until a child explicitly confirms that its
// memory-heavy preparation has been released. The child remains tracked through its
// (potentially long) network phase, and exit/error before the checkpoint releases the
// gate safely. This keeps admission ownership tied to observable lifecycle events,
// never a wall-clock guess.
function startPhasedHeavyChild({
  gate,
  name,
  spawnChild,
  phaseMessage = 'memory-phase-complete',
  onChild = null,
  onPhase = null,
  onTerminal = null,
} = {}) {
  if (!gate) throw new Error('heavy job gate is required');
  if (typeof spawnChild !== 'function') throw new Error('spawnChild is required');

  let resolveDone;
  const job = {
    status: 'waiting',
    pid: null,
    requestedAt: new Date().toISOString(),
    phaseCompletedAt: null,
    terminalAt: null,
    terminal: null,
    done: new Promise(resolve => { resolveDone = resolve; }),
  };

  let terminal = false;
  const finish = (kind, detail = null) => {
    if (terminal) return;
    terminal = true;
    job.status = kind === 'exit' && Number(detail) === 0 ? 'complete' : 'failed';
    job.terminalAt = new Date().toISOString();
    job.terminal = { kind, detail };
    try { onTerminal?.(job.terminal, job); } finally { resolveDone(job.terminal); }
  };

  job.admission = runWithHeavyJobGate(gate, name, () => new Promise(resolveGate => {
    let gateReleased = false;
    const releaseMemoryPhase = () => {
      if (gateReleased) return;
      gateReleased = true;
      resolveGate();
    };

    let child;
    try {
      child = spawnChild();
    } catch (error) {
      finish('spawn-error', error);
      releaseMemoryPhase();
      return;
    }

    job.status = 'memory-preparation';
    job.pid = child?.pid || null;
    onChild?.(child, job);
    child.on('message', message => {
      if (message?.type !== phaseMessage || gateReleased) return;
      job.status = 'network-running';
      job.phaseCompletedAt = new Date().toISOString();
      onPhase?.(message, job);
      releaseMemoryPhase();
    });
    child.once('error', error => {
      finish('error', error);
      releaseMemoryPhase();
    });
    child.once('exit', code => {
      finish('exit', code);
      releaseMemoryPhase();
    });
  })).catch(error => {
    finish('admission-error', error);
  });

  // Avoid an unhandled rejection if a caller only observes `done`.
  job.admission.catch(() => {});
  return job;
}

module.exports = { startPhasedHeavyChild };
