'use strict';

// Corpus-derived repeated strings: no seed vocabulary or dictionary admission.
// Apriori pruning bounds expansion to substrings already supported by distinct
// labels. A mirrored label on many extensions contributes one independent label.
function discoverFragments(names, { minSupport = 4, maxLength = 63, maxNames = 1000000 } = {}) {
  const labels = [...new Set(names)].sort();
  if (labels.length > maxNames) throw new Error('Corpus exceeds fragment analysis bound');
  let prior = null;
  const accepted = new Map();
  for (let length = 2; length <= maxLength; length++) {
    const counts = new Map();
    for (const label of labels) {
      const seen = new Set();
      for (let i = 0; i + length <= label.length; i++) {
        const token = label.slice(i, i + length);
        if (prior && (!prior.has(token.slice(0, -1)) || !prior.has(token.slice(1)))) continue;
        seen.add(token);
      }
      for (const token of seen) counts.set(token, (counts.get(token) || 0) + 1);
    }
    prior = new Map([...counts].filter(([, count]) => count >= minSupport));
    for (const [token, count] of prior) accepted.set(token, count);
    if (!prior.size) break;
  }
  // Remove nested fragments whose support is almost entirely explained by a
  // longer string. This suppresses repeated truncations without a word list.
  const suppressed = new Set();
  for (const [token, count] of accepted) {
    for (const shorter of [token.slice(1), token.slice(0, -1)]) {
      if (accepted.has(shorter) && count >= accepted.get(shorter) * 0.7) suppressed.add(shorter);
    }
  }
  const contexts = new Map([...accepted].filter(([token]) => !suppressed.has(token)).map(([token]) => [token, new Set()]));
  for (const label of labels) {
    for (let length = 2; length <= maxLength; length++) {
      for (let i = 0; i + length <= label.length; i++) {
        const token = label.slice(i, i + length), set = contexts.get(token);
        if (set) set.add((label.slice(0, i) + '|' + label.slice(i + length)).replace(/[0-9]+/g, '#'));
      }
    }
  }
  return [...accepted].map(([token, count]) => ({ token, count, visible: !suppressed.has(token), contexts: contexts.get(token)?.size || 0 }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
}

function ensureFragmentSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS zone_daily_fragments (
    tld TEXT NOT NULL, report_date TEXT NOT NULL, token TEXT NOT NULL,
    reg_count INTEGER NOT NULL, visible INTEGER NOT NULL, contexts INTEGER NOT NULL, PRIMARY KEY(tld, report_date, token)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_daily_fragments_date ON zone_daily_fragments(report_date,tld,reg_count DESC);`);
}
module.exports = { discoverFragments, ensureFragmentSchema };
