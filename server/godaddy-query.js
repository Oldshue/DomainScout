// Shared GoDaddy inventory-cache query logic (filter / sort / page).
//
// This module is the SINGLE SOURCE OF TRUTH for how GoDaddy cache rows are filtered,
// sorted, and paged, so the synchronous main-thread path (server/index.js) and the
// off-main-thread worker (server/godaddy-worker.js) produce byte-identical results —
// no drift. All functions take a PLAIN query object (req.query), never an Express req,
// so they are usable inside a worker_thread where req is not transferable.

function baseNameFromRow(row) {
  return String(row.domain || '').split('.')[0].toLowerCase();
}

function compareNullableValues(a, b, dir, stringMode = false) {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (stringMode) return String(a).localeCompare(String(b)) * dir;
  const aNum = typeof a === 'number' ? a : Number(a);
  const bNum = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) return (aNum - bNum) * dir;
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return (aTime - bTime) * dir;
  return String(a).localeCompare(String(b)) * dir;
}

function lowerBoundAuctionEnd(entries, targetMs) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].endMs < targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Mirrors server/index.js goDaddyCacheRowMatchesDomainRequest, but takes a plain query.
function rowMatchesQuery(row, query, { stream = '', dateWindow = null, skipDateFilter = false, ignoreDateFilter = false, skipEndedCheck = false } = {}) {
  // skipEndedCheck: the caller has already excluded ended auctions (e.g. via the
  // auction_end-index binary search in buildPageFromIndex), so skip the per-row
  // Date parse — this is the hot cost on a full-inventory scan.
  if (stream === 'godaddy-auction' && !skipEndedCheck) {
    const endMs = new Date(row.auction_end || '').getTime();
    if (!Number.isFinite(endMs) || endMs <= Date.now()) return false;
  }

  if (dateWindow && !skipDateFilter && !ignoreDateFilter) {
    const endMs = new Date(row.auction_end || '').getTime();
    const startMs = new Date(dateWindow.start).getTime();
    const endWindowMs = new Date(dateWindow.end).getTime();
    if (!Number.isFinite(endMs) || endMs < startMs || endMs >= endWindowMs) return false;
  }

  const tld = query.tld;
  if (tld && tld !== 'all') {
    const wanted = new Set(String(tld).split(',').map(t => t.trim()).filter(Boolean).map(t => t.startsWith('.') ? t : `.${t}`));
    if (!wanted.has(row.tld)) return false;
  }

  if (query.q) {
    const q = String(query.q).toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const mode = query.searchMode || 'contains';
    const base = baseNameFromRow(row);
    if (mode === 'starts') {
      if (!base.startsWith(q)) return false;
    } else if (mode === 'ends') {
      if (!base.endsWith(q)) return false;
    } else if (!String(row.domain || '').toLowerCase().includes(q)) {
      return false;
    }
  }

  if (query.domainSuffix) {
    const suffixes = String(query.domainSuffix).split(',')
      .map(s => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean);
    if (suffixes.length && !suffixes.some(s => baseNameFromRow(row).endsWith(s))) return false;
  }

  if (query.maxPrice && (row.auction_price == null || Number(row.auction_price) > parseFloat(query.maxPrice))) return false;
  if (query.minPrice && (row.auction_price == null || Number(row.auction_price) < parseFloat(query.minPrice))) return false;
  if (query.minLength && Number(row.length) < parseInt(query.minLength, 10)) return false;
  if (query.maxLength && Number(row.length) > parseInt(query.maxLength, 10)) return false;
  if (query.minAge && (row.age_years == null || Number(row.age_years) < parseInt(query.minAge, 10))) return false;
  if (query.maxAge && (row.age_years == null || Number(row.age_years) > parseInt(query.maxAge, 10))) return false;
  if (query.noNumbers === '1' && row.has_numbers) return false;
  if (query.noHyphens === '1' && row.has_hyphens) return false;
  if (query.hasBids === '1' && Number(row.bid_count || 0) <= 0) return false;

  return true;
}

function cacheSortValue(row, sortBy) {
  if (sortBy === 'expiring_at') return row.auction_end;
  return row[sortBy];
}

function sortGoDaddyCacheRows(rows, sortBy, sortDir) {
  const dir = String(sortDir).toUpperCase() === 'ASC' ? 1 : -1;
  return [...rows].sort((a, b) => (
    compareNullableValues(cacheSortValue(a, sortBy), cacheSortValue(b, sortBy), dir, sortBy === 'domain')
    || compareNullableValues(a.auction_end, b.auction_end, 1)
    || String(a.domain || '').localeCompare(String(b.domain || ''))
  ));
}

// Mirrors the core of server/index.js buildGoDaddyCacheDomainsResponse: given a parsed
// index ({rows, byAuctionEndAsc, generatedAt}), return {total, pageRows} — WITHOUT the
// DB enrichment (that stays on the main thread, which holds the SQLite connection).
function buildPageFromIndex(index, query, { sortBy, sortDir, pageNum, limitNum, dateWindow, dateFilterIgnoredReason }) {
  const offset = (pageNum - 1) * limitNum;
  const ignoreDateFilter = Boolean(dateFilterIgnoredReason);
  const sortUsesAuctionEnd = sortBy === 'auction_end' || sortBy === 'expiring_at';
  const canUseEndIndex = sortUsesAuctionEnd && !ignoreDateFilter;
  let total = 0;
  const pageRows = [];

  if (canUseEndIndex) {
    const entries = index.byAuctionEndAsc;
    // Scan window [lo, hi) within the auction_end-sorted index.
    let lo = 0;
    let hi = entries.length;
    let skipEndedCheck = false;
    if (dateWindow) {
      lo = lowerBoundAuctionEnd(entries, new Date(dateWindow.start).getTime());
      hi = lowerBoundAuctionEnd(entries, new Date(dateWindow.end).getTime());
    } else if (index.stream === 'godaddy-auction') {
      // Ended auctions (endMs <= now) are all at the front of the ASC-sorted index.
      // Binary-search past them in O(log n) instead of skipping ~tens of thousands of
      // rows one Date-parse at a time, and tell rowMatchesQuery the ended check is done.
      lo = lowerBoundAuctionEnd(entries, Date.now() + 1);
      skipEndedCheck = true;
    }

    const forward = String(sortDir).toUpperCase() === 'ASC';
    const start = forward ? lo : hi - 1;
    const stop = forward ? hi : lo - 1;
    const step = forward ? 1 : -1;
    for (let i = start; i !== stop; i += step) {
      const row = entries[i].row;
      if (!rowMatchesQuery(row, query, { stream: index.stream, dateWindow, skipDateFilter: true, skipEndedCheck })) continue;
      if (total >= offset && pageRows.length < limitNum) pageRows.push(row);
      total += 1;
    }
  } else {
    const filteredRows = index.rows.filter(row => rowMatchesQuery(row, query, {
      stream: index.stream,
      dateWindow,
      ignoreDateFilter,
    }));
    const sortedRows = sortGoDaddyCacheRows(filteredRows, sortBy, sortDir);
    total = sortedRows.length;
    for (const row of sortedRows.slice(offset, offset + limitNum)) pageRows.push(row);
  }

  return { total, pageRows, generatedAt: index.generatedAt };
}

module.exports = {
  baseNameFromRow,
  compareNullableValues,
  lowerBoundAuctionEnd,
  rowMatchesQuery,
  cacheSortValue,
  sortGoDaddyCacheRows,
  buildPageFromIndex,
};
