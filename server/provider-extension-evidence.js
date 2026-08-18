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

function hydrateProviderExtensionEvidence(database, rows, universe, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const batchSize = Math.max(1, Math.min(900, Number(options.batchSize) || 900));
  const bases = [...new Set(rows.map(row => row.base_name || baseNameFromDomain(row.domain)).filter(Boolean))];
  const baseSet = new Set(bases);
  const lowerBounds = new Map();
  const exactCounts = new Map();
  const scanThreshold = Math.max(1, Number(options.scanThreshold) || 20_000);

  // Large immutable inventories are faster as one covering-index pass. Hundreds of
  // thousands of random PK probes caused minutes of disk seeking on laptops. Counts
  // from this path remain lower bounds; exactness is never inferred without a current
  // complete receipt.
  if (bases.length >= scanThreshold) {
    for (const row of database.prepare(`
      SELECT base_name, tld_count
      FROM base_tld_counts INDEXED BY idx_base_tld_counts_count
      WHERE tld_count > 1
    `).iterate()) {
      if (baseSet.has(row.base_name)) lowerBounds.set(row.base_name, Math.max(0, Number(row.tld_count) || 0));
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
      lowerBounds.set(row.base_name, Math.max(0, Number(row.tld_count) || 0));
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
      const receiptLowerBound = Number(projection.extensionsLowerBound) || 0;
      if (receiptLowerBound > 0) {
        lowerBounds.set(row.base_name, Math.max(lowerBounds.get(row.base_name) || 0, receiptLowerBound));
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
    // Every inventory row itself proves its source TLD. base_tld_counts can contain
    // exact or partial observations, so without a current complete receipt it is
    // deliberately published only as a lower bound.
    const priorVerifiedCount = row.tlds_verified === true ? (Number(row.tlds_taken) || 0) : 0;
    row.tlds_taken = null;
    row.tlds_lower_bound = Math.max(
      1,
      priorVerifiedCount,
      Number(row.tlds_lower_bound) || 0,
      lowerBounds.get(baseName) || 0,
    );
    row.tlds_verified = false;
  }
  return rows;
}

module.exports = { baseNameFromDomain, hydrateProviderExtensionEvidence };
