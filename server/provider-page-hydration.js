'use strict';

// Provider-neutral projection for immutable marketplace snapshot pages. The snapshot
// remains the freshness authority; shared evidence (for example extension coverage)
// is joined after the bounded page is selected, and provider-specific live overlays
// are opt-in capabilities rather than branches in the shared path.
function compareNullableValues(a, b, direction) {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return (aNumber - bNumber) * direction;
  return String(a).localeCompare(String(b)) * direction;
}

function reapplyMaterializedSort(rows, sortBy, sortDir) {
  if (!sortBy) return rows;
  const direction = String(sortDir).toUpperCase() === 'ASC' ? 1 : -1;
  return [...rows].sort((a, b) => (
    compareNullableValues(a?.[sortBy], b?.[sortBy], direction)
    || compareNullableValues(a?.auction_end, b?.auction_end, 1)
    || String(a?.domain || '').localeCompare(String(b?.domain || ''))
  ));
}

function hydrateProviderSnapshotPage(rows, options = {}) {
  let hydrated = Array.isArray(rows) ? rows : [];
  if (options.extensionHydration !== false && typeof options.enrichExtensions === 'function') {
    hydrated = options.enrichExtensions(hydrated);
  }
  if (options.liveOverlay === true && typeof options.overlayLiveFields === 'function') {
    hydrated = options.overlayLiveFields(hydrated);
  }
  // A bounded evidence join may replace the snapshot's sortable projection (for
  // example, attaching the exact concrete extension list and its cardinality). Never
  // return rows in the obsolete pre-hydration order. Callers opt in only for fields
  // whose value can change during hydration; unrelated provider fields are untouched.
  if (options.reapplySortBy) {
    hydrated = reapplyMaterializedSort(hydrated, options.reapplySortBy, options.sortDir);
  }
  return hydrated;
}

module.exports = { hydrateProviderSnapshotPage, reapplyMaterializedSort };
