'use strict';

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function researchExtensionCount(row) {
  const exact = finiteNonNegative(row?.tlds_taken);
  if (exact != null && row?.tlds_verified === true) return exact;
  const lowerBound = finiteNonNegative(row?.tlds_lower_bound);
  return lowerBound != null ? lowerBound : exact;
}

function applyExtensionProjection(row, projection, options = {}) {
  const priorCount = finiteNonNegative(row.tlds_taken);
  const priorLowerBound = finiteNonNegative(row.tlds_lower_bound);
  const projectedLowerBound = finiteNonNegative(projection?.extensionsLowerBound);
  const observedLowerBound = Math.max(priorCount || 0, priorLowerBound || 0, projectedLowerBound || 0);
  const projectedExact = projection?.verified ? finiteNonNegative(projection.extensions) : null;
  const exactIsConsistent = projectedExact != null && projectedExact >= observedLowerBound;

  row.tlds_taken = exactIsConsistent ? projectedExact : null;
  row.tlds_lower_bound = exactIsConsistent ? null : (observedLowerBound || null);
  row.tlds_verified = exactIsConsistent;
  row.tlds_sort_value = researchExtensionCount(row);
  row.tlds_checked_at = projection?.receipt?.completedAt || null;
  row.tlds_all_count = projection?.receipt?.totalCount || options.universeCount || null;
  row.tlds_label = exactIsConsistent
    ? projection.extensionsLabel
    : (row.tlds_lower_bound != null
      ? `At least ${row.tlds_lower_bound} extensions observed; full-universe verification pending`
      : (projection?.extensionsLabel || 'Extension coverage pending'));
  row.tlds_source = projection?.receipt
    ? `nameverse:${projection.receipt.universeVersion || 'legacy'}`
    : (options.defaultSource || null);

  if (options.includeCoverage !== false) row.tlds_coverage = projection?.receipt || null;
  else delete row.tlds_coverage;
  return row;
}

function applyAccessibleZoneProjection(row, coverage) {
  const exact = finiteNonNegative(row?.tlds_taken) || 0;
  const total = finiteNonNegative(coverage?.total_tlds);
  row.tlds_taken = exact;
  row.tlds_lower_bound = null;
  row.tlds_verified = true;
  row.tlds_sort_value = exact;
  row.tlds_checked_at = coverage?.last_finished_at || coverage?.updated_at || null;
  row.tlds_all_count = total;
  row.tlds_label = `${exact} of ${total ?? 'all'} accessible CZDS zones`;
  row.tlds_source = 'czds:complete-accessible-prefix-corpus';
  delete row.tlds_coverage;
  return row;
}

function compareResearchNames(a, b, direction = 'DESC') {
  const aCount = researchExtensionCount(a);
  const bCount = researchExtensionCount(b);
  const multiplier = String(direction).toUpperCase() === 'ASC' ? 1 : -1;
  if (aCount != null && bCount != null && aCount !== bCount) return (aCount - bCount) * multiplier;
  if (aCount != null && bCount == null) return -1;
  if (aCount == null && bCount != null) return 1;
  return String(a?.base_name || '').localeCompare(String(b?.base_name || ''));
}

module.exports = {
  applyAccessibleZoneProjection,
  applyExtensionProjection,
  compareResearchNames,
  researchExtensionCount,
};
