'use strict';

function evaluateBackgroundWorkAdmission({ workload, blockers = [] } = {}) {
  const normalizedWorkload = String(workload || '').trim() || 'background-work';
  for (const blocker of blockers) {
    if (!blocker || !blocker.state) continue;
    return {
      admitted: false,
      workload: normalizedWorkload,
      blockedBy: String(blocker.name || 'background-work'),
      state: blocker.state,
    };
  }
  return { admitted: true, workload: normalizedWorkload, blockedBy: null, state: null };
}

module.exports = { evaluateBackgroundWorkAdmission };
