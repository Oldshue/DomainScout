'use strict';

// Provider-neutral admission policy for a selected-TLD projection over an immutable
// inventory snapshot. A verified positive is independently safe to show: incomplete
// universe coverage can hide additional matches, but it cannot invalidate the matches
// that carry explicit evidence. Negative claims still require complete coverage.
//
// This keeps a sparse positive facet usable while an optional whole-universe receipt
// is unavailable, without converting a lower bound into an exact result claim.
function selectedTldProjectionPolicy(query, normalizedTargets = []) {
  const mode = String(query?.takenInMode || 'taken').toLowerCase();
  const hasTargets = Array.isArray(normalizedTargets) && normalizedTargets.length > 0;
  const positive = mode === 'taken' && hasTargets;
  return {
    admissible: positive,
    positive,
    requiresCompleteUniverse: !positive,
    evidenceMode: positive ? 'verified-positive-lower-bound' : 'complete-universe',
  };
}

function isPositiveSelectedTldRequest(query, normalizedTargets = []) {
  return selectedTldProjectionPolicy(query, normalizedTargets).positive;
}

module.exports = { isPositiveSelectedTldRequest, selectedTldProjectionPolicy };
