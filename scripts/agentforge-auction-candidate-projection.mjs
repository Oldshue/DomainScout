const DEFAULT_MAX_CANDIDATES = 345;
const DEFAULT_MAX_RECEIPT_BYTES = 18_500;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function projectAgentForgeCandidatePool(source, options = {}) {
  if (source?.status !== 'candidate_pool_ready') throw new Error('candidate helper did not return a ready pool');
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
  const normalized = Object.values(source.candidates || {}).flat().map(row => {
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
  }).filter(Boolean).sort((a, b) =>
    b.priority - a.priority || b.heuristicScore - a.heuristicScore || a.domain.localeCompare(b.domain));
  const uniqueRows = [...new Map(normalized.map(row => [row.domain, row])).values()];
  const maxCandidates = boundedInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES, 250, 360);
  const maxReceiptBytes = boundedInteger(options.maxReceiptBytes, DEFAULT_MAX_RECEIPT_BYTES, 16_000, 64_000);
  const picked = [];
  const pickedDomains = new Set();
  const counts = { net: 0, io: 0 };
  for (const [tld, reserve] of Object.entries({ ai: 40, net: 5, io: 5 })) {
    for (const row of uniqueRows.filter(candidate => candidate.tld === tld).slice(0, reserve)) {
      if (pickedDomains.has(row.domain)) continue;
      picked.push(row);
      pickedDomains.add(row.domain);
      if (row.tld in counts) counts[row.tld] += 1;
    }
  }
  for (const row of uniqueRows) {
    if (pickedDomains.has(row.domain)) continue;
    if (row.tld in counts && counts[row.tld] >= 5) continue;
    picked.push(row);
    pickedDomains.add(row.domain);
    if (row.tld in counts) counts[row.tld] += 1;
    if (picked.length === maxCandidates) break;
  }
  let reviewRows = picked.sort((a, b) =>
    b.priority - a.priority || b.heuristicScore - a.heuristicScore || a.domain.localeCompare(b.domain));
  if (reviewRows.length < 250) throw new Error(`only ${reviewRows.length} bounded candidates remain for editorial review`);
  if (new Set(reviewRows.map(row => row.providerCode)).size !== 2) {
    throw new Error('bounded candidate pool does not represent both providers');
  }
  const requiredAiReview = Math.min(40, reviewRows.filter(row => row.tld === 'ai').length);
  const baseOutput = {
    status: 'candidate_pool_ready',
    generatedAt: source.generatedAt,
    timezone: 'America/Chicago',
    inventory: source.inventory.map(item => ({
      ...item,
      provider: item.provider || (item.stream === 'godaddy-auction' ? 'GoDaddy' : 'Namecheap'),
    })),
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
  for (;;) {
    const output = {
      ...baseOutput,
      reviewPoolCount: reviewRows.length,
      candidates: reviewRows.map(row => [
        row.domain, row.providerCode, row.tldsTaken, row.ageYears, row.auctionEnd,
        row.currentPrice, row.bids, row.auctionRef,
      ]),
    };
    const bytes = Buffer.byteLength(JSON.stringify(output));
    if (bytes <= maxReceiptBytes) return output;
    if (reviewRows.length <= 250) throw new Error(`lossless 250-row receipt exceeds bounded transcript size (${bytes} bytes)`);
    const aiCount = reviewRows.filter(row => row.tld === 'ai').length;
    const providerCounts = reviewRows.reduce((result, row) => {
      result[row.providerCode] = (result[row.providerCode] || 0) + 1;
      return result;
    }, {});
    const removableIndex = reviewRows.findLastIndex(row =>
      !(row.tld === 'ai' && aiCount <= requiredAiReview) && providerCounts[row.providerCode] > 1);
    if (removableIndex < 0) throw new Error(`review guarantees exceed bounded transcript size (${bytes} bytes)`);
    reviewRows.splice(removableIndex, 1);
  }
}
