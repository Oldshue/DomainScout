#!/usr/bin/env node

// AgentForge-facing projection for the complete DomainScout candidate helper.
// The source helper performs the expensive fail-closed inventory and nameverse scan.
// This adapter removes repeated per-row receipt objects and extension lists while
// preserving every value the editorial Artifact needs: exact taken count, shared
// 1,437-root receipt, current provider price/bids, end time, and auction identity.
// Keeping the tool receipt bounded prevents the execution transcript from truncating
// before the reasoning model receives the full review pool.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helperPath = process.env.DOMAINSCOUT_CANDIDATE_HELPER || path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'daily-auction-candidates.mjs',
);
const maxCandidates = Math.max(250, Math.min(360, Number(process.env.DOMAINSCOUT_AGENTFORGE_REVIEW_POOL) || 345));
const maxReceiptBytes = Math.max(16_000, Math.min(64_000, Number(process.env.DOMAINSCOUT_AGENTFORGE_MAX_RECEIPT_BYTES) || 18_500));

const run = spawnSync(process.execPath, [helperPath], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  timeout: 30 * 60_000,
  env: { ...process.env, DOMAINSCOUT_FULL_CANDIDATE_RECEIPT: '1' },
});
if (run.status !== 0) {
  const message = String(run.stderr || run.stdout || `candidate helper exited ${run.status}`).trim().slice(-2_000);
  throw new Error(message || 'candidate helper failed without a receipt');
}

