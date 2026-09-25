'use strict';

// Adapts the FULL Sale Watch candidate tape into the same label\tzone\twindow_start
// tape shape the vendored universe engine (mine-universe-types.py +
// theme-convergence.py) already consumes, for GET /api/universe/themes?source=candidates.
//
// Why this exists next to server/sale-watch-theme-source.js: that adapter feeds the
// engine the Sale Watch LEDGER (the small adjudicated subset, tens to a few hundred
// rows). This adapter feeds it the candidate tape underneath the ledger --
// readSaleWatchCandidates() in server/sale-watch-candidates.js -- which for a
// three-day window holds thousands of built candidates (tens of thousands eligible).
// No caller can read that many rows, so theme convergence over the whole tape has to
// be computed server-side; that is the entire point of source=candidates.
//
// This module is a READER/ADAPTER ONLY:
//   - it owns no classifier. Platform/parking-batch and expiry exclusions, the owner
//     signal policy, the candidate-state gate and the built/siteClass derivation are
//     all already applied by readSaleWatchCandidates (and, before it, at ingest).
//   - it never reimplements the engine's convergence/kit-collapse scoring. It only
//     supplies the engine's input and reshapes its output into buyer-facing fields.
//   - it performs no I/O of its own: the caller injects a loader, which in the cloud
//     deployment is the SAME off-main read lane the /api/sale-watch/candidates route
//     uses ('sale-watch.candidates' on the 'sale-watch' db-read worker lane), so a
//     theme computation can never block the event loop or the main writer.
//
// Independence is a BUYER, not a name. The reader already reports, window-wide, every
// destination nameserver set taking >= BATCH_MIN_NAMES names (`batches`). Those sets
// are one actor moving a block, so they are excluded from a theme's independentBuyers
// count while their names are still listed under the theme and the collapsed batches
// are reported explicitly. A theme that is one actor's kit therefore cannot outrank a
// theme several independent buyers converge on.

const crypto = require('crypto');
const { nsSetKey } = require('./nameserver-classes');
const { MAX_LIMIT: CANDIDATE_MAX_LIMIT, BATCH_MIN_NAMES } = require('./sale-watch-candidates');

const DOMAIN_LABEL_RE = /^[a-z0-9-]{1,63}$/;

// Vocabulary the candidate tape needs the vendored segmenter to recognize as whole
// tokens. The segmenter's dictionary (server/assets/common-english.txt + the miner's
// own EXTRA/CITIES sets) is a general word list, and an unrecognized term is not
// merely unranked -- it is MIS-SEGMENTED, so its theme never exists at all
// (observed: 'longevity' tokenizes as long|ev|? and 'longevityclinic' as
// long|ev|?|clinic, so no 'longevity' theme can ever form). Domain meaning lives
// here, in the vertical adapter: scripts/universe/theme-convergence.py takes this
// list through its generic, default-empty `extraWords` option and carries no
// vocabulary of its own for any particular input.
const SALE_TAPE_VOCABULARY = Object.freeze([
  'longevity', 'peptide', 'peptides', 'telehealth', 'microbiome', 'nootropic',
  'nootropics', 'creatine', 'sauna', 'cryotherapy', 'pickleball', 'padel',
  'dispensary', 'doula', 'montessori', 'homestead', 'sourdough',
  'fintech', 'proptech', 'insurtech', 'healthtech', 'climatetech', 'biotech',
  'neobank', 'stablecoin', 'tokenized', 'custody', 'underwriting', 'remittance',
  'inference', 'embeddings', 'guardrails', 'observability', 'telemetry',
  'kubernetes', 'serverless', 'datacenter', 'lidar', 'heatpump', 'microgrid',
  'electrolyzer', 'geothermal', 'desalination', 'traceability', 'provenance',
  'onboarding', 'compliance', 'workflow', 'scheduling', 'dispatch', 'logistics',
]);

// Bounded resources: the tape is paged with the reader's own cursor (never OFFSET),
// and paging stops at these ceilings with `truncated: true` recorded in coverage
// rather than silently analysing a partial tape as if it were whole.
const TAPE_PAGE_LIMIT = CANDIDATE_MAX_LIMIT;
const MAX_TAPE_PAGES = 60;
const MAX_TAPE_ROWS = 60000;

// Default input is BUILT candidates: probed, and the probe found an operating site
// (row.built === true, derived by the reader from stored homepage/buyerUse evidence).
// builtOnly=false widens the input to every eligible candidate in the window,
// including unprobed ones.
function builtFilterFor(builtOnly) {
  return builtOnly === false ? null : true;
}

// The exact params handed to the reader for one page. from/to/q/tld/built are held
// constant across every page of one span because the reader binds its cursor to a
// digest of precisely those fields: changing any of them mid-walk is rejected rather
// than silently paging a different query's result set.
function pageParams({ from, to, builtOnly, limit, cursor }) {
  const params = {
    from,
    to,
    built: builtFilterFor(builtOnly),
    limit: Math.max(1, Math.min(TAPE_PAGE_LIMIT, Number(limit) || TAPE_PAGE_LIMIT)),
  };
  if (cursor) params.cursor = cursor;
  return params;
}

