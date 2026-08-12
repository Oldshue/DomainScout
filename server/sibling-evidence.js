'use strict';

const EVIDENCE_STATUSES = new Set(['taken', 'not_taken', 'unknown']);

function normalizeEvidenceTld(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/^\.+/, '');
  return /^[a-z0-9-]{2,63}$/.test(clean) ? `.${clean}` : null;
}

function domainBaseName(domain) {
  const value = String(domain || '').trim().toLowerCase();
  const dot = value.indexOf('.');
  return dot === -1 ? value : value.slice(0, dot);
}

function buildExplicitSiblingEvidence(row, { tlds, sets, coverageComplete }) {
  const base = domainBaseName(row?.domain);
  return tlds.map((rawTld, index) => {
    const tld = normalizeEvidenceTld(rawTld);
    if (!tld) throw new Error('invalid-sibling-evidence-tld');
    const isTaken = sets[index] instanceof Set && sets[index].has(base);
    return {
      tld,
      status: isTaken ? 'taken' : (coverageComplete ? 'not_taken' : 'unknown'),
    };
  });
}

function normalizeExplicitSiblingEvidence(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [];
  const seen = new Set();
  for (const record of value) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (Object.getPrototypeOf(record) !== Object.prototype) return null;
    if (Object.keys(record).sort().join(',') !== 'status,tld') return null;
    const tld = normalizeEvidenceTld(record.tld);
    if (!tld || seen.has(tld) || !EVIDENCE_STATUSES.has(record.status)) return null;
    seen.add(tld);
    normalized.push({ tld, status: record.status });
  }
  return normalized;
}

function rowMatchesExplicitSiblingEvidence(row, { tlds, mode = 'taken', match = 'all' }) {
  const targets = [...new Set((tlds || []).map(normalizeEvidenceTld).filter(Boolean))];
  if (!targets.length) return true;
  const records = normalizeExplicitSiblingEvidence(row?.taken_in_evidence);
  if (!records) return false;
  const byTld = new Map(records.map(record => [record.tld, record.status]));
  if (!targets.every(tld => byTld.has(tld))) return false;
  if (mode === 'any') return targets.every(tld => byTld.get(tld) !== 'unknown');
  const expected = mode === 'not_taken' ? 'not_taken' : 'taken';
  const matches = targets.map(tld => byTld.get(tld) === expected);
  return match === 'any' ? matches.some(Boolean) : matches.every(Boolean);
}

module.exports = {
  buildExplicitSiblingEvidence,
  normalizeExplicitSiblingEvidence,
  rowMatchesExplicitSiblingEvidence,
};
