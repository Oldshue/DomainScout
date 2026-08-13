'use strict';

// Provider-neutral admission policy for a selected-TLD projection over an immutable
// inventory snapshot. Evidence transport is deliberately irrelevant here: callers
// may request legacy `partial`, explicit, complete, or omit the hint entirely. The
// snapshot path itself withholds output until its generation-bound sibling scan is
// complete, so every admitted positive request receives the same exact evidence.
function isPositiveSelectedTldRequest(query, normalizedTargets = []) {
  const mode = String(query?.takenInMode || 'taken').toLowerCase();
  return mode === 'taken' && Array.isArray(normalizedTargets) && normalizedTargets.length > 0;
}

module.exports = { isPositiveSelectedTldRequest };