function assertTape(tape) {
  if (!tape || typeof tape !== 'object' || !Array.isArray(tape.rows)) {
    const error = new Error('Sale Watch candidate reader returned no tape');
    error.statusCode = 503;
    throw error;
  }
  return tape;
}

// A single cheap probe of one span: limit=1. The reader computes `coverage`,
// `batches` and `matched` from the FULL window census before any paging, so a
// one-row page carries the complete window-wide facts this module needs for the
// cache's input digest -- without reading thousands of rows on the request thread.
async function probeCandidateSpan(loader, { from, to, builtOnly }) {
  const tape = assertTape(await loader(pageParams({ from, to, builtOnly, limit: 1 })));
  return {
    coverage: tape.coverage || null,
    batches: Array.isArray(tape.batches) ? tape.batches : [],
    batchThreshold: tape.batchThreshold === undefined ? BATCH_MIN_NAMES : tape.batchThreshold,
    matched: Number(tape.matched) || 0,
  };
}

// Walks EVERY row of one span through the reader's cursor. Returns the rows plus the
// window-wide batch/coverage facts from the first page.
async function readCandidateSpan(loader, { from, to, builtOnly }) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let truncated = false;
  let first = null;
  do {
    const tape = assertTape(await loader(pageParams({ from, to, builtOnly, cursor })));
    if (!first) first = tape;
    pages += 1;
    for (const row of tape.rows) {
      if (rows.length >= MAX_TAPE_ROWS) { truncated = true; break; }
      rows.push(row);
    }
    cursor = truncated ? null : (tape.pagination && tape.pagination.nextCursor) || null;
    if (cursor && pages >= MAX_TAPE_PAGES) { truncated = true; cursor = null; }
  } while (cursor);
  return {
    rows,
    pages,
    truncated,
    coverage: (first && first.coverage) || null,
    batches: (first && Array.isArray(first.batches)) ? first.batches : [],
    batchThreshold: first && first.batchThreshold !== undefined ? first.batchThreshold : BATCH_MIN_NAMES,
    matched: Number(first && first.matched) || 0,
  };
}

