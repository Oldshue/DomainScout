'use strict';

// Provider-neutral projection for immutable marketplace snapshot pages. The snapshot
// remains the freshness authority; shared evidence (for example extension coverage)
// is joined after the bounded page is selected, and provider-specific live overlays
// are opt-in capabilities rather than branches in the shared path.
function hydrateProviderSnapshotPage(rows, options = {}) {
  let hydrated = Array.isArray(rows) ? rows : [];
  if (options.extensionHydration !== false && typeof options.enrichExtensions === 'function') {
    hydrated = options.enrichExtensions(hydrated);
  }
  if (options.liveOverlay === true && typeof options.overlayLiveFields === 'function') {
    hydrated = options.overlayLiveFields(hydrated);
  }
  return hydrated;
}

function providerPageHasFinalExtensionEvidence(rows) {
  return Array.isArray(rows) && rows.every(row => (
    row?.tlds_verified === true &&
    row?.tlds_taken != null &&
    Boolean(row?.tlds_checked_at)
  ));
}

module.exports = { hydrateProviderSnapshotPage, providerPageHasFinalExtensionEvidence };
