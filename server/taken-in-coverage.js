'use strict';

/**
 * server/taken-in-coverage.js
 *
 * Pure, side-effect-free helpers for authoritative sibling-TLD coverage
 * receipts used by the /api/domains "takenIn" facet.
 *
 * Truth contract:
 * A sibling-TLD target is authoritative-complete only when
 * zi.zone_indexed_tlds has that exact bare TLD with record_count > 0 and a
 * valid file_date no older than maxAgeMs (default 48 hours) at request time.
 * Missing, stale, malformed, or unattached zone evidence is incomplete.
 *
 * DNS cache, domains rows, sibling_tld_status, and cctld_taken_idx are
 * known-positive/partial evidence only and NEVER prove complete negative
 * coverage. They are not consulted here; this module only reasons about
 * czds zone-index rows supplied by the caller.
 */

const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Normalize a requested takenInMatch value to 'all' or 'any'.
 * Defaults to 'all' for anything missing/unrecognized.
 * @param {*} value
 * @returns {'all'|'any'}
 */
function normalizeTakenInMatch(value) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'any') return 'any';
    if (normalized === 'all') return 'all';
  }
  return 'all';
}

/**
 * Normalize a single TLD: strip leading dot(s), lowercase, trim.
 * @param {*} tld
 * @returns {string|null}
 */
function normalizeTld(tld) {
  if (typeof tld !== 'string') return null;
  let normalized = tld.trim().toLowerCase();
  while (normalized.startsWith('.')) {
    normalized = normalized.slice(1);
  }
  normalized = normalized.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalize a list of target TLDs into a stable, sorted, deduplicated array
 * of bare lowercase TLDs.
 * @param {*} targetTlds
 * @returns {string[]}
 */
function normalizeTargetTlds(targetTlds) {
  const set = new Set();
  const source = Array.isArray(targetTlds) ? targetTlds : [];
  for (const raw of source) {
    const normalized = normalizeTld(raw);
    if (normalized) set.add(normalized);
  }
  return Array.from(set).sort();
}

/**
 * Validate a zone file_date is a real, non-future timestamp no older than
 * maxAgeMs relative to nowMs. Malformed dates (unparseable, non-string,
 * NaN) are treated as invalid (not authoritative).
 * @param {*} fileDate
 * @param {number} nowMs
 * @param {number} maxAgeMs
 * @returns {boolean}
 */
function isFreshFileDate(fileDate, nowMs, maxAgeMs) {
  if (fileDate === null || fileDate === undefined || fileDate === '') return false;
  const parsed = new Date(fileDate).getTime();
  if (!Number.isFinite(parsed)) return false;
  if (parsed > nowMs) return false;
  const ageMs = nowMs - parsed;
  if (ageMs < 0) return false;
  return ageMs <= maxAgeMs;
}

/**
 * Build an authoritative sibling-TLD coverage receipt from zone-index rows.
 *
 * @param {Object} opts
 * @param {string[]} opts.targetTlds - requested sibling TLD targets.
 * @param {Array<{tld: string, record_count: *, file_date: *}>} opts.zoneRows
 *   - rows queried from zi.zone_indexed_tlds restricted to the requested
 *   targets (caller is responsible for scoping the query).
 * @param {number} [opts.nowMs] - request time in epoch ms.
 * @param {number} [opts.maxAgeMs] - max allowed zone-file age in ms
 *   (default 48 hours).
 * @returns {Object} stable structured receipt.
 */
function buildAuthoritativeSiblingCoverage(opts) {
  const options = opts || {};
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const targetTlds = normalizeTargetTlds(options.targetTlds);

  const rowsByTld = new Map();
  const zoneRows = Array.isArray(options.zoneRows) ? options.zoneRows : [];
  for (const row of zoneRows) {
    if (!row) continue;
    const normalizedTld = normalizeTld(row.tld);
    if (!normalizedTld) continue;
    rowsByTld.set(normalizedTld, row);
  }

  const coveredTlds = [];
  const missingTlds = [];
  const staleTlds = [];
  const fileDates = {};

  for (const tld of targetTlds) {
    const row = rowsByTld.get(tld);

    if (!row) {
      missingTlds.push(tld);
      continue;
    }

    fileDates[tld] = row.file_date === undefined ? null : row.file_date;

    const recordCount = Number(row.record_count);
    const hasRecords = Number.isFinite(recordCount) && recordCount > 0;

    if (!hasRecords) {
      missingTlds.push(tld);
      continue;
    }

    if (!isFreshFileDate(row.file_date, nowMs, maxAgeMs)) {
      staleTlds.push(tld);
      continue;
    }

    coveredTlds.push(tld);
  }

  coveredTlds.sort();
  missingTlds.sort();
  staleTlds.sort();

  const complete =
    targetTlds.length > 0 &&
    missingTlds.length === 0 &&
    staleTlds.length === 0 &&
    coveredTlds.length === targetTlds.length;

  const status = complete ? 'complete' : 'evidence-gap';

  let action = null;
  if (!complete) {
    action = missingTlds.length > 0 ? 'request-zone-access' : 'refresh';
  }

  return {
    complete,
    status,
    targetTlds,
    coveredTlds,
    missingTlds,
    staleTlds,
    fileDates,
    maxAgeMs,
    evidence: 'czds-zone-index',
    retryable: !complete,
    action,
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  normalizeTakenInMatch,
  normalizeTargetTlds,
  buildAuthoritativeSiblingCoverage,
};