// The window-wide facts that must invalidate a stored theme result when new ingest
// lands: per-day departure/eligible receipts and cursor completeness, the eligible
// census size, what the ingest receipts excluded and why, the matched count under
// this built filter, and every batch destination set with its window count. Volatile
// fields (generatedAt, the paged rows themselves) are deliberately excluded so an
// unchanged tape digests identically on every read and the cache can actually hit.
function canonicalInputFacts(probe) {
  const coverage = (probe && probe.coverage) || {};
  const excluded = coverage.excludedByReason || {};
  return {
    from: coverage.from === undefined ? null : coverage.from,
    to: coverage.to === undefined ? null : coverage.to,
    eligible: Number(coverage.eligible) || 0,
    eligibleAtIngest: Number(coverage.eligibleAtIngest) || 0,
    departures: Number(coverage.departures) || 0,
    excluded: Object.keys(excluded).sort().map(key => [key, Number(excluded[key]) || 0]),
    matched: Number(probe && probe.matched) || 0,
    days: (coverage.days || []).map(day => [
      String(day.day || ''),
      Number(day.departures) || 0,
      Number(day.eligible) || 0,
      day.cursorComplete === true,
    ]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    batches: ((probe && probe.batches) || []).map(batch => [String(batch.nsKey || ''), Number(batch.count) || 0])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  };
}

// Deterministic short digest of the candidate reader's input for BOTH spans plus the
// built filter. server/universe-themes.js folds this into the cache key and the
// persisted-result path for source=candidates, so newly ingested departures (or a
// flipped builtOnly) invalidate any stored result for the same range instead of
// serving it stale.
function candidatesInputDigest({ builtOnly, current, reference }) {
  const payload = JSON.stringify({
    builtOnly: builtOnly !== false,
    batchThreshold: (current && current.batchThreshold) === undefined ? BATCH_MIN_NAMES : current.batchThreshold,
    current: canonicalInputFacts(current),
    reference: canonicalInputFacts(reference),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function domainParts(domain) {
  const value = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const label = value.slice(0, dot);
  const zone = value.slice(dot + 1);
  if (!DOMAIN_LABEL_RE.test(label) || !zone) return null;
  return { label, zone };
}

// Builds the tape text the engine reads, plus label -> [candidate rows]. Every row of
// a label is kept (two buyers can take the same label in different zones, and buyer
// independence must see both), which is why this is a list and not the single-entry
// map the ledger adapter keeps.
function buildCandidatesTape(rows) {
  const lines = [];
  const rowsByLabel = new Map();
  for (const row of rows || []) {
    const parts = domainParts(row && row.domain);
    if (!parts) continue;
    const day = String((row && row.departureDay) || '').slice(0, 10);
    if (!day) continue;
    lines.push(`${parts.label}\t${parts.zone}\t${day}`);
    let bucket = rowsByLabel.get(parts.label);
    if (!bucket) { bucket = []; rowsByLabel.set(parts.label, bucket); }
    bucket.push(row);
  }
  return { tapeText: lines.length ? `${lines.join('\n')}\n` : '', rowsByLabel };
}

// The destination "buyer" signature of one candidate row: its normalized destination
// nameserver set, exactly as the reader's own cohort/batch accounting keys it.
function destinationKey(row) {
  return nsSetKey((row && row.destinationNameservers) || []);
}

// The set of destination nameserver sets the reader reported as batches for this
// window (>= batchThreshold names). These are excluded from independence counts.
function batchIndex(batches) {
  const byKey = new Map();
  for (const batch of batches || []) {
    const key = String((batch && batch.nsKey) || '');
    if (!key) continue;
    byKey.set(key, {
      nsKey: key,
      destinationNameservers: batch.destinationNameservers || (key ? key.split(',') : []),
      windowCount: Number(batch.count) || 0,
    });
  }
  return byKey;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function exampleRow(row) {
  return {
    domain: row.domain,
    departureDay: row.departureDay || null,
    buyerTitle: row.buyerTitle || null,
    destination: row.destinationNameservers || [],
  };
}

// Picks up to `cap` example rows spread across DIFFERENT independent destinations
// first, so a theme's example evidence visibly demonstrates the independent buyers
// that earned its rank; rows from collapsed batches are appended last and never
// crowd out an independent buyer.
function diversifyCandidateExamples(members, rowsByLabel, batchKeys, cap = 12) {
  const seen = new Set();
  const independent = [];
  const repeats = [];
  const batched = [];
  for (const label of members || []) {
    for (const row of rowsByLabel.get(label) || []) {
      const key = destinationKey(row);
      if (key && batchKeys.has(key)) { batched.push(row); continue; }
      const signature = key || `solo:${String(row.domain || '').toLowerCase()}`;
      if (!seen.has(signature)) { seen.add(signature); independent.push(row); }
      else repeats.push(row);
    }
  }
  const out = [];
  for (const pool of [independent, repeats, batched]) {
    for (const row of pool) {
      if (out.length >= cap) break;
      out.push(row);
    }
    if (out.length >= cap) break;
  }
  return out.slice(0, cap).map(exampleRow);
}

// Per-theme buyer facts over the engine's full (kit-collapsed) member label list:
//   independentBuyers  distinct destination nameserver sets, EXCLUDING every set the
//                      reader reported as a batch for this window
//   names              every candidate domain under the theme (batch names included)
//   builtNames         those whose probe found an operating site
//   batchesCollapsed   each excluded batch set with its names in this theme and its
//                      window-wide count, so the collapse is auditable, not hidden
//   namesWithoutDestination  rows with no recorded destination set; they are never
//                      counted as independent buyers, so independence is never
//                      overstated for an unattributed destination
function computeThemeCandidateStats(members, rowsByLabel, batches) {
  const byKey = batches instanceof Map ? batches : batchIndex(batches);
  const buyers = new Set();
  const names = [];
  const builtNames = [];
  const collapsed = new Map();
  let namesWithoutDestination = 0;
  for (const label of members || []) {
    for (const row of rowsByLabel.get(label) || []) {
      names.push(row.domain);
      if (row.built === true) builtNames.push(row.domain);
      const key = destinationKey(row);
      if (!key) { namesWithoutDestination += 1; continue; }
      const batch = byKey.get(key);
      if (batch) {
        let entry = collapsed.get(key);
        if (!entry) {
          entry = {
            nsKey: key,
            destinationNameservers: batch.destinationNameservers,
            windowCount: batch.windowCount,
            names: [],
          };
          collapsed.set(key, entry);
        }
        entry.names.push(row.domain);
        continue;
      }
      buyers.add(key);
    }
  }
  const batchesCollapsed = [...collapsed.values()]
    .map(entry => ({ ...entry, names: sortedUnique(entry.names), namesInTheme: new Set(entry.names).size }))
    .sort((a, b) => b.namesInTheme - a.namesInTheme || (a.nsKey < b.nsKey ? -1 : 1));
  return {
    independentBuyers: buyers.size,
    names: sortedUnique(names),
    builtNames: sortedUnique(builtNames),
    batchesCollapsed,
    namesWithoutDestination,
  };
}

module.exports = {
  SALE_TAPE_VOCABULARY,
  TAPE_PAGE_LIMIT,
  MAX_TAPE_PAGES,
  MAX_TAPE_ROWS,
  BATCH_MIN_NAMES,
  builtFilterFor,
  pageParams,
  probeCandidateSpan,
  readCandidateSpan,
  canonicalInputFacts,
  candidatesInputDigest,
  domainParts,
  buildCandidatesTape,
  destinationKey,
  batchIndex,
  diversifyCandidateExamples,
  computeThemeCandidateStats,
  exampleRow,
};
