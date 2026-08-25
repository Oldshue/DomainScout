'use strict';

const { projectCoverageReceipt } = require('./nameverse-coverage');

// Provider-neutral projection from shared extension evidence into immutable inventory
// rows. The work runs while a snapshot is being prepared, never while a user filters
// it. This keeps provider workers database-free and makes Min Extensions a cheap scan.
function baseNameFromDomain(domain) {
  const value = String(domain || '').toLowerCase();
  const dot = value.lastIndexOf('.');
  return dot > 0 ? value.slice(0, dot) : value;
}

function normalizeMaterializedTlds(...values) {
  const normalized = new Set();
  const add = value => {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (value && typeof value === 'object') {
      add(value.tld);
      return;
    }
    for (const item of String(value || '').split(',')) {
      const clean = item.trim().toLowerCase().replace(/^\./, '');
      if (/^[a-z0-9-]+$/.test(clean)) normalized.add(`.${clean}`);
    }
  };
  for (const value of values) add(value);
  return [...normalized].sort();
}

// Project the concrete extension observations carried by a row. Cardinality and
// whole-root completeness are intentionally separate: the former is always safe
// to render because every counted item is present in the accompanying list.
function materializeExtensionEvidence(row, options = {}) {
  const coverage = options.coverage || row?.tlds_coverage || null;
  const selectedTaken = (row?.taken_in_evidence || [])
    .filter(item => item?.status === 'taken')
    .map(item => item.tld);
  const sourceTld = Number(row?.registration_available) === 1 ? null : row?.tld;
  const tlds = normalizeMaterializedTlds(
    options.indexedTlds,
    options.receiptTlds,
    row?.tld_list,
    row?.tlds_list,
    coverage?.positives,
    selectedTaken,
    sourceTld,
  );

  row.tld_list = tlds;
  row.tlds_taken = tlds.length;
  row.tlds_lower_bound = null;
  row.tlds_materialized = true;
  return row;
}

function hydrateProviderExtensionEvidence(database, rows, universe, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const batchSize = Math.max(1, Math.min(900, Number(options.batchSize) || 900));
  const bases = [...new Set(rows.map(row => row.base_name || baseNameFromDomain(row.domain)).filter(Boolean))];
  const baseSet = new Set(bases);
  const materializedCounts = new Map();
  const exactCounts = new Map();
  const scanThreshold = Math.max(1, Number(options.scanThreshold) || 20_000);

  // Large immutable inventories are faster as one covering-index pass. Hundreds of
  // thousands of random PK probes caused minutes of disk seeking on laptops. This
  // stores the cardinality projection; page hydration attaches its concrete members.
  if (bases.length >= scanThreshold) {
    for (const row of database.prepare(`
      SELECT base_name, tld_count
      FROM base_tld_counts INDEXED BY idx_base_tld_counts_count
      WHERE tld_count > 1
    `).iterate()) {
      if (baseSet.has(row.base_name)) materializedCounts.set(row.base_name, Math.max(0, Number(row.tld_count) || 0));
    }
  }

  for (let offset = 0; bases.length < scanThreshold && offset < bases.length; offset += batchSize) {
    const batch = bases.slice(offset, offset + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    for (const row of database.prepare(`
      SELECT base_name, tld_count
      FROM base_tld_counts
      WHERE base_name IN (${placeholders})
    `).all(...batch)) {
      materializedCounts.set(row.base_name, Math.max(0, Number(row.tld_count) || 0));
    }

    if (!universe?.authoritative || !universe.id || !universe.version || !universe.count) continue;
    for (const row of database.prepare(`
      SELECT *
      FROM tld_check_cache
      WHERE universe_id = ?
        AND universe_version = ?
        AND checked_count = total_count
        AND total_count = ?
        AND coverage_status = 'complete'
        AND failures_json = '[]'
        AND base_name IN (${placeholders})
    `).all(universe.id, universe.version, universe.count, ...batch)) {
      const projection = projectCoverageReceipt(row, universe, options);
      const receiptCount = Math.max(0, Number(projection.extensions ?? projection.extensionsLowerBound) || 0);
      if (receiptCount > 0) {
        materializedCounts.set(row.base_name, Math.max(materializedCounts.get(row.base_name) || 0, receiptCount));
      }
      if (projection.verified) {
        exactCounts.set(row.base_name, {
          count: Math.max(0, Number(projection.extensions) || 0),
          checkedAt: projection.receipt?.completedAt || null,
        });
      }
    }
  }

  for (const row of rows) {
    const baseName = row.base_name || baseNameFromDomain(row.domain);
    const exact = exactCounts.get(baseName);
    if (exact) {
      row.tlds_taken = exact.count;
      row.tlds_lower_bound = null;
      row.tlds_verified = true;
      row.tlds_checked_at = exact.checkedAt;
      continue;
    }
    // base_tld_counts is the pre-materialized cardinality used by immutable provider
    // snapshots. The page projection attaches the matching concrete list before the
    // row reaches the browser; this numeric value keeps sorting/filtering database-free.
    const sourceCount = Number(row.registration_available) === 1 ? 0 : 1;
    row.tlds_taken = Math.max(
      sourceCount,
      Number(row.tlds_taken) || 0,
      materializedCounts.get(baseName) || 0,
    );
    row.tlds_lower_bound = null;
    row.tlds_verified = false;
    row.tlds_materialized_count = true;
  }
  return rows;
}

module.exports = {
  baseNameFromDomain,
  hydrateProviderExtensionEvidence,
  materializeExtensionEvidence,
  normalizeMaterializedTlds,
};