const lines = String(run.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
if (!lines.length) throw new Error('candidate helper returned no receipt');
const source = JSON.parse(lines.at(-1));
if (source.status !== 'candidate_pool_ready') throw new Error('candidate helper did not return a ready pool');
if (source.extensionCoverage?.status !== 'complete' ||
    source.extensionCoverage.checkedCount !== source.extensionCoverage.totalCount) {
  throw new Error('candidate helper returned incomplete extension coverage');
}
if (!Array.isArray(source.inventory) || source.inventory.length !== 2 ||
    source.inventory.some(item => item.current !== true || item.serveable !== true)) {
  throw new Error('candidate helper returned an unverified provider inventory');
}

const columnIndex = Object.fromEntries((source.columns || []).map((column, index) => [column, index]));
const requiredColumns = [
  'domain', 'provider', 'heuristicScore', 'tldsTaken', 'ageYears', 'auctionEnd',
  'currentPrice', 'bids', 'auctionUrl', 'extensionCoverage', 'takenExtensions',
];
if (requiredColumns.some(column => !Number.isInteger(columnIndex[column]))) {
  throw new Error('candidate helper columns do not match the projection contract');
}

const tldPriority = { com: 28, ai: 7, net: -20, io: -20 };
function normalizedRow(row) {
  const domain = String(row[columnIndex.domain] || '').toLowerCase();
  const tld = domain.split('.').at(-1);
  const provider = String(row[columnIndex.provider] || '');
  const score = Number(row[columnIndex.heuristicScore]);
  const tldsTaken = Number(row[columnIndex.tldsTaken]);
  const ageYears = Number(row[columnIndex.ageYears]) || 0;
  const endMs = Date.parse(row[columnIndex.auctionEnd]);
  const currentPrice = row[columnIndex.currentPrice] == null ? null : Number(row[columnIndex.currentPrice]);
  const bids = row[columnIndex.bids] == null ? null : Number(row[columnIndex.bids]);
  const auctionUrl = String(row[columnIndex.auctionUrl] || '');
  const coverage = row[columnIndex.extensionCoverage];
  const takenExtensions = row[columnIndex.takenExtensions];
  if (!/^[a-z0-9-]+\.(?:com|ai|net|io)$/.test(domain) || !(tld in tldPriority)) return null;
  if (!['GoDaddy', 'Namecheap'].includes(provider) || !Number.isFinite(score)) return null;
  if (!Number.isInteger(tldsTaken) || tldsTaken < 0 || !Array.isArray(takenExtensions) || takenExtensions.length !== tldsTaken) return null;
  if (coverage?.status !== 'complete' || coverage.checkedCount !== coverage.totalCount) return null;
  if (!Number.isFinite(endMs) || endMs <= Date.now() || endMs % 1000 !== 0) return null;
  if (currentPrice != null && (!Number.isFinite(currentPrice) || currentPrice < 0)) return null;
  if (bids != null && (!Number.isInteger(bids) || bids < 0)) return null;

  let auctionRef = '';
  if (provider === 'GoDaddy') {
    const match = auctionUrl.match(/\/domain-auctions\/[a-z0-9-]+-(\d+)(?:\?|$)/i);
    if (!match) return null;
    auctionRef = match[1];
  } else if (auctionUrl !== `https://www.namecheap.com/market/${domain}`) {
    return null;
  }

  return {
    domain,
    providerCode: provider === 'GoDaddy' ? 'G' : 'N',
    tld,
    heuristicScore: Math.round(score * 10) / 10,
    priority: score + tldPriority[tld],
    tldsTaken,
    ageYears,
    auctionEnd: `${new Date(endMs).toISOString().slice(0, 19)}Z`,
    currentPrice,
    bids,
    auctionRef,
  };
}

const allRows = Object.values(source.candidates || {}).flat().map(normalizedRow).filter(Boolean)
  .sort((a, b) => b.priority - a.priority || b.heuristicScore - a.heuristicScore || a.domain.localeCompare(b.domain));
const uniqueRows = [...new Map(allRows.map(row => [row.domain, row])).values()];

function choosePool(limit) {
  const picked = [];
  const pickedDomains = new Set();
  const caps = { net: 5, io: 5 };
  const counts = { net: 0, io: 0 };
  // These are review guarantees, never output quotas. Without them, the .com
  // preference can crowd every .ai out of the bounded transcript before the
  // reasoning model sees it. The editor remains free to reject all forty.
  const reviewReserves = { ai: 40, net: 5, io: 5 };
  for (const [tld, reserve] of Object.entries(reviewReserves)) {
    for (const row of uniqueRows.filter(candidate => candidate.tld === tld).slice(0, reserve)) {
      if (pickedDomains.has(row.domain)) continue;
      picked.push(row);
      pickedDomains.add(row.domain);
      if (row.tld in caps) counts[row.tld] += 1;
    }
  }
  for (const row of uniqueRows) {
    if (pickedDomains.has(row.domain)) continue;
    if (row.tld in caps && counts[row.tld] >= caps[row.tld]) continue;
    picked.push(row);
    pickedDomains.add(row.domain);
    if (row.tld in caps) counts[row.tld] += 1;
    if (picked.length === limit) break;
  }
  return picked.sort((a, b) => b.priority - a.priority || b.heuristicScore - a.heuristicScore || a.domain.localeCompare(b.domain));
}

function compactRows(rows) {
  return rows.map(row => [
    row.domain, row.providerCode, row.tldsTaken, row.ageYears, row.auctionEnd,
    row.currentPrice, row.bids, row.auctionRef,
  ]);
}

let reviewRows = choosePool(maxCandidates);
if (reviewRows.length < 250) throw new Error(`only ${reviewRows.length} bounded candidates remain for editorial review`);
const providerCodes = new Set(reviewRows.map(row => row.providerCode));
if (providerCodes.size !== 2) throw new Error('bounded candidate pool does not represent both providers');
const requiredAiReview = Math.min(40, reviewRows.filter(row => row.tld === 'ai').length);

const baseOutput = {
  status: 'candidate_pool_ready',
  generatedAt: source.generatedAt,
  timezone: 'America/Chicago',
  inventory: source.inventory,
  extensionCoverage: source.extensionCoverage,
  universe: source.universe,
  eligible: source.eligible,
  providerCodes: { G: 'GoDaddy', N: 'Namecheap' },
  auctionPathRules: {
    G: 'www.godaddy.com/domain-auctions/{domain-dot-to-hyphen}-{auctionRef}?isc=json_biddable',
    N: 'www.namecheap.com/market/{domain}',
  },
  columns: ['domain','providerCode','tldsTaken','ageYears','auctionEnd','currentPrice','bids','auctionRef'],
};

let output;
for (;;) {
  output = { ...baseOutput, reviewPoolCount: reviewRows.length, candidates: compactRows(reviewRows) };
  const bytes = Buffer.byteLength(JSON.stringify(output));
  if (bytes <= maxReceiptBytes) break;
  if (reviewRows.length <= 250) throw new Error(`lossless 250-row receipt exceeds bounded transcript size (${bytes} bytes)`);
  const aiCount = reviewRows.filter(row => row.tld === 'ai').length;
  const providerCounts = reviewRows.reduce((counts, row) => {
    counts[row.providerCode] = (counts[row.providerCode] || 0) + 1;
    return counts;
  }, {});
  const removableIndex = reviewRows.findLastIndex(row =>
    !(row.tld === 'ai' && aiCount <= requiredAiReview) && providerCounts[row.providerCode] > 1,
  );
  if (removableIndex < 0) throw new Error(`review guarantees exceed bounded transcript size (${bytes} bytes)`);
  reviewRows.splice(removableIndex, 1);
}

console.log(JSON.stringify(output));
