'use strict';

// Adapts the Sale Watch likely-sale ledger into the same label\tzone\twindow_start
// tape shape the vendored registration-universe engine (mine-universe-types.py +
// theme-convergence.py) already consumes for `source=registrations`, plus
// per-theme buyer-independence stats computed from the engine's member list.
// This module never reimplements the engine's convergence/kit-collapse scoring;
// it only supplies the engine's input for `source=sales` and reshapes its
// sales-specific, buyer-facing output. server/universe-themes.js is the only
// caller; it owns span selection, persistence and the HTTP surface.

const DOMAIN_LABEL_RE = /^[a-z0-9-]{1,63}$/;

// A ledger row counts as a likely sale for theme-convergence purposes only
// when its tier is verified/probable/suspected AND its classification is not
// a single-actor bulk-adoption ("platform") row and not an owner migrating
// their own name to a new registrar (owner-migration is already tier=excluded
// upstream in server/sale-watch-evidence.js; the classification check here is
// kept as a defensive, explicit second gate). This never admits tier=transfer
// (transfer-only, registry transfer observed but no independent sale
// footprint) or tier=excluded rows (expiration, registry-hold, lander
// migration, owner-migration).
const ADMITTED_TIERS = new Set(['verified', 'probable', 'suspected']);
const EXCLUDED_CLASSIFICATIONS = new Set(['portfolio-kit', 'owner-migration']);

function isLikelySaleEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!ADMITTED_TIERS.has(entry.tier)) return false;
  if (EXCLUDED_CLASSIFICATIONS.has(entry.classification)) return false;
  return true;
}

function reportDay(entry) {
  return String(entry?.reportDate || '').slice(0, 10);
}

// Selects likely-sale entries whose report date falls in [from, to]
// (inclusive, lexical YYYY-MM-DD comparison). The same function selects both
// the current span and the reference span -- callers pass the appropriate
// [from, to] pair for each.
function likelySalesInSpan(entries, from, to) {
  const out = [];
  for (const entry of entries || []) {
    if (!isLikelySaleEntry(entry)) continue;
    const day = reportDay(entry);
    if (!day || day < from || day > to) continue;
    out.push(entry);
  }
  return out;
}

function domainParts(domain) {
  const value = String(domain || '').trim().toLowerCase();
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const label = value.slice(0, dot);
  const zone = value.slice(dot + 1);
  if (!DOMAIN_LABEL_RE.test(label) || !zone) return null;
  return { label, zone };
}

// Builds the tape/adds.tsv text (label\tzone\treportDate) the vendored engine
// reads, plus a label -> ledger-entry metadata map so the JS layer can attach
// buyer/tier/example fields the python engine itself does not carry. If two
// admitted entries share one exact label (rare: same label under different
// zones, or a re-reported row), the metadata map keeps whichever has the
// later reportDate; every admitted entry still contributes its own tape row.
function buildSalesTape(entries) {
  const lines = [];
  const metaByLabel = new Map();
  for (const entry of entries) {
    const parts = domainParts(entry.domain);
    if (!parts) continue;
    const { label, zone } = parts;
    const day = reportDay(entry);
    lines.push(`${label}\t${zone}\t${day}`);
    const existing = metaByLabel.get(label);
    if (!existing || day >= reportDay(existing)) metaByLabel.set(label, entry);
  }
  return { tapeText: lines.length ? `${lines.join('\n')}\n` : '', metaByLabel };
}

// A destination "buyer" signature: the sorted, lowercased buyer-nameserver
// set. An entry with no recorded buyer nameservers is never lumped in with
// any other undocumented-destination entry -- each such entry gets its own
// solo signature keyed by its domain, so buyer-set breadth is never
// overstated for unattributed destinations.
function buyerSignature(entry) {
  const ns = Array.isArray(entry?.buyerNameservers) ? entry.buyerNameservers : [];
  const normalized = ns.map(v => String(v || '').trim().toLowerCase()).filter(Boolean).sort();
  if (!normalized.length) return `solo:${String(entry?.domain || '').toLowerCase()}`;
  return normalized.join(',');
}

function isBuiltEntry(entry) {
  return entry?.assessment?.buyerUse === true;
}

// Gini-Simpson diversity (1 - sum(share^2)) over a theme's distinct buyer
// signatures. 0 when every member shares one destination set, however many
// members there are; approaches 1 as membership spreads across many
// similarly sized, independent destinations. This is the axis that must
// outrank raw member count when ranking `source=sales` themes.
function buyerIndependence(buyerCounts, total) {
  if (!total) return 0;
  let sumSquares = 0;
  for (const count of buyerCounts.values()) {
    const share = count / total;
    sumSquares += share * share;
  }
  return Math.max(0, Math.min(1, 1 - sumSquares));
}

// Computes buyers/topBuyerShare/builtCount/buyerIndependence for one theme's
// full (uncapped) kit-collapsed member list, using the label -> ledger-entry
// metadata the sales tape builder recorded. Members without a recognized
// metadata row are skipped (should not occur for a sales-sourced tape, since
// every tape row comes from an admitted entry with a resolvable label).
function computeThemeBuyerStats(members, metaByLabel) {
  const buyerCounts = new Map();
  let total = 0;
  let builtCount = 0;
  for (const label of members || []) {
    const entry = metaByLabel.get(label);
    if (!entry) continue;
    total += 1;
    const sig = buyerSignature(entry);
    buyerCounts.set(sig, (buyerCounts.get(sig) || 0) + 1);
    if (isBuiltEntry(entry)) builtCount += 1;
  }
  const buyers = buyerCounts.size;
  const topBuyerShare = total ? Math.max(...buyerCounts.values()) / total : 0;
  return {
    buyers,
    topBuyerShare: Math.round(topBuyerShare * 1000) / 1000,
    builtCount,
    buyerIndependence: Math.round(buyerIndependence(buyerCounts, total) * 1000) / 1000,
  };
}

// Provider labels for an example row's fromProvider/toProvider display
// fields. Uses the entry's own observed registrar transfer
// (assessment.transfer), computed once already by server/sale-watch-evidence.js;
// falls back to null rather than guessing a provider that was never observed.
function providerFields(entry) {
  const transfer = entry?.assessment?.transfer || {};
  return {
    fromProvider: transfer.fromRegistrar || null,
    toProvider: transfer.toRegistrar || null,
  };
}

// Builds one sales-source example row for display:
// { label, zones, reportDate, tier, fromProvider, toProvider, buyerTitle }.
// `zonesForLabel` comes from the shared labelIndex the engine's span builder
// already produces for both sources.
function buildSalesExample(label, zonesForLabel, metaByLabel) {
  const entry = metaByLabel.get(label);
  if (!entry) return null;
  const { fromProvider, toProvider } = providerFields(entry);
  return {
    label,
    zones: zonesForLabel || [],
    reportDate: entry.reportDate || null,
    tier: entry.tier,
    fromProvider,
    toProvider,
    buyerTitle: entry.buyerTitle || null,
  };
}

module.exports = {
  isLikelySaleEntry,
  likelySalesInSpan,
  domainParts,
  buildSalesTape,
  buyerSignature,
  isBuiltEntry,
  buyerIndependence,
  computeThemeBuyerStats,
  providerFields,
  buildSalesExample,
  reportDay,
};
