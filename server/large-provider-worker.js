'use strict';

const { parentPort } = require('worker_threads');
require('./provider-snapshot-registry');
const { readLargeProviderSnapshotIndex } = require('./large-provider-snapshot');
const { buildPageFromIndex } = require('./godaddy-query');
const { buildExplicitSiblingEvidence } = require('./sibling-evidence');

// Selected-TLD positives are tiny compared with million-row provider snapshots.
// Cache a compact, snapshot-bound projection of only matching tuples after the first
// complete verification. Subsequent filters/sorts scan hundreds of matches rather
// than the entire board. The revision includes provider generation + completed scan,
// so evidence can never leak across snapshots or an updated verification run.
const siblingProjectionCache = new Map();

function projectedIndex(index, evidence, revision, match) {
  if (!evidence || !revision || !Array.isArray(index.compactRows)) return index;
  const key = `${index.stream}\0${index.generatedAt || ''}\0${revision}\0${match}`;
  const cached = siblingProjectionCache.get(key);
  if (cached) return cached;
  const domainColumn = index.compactColumnIndex.domain;
  const sets = evidence.sets;
  const rows = index.compactRows.filter(tuple => {
    const domain = String(tuple[domainColumn] || '').toLowerCase();
    const dot = domain.indexOf('.');
    const base = dot === -1 ? domain : domain.slice(0, dot);
    const matches = sets.map(set => set.has(base));
    return match === 'any' ? matches.some(Boolean) : matches.every(Boolean);
  });
  const projection = { ...index, compactRows: rows, count: rows.length };
  if (siblingProjectionCache.size >= 24) siblingProjectionCache.delete(siblingProjectionCache.keys().next().value);
  siblingProjectionCache.set(key, projection);
  return projection;
}

parentPort.on('message', (msg) => {
  const { id } = msg || {};
  try {
    const index = readLargeProviderSnapshotIndex(msg.stream);
    if (!index) {
      parentPort.postMessage({ id, ok: true, missing: true });
      return;
    }
    const evidence = msg.takenInEvidence && Array.isArray(msg.takenInEvidence.tlds)
      ? {
          tlds: msg.takenInEvidence.tlds,
          sets: msg.takenInEvidence.tlds.map(tld => new Set(msg.takenInEvidence.baseNamesByTld?.[tld] || [])),
          baseMetadata: msg.takenInEvidence.baseMetadata || {},
          coverageComplete: msg.takenInEvidence.coverageComplete === true,
        }
      : null;
    const queryIndex = evidence && String(msg.query?.takenInMode || 'taken').toLowerCase() === 'taken'
      ? projectedIndex(index, evidence, msg.takenInEvidence?.revision, String(msg.query?.takenInMatch || 'all').toLowerCase())
      : index;
    const { total, pageRows, generatedAt } = buildPageFromIndex(queryIndex, msg.query, {
      sortBy: msg.sortBy,
      sortDir: msg.sortDir,
      pageNum: msg.pageNum,
      limitNum: msg.limitNum,
      dateWindow: msg.dateWindow,
      dateFilterIgnoredReason: msg.dateFilterIgnoredReason,
      overrides: msg.overrides,
      nowMs: msg.nowMs,
      maxAgeMs: msg.maxAgeMs,
      takenInBaseSets: evidence?.sets || null,
      sortValuesByBase: msg.sortBy === 'tlds_taken' && evidence
        ? Object.fromEntries(Object.entries(evidence.baseMetadata).map(([base, metadata]) => [base, metadata.tldsTaken]))
        : null,
    });
    const outputRows = evidence ? pageRows.map(row => {
      const domain = String(row.domain || '');
      const dot = domain.indexOf('.');
      const base = (dot === -1 ? domain : domain.slice(0, dot)).toLowerCase();
      const takenCount = evidence.sets.reduce((count, set) => count + (set.has(base) ? 1 : 0), 0);
      const metadata = evidence.baseMetadata[base] || null;
      return {
        ...row,
        tlds_taken: metadata?.tldsTaken ?? row.tlds_taken ?? null,
        tlds_checked_at: metadata?.tldsCheckedAt ?? null,
        tlds_verified: Boolean(metadata),
        tlds_all_count: metadata?.tldsAllCount ?? null,
        tlds_source: metadata?.tldsSource ?? null,
        taken_in_count: takenCount,
        taken_in_checked_count: takenCount,
        taken_in_evidence: buildExplicitSiblingEvidence(row, evidence),
      };
    }) : pageRows;
    parentPort.postMessage({ id, ok: true, total, pageRows: outputRows, generatedAt, takenInTlds: evidence?.tlds || null });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message || error).slice(0, 1000) });
  }
});
