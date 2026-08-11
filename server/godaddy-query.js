// Shared GoDaddy inventory-cache query logic (filter / sort / page).
//
// This module is the SINGLE SOURCE OF TRUTH for how GoDaddy cache rows are filtered,
// sorted, and paged, so the synchronous main-thread path (server/index.js) and the
// off-main-thread worker (server/godaddy-worker.js) produce byte-identical results —
// no drift. All functions take a PLAIN query object (req.query), never an Express req,
// so they are usable inside a worker_thread where req is not transferable.

function rowField(row, field, compactColumnIndex = null) {
  if (!compactColumnIndex) return row[field];
  const position = compactColumnIndex[field];
  return position == null ? undefined : row[position];
}

function baseNameFromRow(row, compactColumnIndex = null) {
  // Allocation-free equivalent of split('.')[0].toLowerCase() — avoids building a
  // throwaway array per row on full-inventory scans (suffix + search starts/ends).
  const d = String(rowField(row, 'domain', compactColumnIndex) || '');
  const dot = d.indexOf('.');
  return (dot === -1 ? d : d.slice(0, dot)).toLowerCase();
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

function compactIndexRowAt(index, position) {
  const tuple = index.compactRows[position];
  const row = {};
  for (let column = 0; column < index.compactColumns.length; column += 1) {
    row[index.compactColumns[column]] = tuple[column] ?? null;
  }
  row.bid_count = row.bid_count ?? 0;
  row.has_numbers = row.has_numbers ? 1 : 0;
  row.has_hyphens = row.has_hyphens ? 1 : 0;
  return row;
}

function lowerBoundCompactAuctionEnd(index, targetMs) {
  const endColumn = index.compactColumnIndex.auction_end;
  let lo = 0;
  let hi = index.compactRows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const parsedEndMs = new Date(index.compactRows[mid][endColumn] || '').getTime();
    const endMs = Number.isFinite(parsedEndMs) ? parsedEndMs : Infinity;
    if (endMs < targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hasCompiledFilters(compiled) {
  return Boolean(
    compiled.tldSet || compiled.q != null || compiled.suffixes
    || compiled.maxPrice != null || compiled.minPrice != null
    || compiled.minLength != null || compiled.maxLength != null
    || compiled.minAge != null || compiled.maxAge != null
    || compiled.minTlds != null || compiled.maxTlds != null
    || compiled.noNumbers || compiled.noHyphens || compiled.hasBids
    || compiled.hasWayback || compiled.dnsAvailable || compiled.takenInBaseSets
  );
}

// Pre-parse the query's row-independent filter constants ONCE so a full-inventory
// scan doesn't rebuild the tld Set / re-parse q/suffix/numerics for every one of
// ~600k rows. Truthiness gates mirror the original inline checks exactly.
function compileQueryFilter(query, options = {}) {
  const f = {};
  const tld = query.tld;
  if (tld && tld !== 'all') {
    f.tldSet = new Set(String(tld).split(',').map(t => t.trim()).filter(Boolean).map(t => t.startsWith('.') ? t : `.${t}`));
  }
  if (query.q) {
    f.q = String(query.q).toLowerCase().replace(/[^a-z0-9.-]/g, '');
    f.qMode = query.searchMode || 'contains';
  }
  if (query.domainSuffix) {
    f.suffixes = String(query.domainSuffix).split(',')
      .map(s => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean);
  }
  // Only keep numeric filters that parse to a finite value — a malformed value (NaN)
  // would otherwise be carried as a filter constant that makes every comparison false.
  { const v = parseFloat(query.maxPrice); if (Number.isFinite(v)) f.maxPrice = v; }
  { const v = parseFloat(query.minPrice); if (Number.isFinite(v)) f.minPrice = v; }
  { const v = parseInt(query.minLength, 10); if (Number.isFinite(v)) f.minLength = v; }
  { const v = parseInt(query.maxLength, 10); if (Number.isFinite(v)) f.maxLength = v; }
  { const v = parseInt(query.minAge, 10); if (Number.isFinite(v)) f.minAge = v; }
  { const v = parseInt(query.maxAge, 10); if (Number.isFinite(v)) f.maxAge = v; }
  { const v = parseInt(query.minTlds, 10); if (Number.isFinite(v)) f.minTlds = v; }
  { const v = parseInt(query.maxTlds, 10); if (Number.isFinite(v)) f.maxTlds = v; }
  f.noNumbers = query.noNumbers === '1';
  f.noHyphens = query.noHyphens === '1';
  f.hasBids = query.hasBids === '1';
  // GoDaddy inventory carries no wayback / DNS enrichment (these fields aren't on the
  // cache index rows), so these filters correctly match nothing on a GoDaddy stream.
  // Handling them here (instead of leaving them "cache-unsupported") keeps the request
  // on the fast cache path — the alternative was a guaranteed-empty full-table DB scan
  // over ~491k GoDaddy rows that froze the single thread for ~32s per request.
  f.hasWayback = query.hasWayback === '1';
  f.dnsAvailable = query.dnsAvailable === '1';
  if (Array.isArray(options.takenInBaseSets) && options.takenInBaseSets.length) {
    f.takenInBaseSets = options.takenInBaseSets;
    f.takenInMatch = String(query.takenInMatch || '').toLowerCase() === 'any' ? 'any' : 'all';
  }
  return f;
}

// Mirrors server/index.js goDaddyCacheRowMatchesDomainRequest, but takes a plain query.
// opts.compiled (from compileQueryFilter) lets a hot scan skip per-row re-parsing; when
// absent it is compiled inline (single-row callers). opts.nowMs lets callers inject a
// deterministic clock for the "is this auction still live" check instead of Date.now().
function rowMatchesQuery(row, query, opts = {}) {
  const {
    stream = '', dateWindow = null, skipDateFilter = false, ignoreDateFilter = false,
    skipEndedCheck = false, nowMs,
  } = opts;
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const f = opts.compiled || compileQueryFilter(query);
  const compactColumnIndex = opts.compactColumnIndex || null;
  const field = name => rowField(row, name, compactColumnIndex);

  // skipEndedCheck: the caller has already excluded ended auctions (e.g. via the
  // auction_end-index binary search / override window predicate), so skip the per-row
  // Date parse.
  if (stream === 'godaddy-auction' && !skipEndedCheck) {
    const endMs = new Date(field('auction_end') || '').getTime();
    if (!Number.isFinite(endMs) || endMs <= effectiveNowMs) return false;
  }

  if (dateWindow && !skipDateFilter && !ignoreDateFilter) {
    const endMs = new Date(field('auction_end') || '').getTime();
    const startMs = new Date(dateWindow.start).getTime();
    const endWindowMs = new Date(dateWindow.end).getTime();
    if (!Number.isFinite(endMs) || endMs < startMs || endMs >= endWindowMs) return false;
  }

  if (f.tldSet && !f.tldSet.has(field('tld'))) return false;

  if (f.q != null) {
    const base = baseNameFromRow(row, compactColumnIndex);
    if (f.qMode === 'starts') {
      if (!base.startsWith(f.q)) return false;
    } else if (f.qMode === 'ends') {
      if (!base.endsWith(f.q)) return false;
    } else if (!String(field('domain') || '').toLowerCase().includes(f.q)) {
      return false;
    }
  }

  if (f.suffixes && f.suffixes.length && !f.suffixes.some(s => baseNameFromRow(row, compactColumnIndex).endsWith(s))) return false;

  if (f.maxPrice != null && (field('auction_price') == null || Number(field('auction_price')) > f.maxPrice)) return false;
  if (f.minPrice != null && (field('auction_price') == null || Number(field('auction_price')) < f.minPrice)) return false;
  if (f.minLength != null && Number(field('length')) < f.minLength) return false;
  if (f.maxLength != null && Number(field('length')) > f.maxLength) return false;
  if (f.minAge != null && (field('age_years') == null || Number(field('age_years')) < f.minAge)) return false;
  if (f.maxAge != null && (field('age_years') == null || Number(field('age_years')) > f.maxAge)) return false;
  if (f.minTlds != null && (field('tlds_taken') == null || Number(field('tlds_taken')) < f.minTlds)) return false;
  if (f.maxTlds != null && (field('tlds_taken') == null || Number(field('tlds_taken')) > f.maxTlds)) return false;
  if (f.noNumbers && field('has_numbers')) return false;
  if (f.noHyphens && field('has_hyphens')) return false;
  if (f.hasBids && Number(field('bid_count') || 0) <= 0) return false;
  // wayback_snapshots / dns_available are absent on GoDaddy cache rows → these exclude
  // every row (correct: GoDaddy inventory has no such data), returning empty instantly.
  if (f.hasWayback && !(Number(field('wayback_snapshots')) > 0)) return false;
  if (f.dnsAvailable && Number(field('dns_available')) !== 1) return false;
  if (f.takenInBaseSets) {
    const base = baseNameFromRow(row, compactColumnIndex);
    const matches = f.takenInBaseSets.map(set => set.has(base));
    if (f.takenInMatch === 'any' ? !matches.some(Boolean) : !matches.every(Boolean)) return false;
  }

  return true;
}

// A cached live-auction page is reusable only while every row it would return is
// still in the future. The underlying inventory generation can remain current for
// hours while the first page ages out minute by minute, so snapshot identity alone
// is not a sufficient cache key for this stream.
function auctionResponseRowsAreFuture(response, nowMs = Date.now()) {
  const domains = response && response.domains;
  if (!Array.isArray(domains)) return false;
  return domains.every((row) => {
    const endMs = new Date(row && row.auction_end || '').getTime();
    return Number.isFinite(endMs) && endMs > nowMs;
  });
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

// ---------------------------------------------------------------------------------
// Fresh live-auction override contract.
//
// Overrides are PLAIN DATA keyed by normalized domain: { end_time, fetched_at,
// bid_count|bids, status, price|auction_price }. They let a fast, recent GoDaddy
// live-auction observation correct a row's effective auction_end/bids/status/price
// WITHOUT rewriting the underlying inventory cache and WITHOUT ever reclassifying the
// row into a different stream (closeout or otherwise) — only the fields explicitly
// named above may move.
// ---------------------------------------------------------------------------------

const DEFAULT_OVERRIDE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

function normalizeOverrideKey(domain) {
  return String(domain || '').trim().toLowerCase();
}

function parseOverrideEndMs(endTime) {
  if (endTime === null || endTime === undefined || endTime === '') return NaN;
  const ms = new Date(endTime).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

// A observation is usable only when: it exists, its fetched_at parses and is not in
// the future (future-fetched observations cannot be trusted), it is not older than
// maxAgeMs (stale), and its end_time parses to a real instant (invalid). Any failure
// means the override contributes nothing — inventory stands as-is.
function isFreshOverride(override, nowMs, maxAgeMs) {
  if (!override || typeof override !== 'object') return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  const fetchedMs = new Date(override.fetched_at || '').getTime();
  if (!Number.isFinite(fetchedMs)) return false;
  if (fetchedMs > nowMs) return false; // future-fetched
  if (nowMs - fetchedMs > maxAgeMs) return false; // stale
  const endMs = parseOverrideEndMs(override.end_time);
  if (!Number.isFinite(endMs)) return false; // missing/invalid end_time
  return true;
}

// Pure projector: given a row and a single override observation, return either the
// SAME row reference (override unusable — no allocation) or a NEW plain object with
// auction_end/bid_count/status/auction_price replaced by the fresh observation.
// override.stream (if present) is never read — stream classification is untouched.
function projectRowWithOverride(row, override, nowMs, maxAgeMs) {
  if (!isFreshOverride(override, nowMs, maxAgeMs)) return row;
  const endMs = parseOverrideEndMs(override.end_time);
  const projected = { ...row, auction_end: new Date(endMs).toISOString() };
  if (override.bid_count != null) {
    projected.bid_count = override.bid_count;
  } else if (override.bids != null) {
    projected.bid_count = override.bids;
  }
  if (override.status != null) projected.status = override.status;
  if (override.price != null) {
    projected.auction_price = override.price;
  } else if (override.auction_price != null) {
    projected.auction_price = override.auction_price;
  }
  return projected;
}

function getOverrideForRow(overrides, row) {
  if (!overrides || !row) return null;
  const key = normalizeOverrideKey(row.domain);
  return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
}

function projectRowWithOverrides(row, overrides, nowMs, maxAgeMs) {
  const override = getOverrideForRow(overrides, row);
  if (!override) return row;
  return projectRowWithOverride(row, override, nowMs, maxAgeMs);
}

// Memoized (per-index) domain → row lookup, built lazily and ONLY the first time an
// override needs to locate a row outside the fast ordered-index window. Cached on the
// index object itself (non-enumerable) so repeated calls on the same index (the common
// case — indexes are memoized per file mtime) never re-scan. Building this is O(rows)
// once; it is never rebuilt just because an (empty) overrides object is passed.
function getDomainIndexMap(index) {
  if (!index || typeof index !== 'object') return new Map();
  if (index.__overrideDomainIndex) return index.__overrideDomainIndex;
  const map = new Map();
  for (const row of index.rows || []) {
    map.set(normalizeOverrideKey(row.domain), row);
  }
  Object.defineProperty(index, '__overrideDomainIndex', {
    value: map, enumerable: false, configurable: true, writable: true,
  });
  return map;
}

// Builds the single predicate that decides whether an effective-end timestamp (raw or
// overridden) belongs in the current query's "live" window. Mirrors, exactly, the two
// conditions the original per-row checks enforced: (a) inside the requested date window
// (if any) and (b) — for the godaddy-auction stream — not yet ended relative to nowMs.
// Both conditions apply together when both are present (matches original combined
// dateWindow + stream==='godaddy-auction' semantics).
function makeWindowPredicate({ stream, dateWindow, nowMs }) {
  let startMs = null;
  let endWindowMs = null;
  if (dateWindow) {
    startMs = new Date(dateWindow.start).getTime();
    endWindowMs = new Date(dateWindow.end).getTime();
  }
  const isAuctionStream = stream === 'godaddy-auction';
  return (ms) => {
    if (!Number.isFinite(ms)) return false;
    if (dateWindow && (ms < startMs || ms >= endWindowMs)) return false;
    if (isAuctionStream && ms <= nowMs) return false;
    return true;
  };
}

// Single comparator used for BOTH sorting the small moverCandidates list and merging
// it against stableRows, so tie-break behavior is IDENTICAL in both places and matches
// the underlying inventory index's own tie-break: end ascending, then domain ascending
// (byAuctionEndAsc), walked in reverse for DESC (so DESC ties resolve end desc, domain
// desc — the exact mirror image of reading the ASC tie-broken index backwards). Without
// this shared comparator, same-end stable and mover rows could order by which partition
// (stable vs mover) they landed in rather than by domain, silently shifting a domain
// across a page boundary as overrides appear or disappear.
function compareEffectiveEnd(a, b, dirMul) {
  const endCmp = (a.endMs - b.endMs) * dirMul;
  if (endCmp !== 0) return endCmp;
  return String(a.domain || '').localeCompare(String(b.domain || '')) * dirMul;
}

// Merges two ALREADY-SORTED (by compareEffectiveEnd, same direction) lists into a total
// count and a requested page slice, without materializing the full merged array. a =
// ordinary rows in their natural fast-index order (no override, or override present but
// unusable); b = the small set of override-driven rows (fresh overrides), sorted
// separately since it is tiny. This keeps the work proportional to the scanned window +
// override count, never a sort of the whole index. The SAME compareEffectiveEnd
// comparator used to sort b is used here to decide a[i] vs b[j], so equal-end rows
// always resolve by domain — never by which list (a or b) they happened to come from.
function mergeSortedByEnd(a, b, dirMul, offset, limitNum) {
  let i = 0;
  let j = 0;
  let total = 0;
  const pageRows = [];
  while (i < a.length || j < b.length) {
    let pick;
    if (i < a.length && j < b.length) {
      const cmp = compareEffectiveEnd(a[i], b[j], dirMul);
      if (cmp <= 0) { pick = a[i]; i += 1; } else { pick = b[j]; j += 1; }
    } else if (i < a.length) {
      pick = a[i]; i += 1;
    } else {
      pick = b[j]; j += 1;
    }
    if (total >= offset && pageRows.length < limitNum) pageRows.push(pick.row);
    total += 1;
  }
  return { total, pageRows };
}

// Walks the raw auction_end-ordered window [lo, hi) exactly once (same cost as the
// override-free fast path), splitting rows into:
//   - stableRows: rows with no usable override — kept in their natural fast-index order.
//   - moverCandidates: rows with a FRESH override — re-evaluated against the window
//     predicate using their EFFECTIVE (overridden) end, so a fresh past-end excludes a
//     raw-live row and a fresh future-end (that fell outside [lo, hi) because the row
//     was raw-ended) is picked up via the small reentrant pass below.
// A domain with an override is handled in EXACTLY ONE place (base loop if its raw
// position is inside [lo, hi), reentrant loop otherwise), so duplicates are impossible.
function buildAuctionWindowMerge({
  entries, lo, hi, forward, overrides, overrideKeys, nowMs, maxAgeMs,
  inWindow, query, compiled, stream, dateWindow, index,
}) {
  const stableRows = [];
  const moverCandidates = [];
  const seenOverrideDomains = new Set();

  const start = forward ? lo : hi - 1;
  const stop = forward ? hi : lo - 1;
  const step = forward ? 1 : -1;

  for (let i = start; i !== stop; i += step) {
    const entry = entries[i];
    const row = entry.row;
    const key = normalizeOverrideKey(row.domain);
    const override = overrides ? overrides[key] : undefined;
    if (override) {
      seenOverrideDomains.add(key);
      if (isFreshOverride(override, nowMs, maxAgeMs)) {
        const effEndMs = parseOverrideEndMs(override.end_time);
        if (inWindow(effEndMs)) {
          const projected = projectRowWithOverride(row, override, nowMs, maxAgeMs);
          if (rowMatchesQuery(projected, query, { stream, dateWindow, skipDateFilter: true, skipEndedCheck: true, compiled, nowMs })) {
            moverCandidates.push({ row: projected, endMs: effEndMs, domain: projected.domain });
          }
        }
        continue; // handled — never falls into stableRows, so no duplicate.
      }
      // Stale / invalid / future-fetched override → ignore it, fall through to raw row.
    }
    if (!inWindow(entry.endMs)) continue;
    if (rowMatchesQuery(row, query, { stream, dateWindow, skipDateFilter: true, skipEndedCheck: true, compiled, nowMs })) {
      stableRows.push({ row, endMs: entry.endMs, domain: row.domain });
    }
  }

  // Reentrant pass: fresh overrides whose raw row position never entered the loop above
  // (raw-ended row with a fresh future end, or raw end outside a date window whose
  // effective end now belongs inside it). Bounded by override count, not index size.
  if (overrideKeys && overrideKeys.length) {
    const domainMap = getDomainIndexMap(index);
    for (const key of overrideKeys) {
      if (seenOverrideDomains.has(key)) continue;
      const override = overrides[key];
      if (!isFreshOverride(override, nowMs, maxAgeMs)) continue;
      const row = domainMap.get(key);
      if (!row) continue;
      const effEndMs = parseOverrideEndMs(override.end_time);
      if (!inWindow(effEndMs)) continue;
      const projected = projectRowWithOverride(row, override, nowMs, maxAgeMs);
      if (rowMatchesQuery(projected, query, { stream, dateWindow, skipDateFilter: true, skipEndedCheck: true, compiled, nowMs })) {
        moverCandidates.push({ row: projected, endMs: effEndMs, domain: projected.domain });
      }
    }
  }

  const dirMul = forward ? 1 : -1;
  moverCandidates.sort((a, b) => compareEffectiveEnd(a, b, dirMul));

  return { stableRows, moverCandidates };
}

// Mirrors the core of server/index.js buildGoDaddyCacheDomainsResponse: given a parsed
// index ({rows, byAuctionEndAsc, generatedAt, stream}), return {total, pageRows} —
// WITHOUT the DB enrichment (that stays on the main thread, which holds the SQLite
// connection).
//
// options.overrides / options.nowMs / options.maxAgeMs implement the plain-data
// effective-end override contract (see above). When overrides is absent/empty, this
// function performs EXACTLY the original fast-path work — no extra scan, no extra sort
// — only because an (empty) overrides object was passed in.
function buildPageFromIndex(index, query, options) {
  const {
    sortBy, sortDir, pageNum, limitNum, dateWindow, dateFilterIgnoredReason,
    overrides = null, nowMs: nowMsOpt, maxAgeMs: maxAgeMsOpt, takenInBaseSets = null,
  } = options;
  const nowMs = Number.isFinite(nowMsOpt) ? nowMsOpt : Date.now();
  const maxAgeMs = Number.isFinite(maxAgeMsOpt) ? maxAgeMsOpt : DEFAULT_OVERRIDE_MAX_AGE_MS;
  const overrideKeys = overrides ? Object.keys(overrides) : [];
  const hasOverrides = overrideKeys.length > 0;

  const offset = (pageNum - 1) * limitNum;
  const ignoreDateFilter = Boolean(dateFilterIgnoredReason);
  const sortUsesAuctionEnd = sortBy === 'auction_end' || sortBy === 'expiring_at';
  const canUseEndIndex = sortUsesAuctionEnd && !ignoreDateFilter;
  const compiled = compileQueryFilter(query, { takenInBaseSets }); // parse filter constants once, not per row
  let total = 0;
  const pageRows = [];

  if (canUseEndIndex) {
    const compactFastPath = Array.isArray(index.compactRows) && !hasOverrides;
    const entries = compactFastPath ? index.compactRows : index.byAuctionEndAsc;
    // Scan window [lo, hi) within the auction_end-sorted index.
    let lo = 0;
    let hi = entries.length;
    let skipEndedCheck = false;
    if (dateWindow) {
      lo = compactFastPath
        ? lowerBoundCompactAuctionEnd(index, new Date(dateWindow.start).getTime())
        : lowerBoundAuctionEnd(entries, new Date(dateWindow.start).getTime());
      hi = compactFastPath
        ? lowerBoundCompactAuctionEnd(index, new Date(dateWindow.end).getTime())
        : lowerBoundAuctionEnd(entries, new Date(dateWindow.end).getTime());
    } else if (index.stream === 'godaddy-auction') {
      // Ended auctions (endMs <= now) are all at the front of the ASC-sorted index.
      // Binary-search past them in O(log n) instead of skipping ~tens of thousands of
      // rows one Date-parse at a time, and tell rowMatchesQuery the ended check is done.
      lo = compactFastPath
        ? lowerBoundCompactAuctionEnd(index, nowMs + 1)
        : lowerBoundAuctionEnd(entries, nowMs + 1);
      skipEndedCheck = true;
    }

    const forward = String(sortDir).toUpperCase() === 'ASC';

    if (!hasOverrides) {
      if (compactFastPath && !hasCompiledFilters(compiled)) {
        // The desktop's opening view is already persisted in auction_end order. Count
        // the complete live window arithmetically and inflate only the requested page,
        // avoiding hundreds of thousands of short-lived objects on every cold start.
        total = Math.max(0, hi - lo);
        const available = Math.max(0, total - offset);
        const take = Math.min(limitNum, available);
        for (let pageIndex = 0; pageIndex < take; pageIndex += 1) {
          const position = forward
            ? lo + offset + pageIndex
            : hi - 1 - offset - pageIndex;
          pageRows.push(compactIndexRowAt(index, position));
        }
        return { total, pageRows, generatedAt: index.generatedAt };
      }
      // Unchanged fast path — identical cost/behavior to before overrides existed.
      const start = forward ? lo : hi - 1;
      const stop = forward ? hi : lo - 1;
      const step = forward ? 1 : -1;
      for (let i = start; i !== stop; i += step) {
        const row = compactFastPath ? entries[i] : entries[i].row;
        if (!rowMatchesQuery(row, query, {
          stream: index.stream,
          dateWindow,
          skipDateFilter: true,
          skipEndedCheck,
          compiled,
          nowMs,
          compactColumnIndex: compactFastPath ? index.compactColumnIndex : null,
        })) continue;
        if (total >= offset && pageRows.length < limitNum) {
          pageRows.push(compactFastPath ? compactIndexRowAt(index, i) : row);
        }
        total += 1;
      }
    } else {
      const inWindow = makeWindowPredicate({ stream: index.stream, dateWindow, nowMs });
      const { stableRows, moverCandidates } = buildAuctionWindowMerge({
        entries, lo, hi, forward, overrides, overrideKeys, nowMs, maxAgeMs,
        inWindow, query, compiled, stream: index.stream, dateWindow, index,
      });
      const dirMul = forward ? 1 : -1;
      const merged = mergeSortedByEnd(stableRows, moverCandidates, dirMul, offset, limitNum);
      total = merged.total;
      pageRows.push(...merged.pageRows);
    }
  } else if (Array.isArray(index.compactRows) && !hasOverrides) {
    const matchingPositions = [];
    for (let position = 0; position < index.compactRows.length; position += 1) {
      const tuple = index.compactRows[position];
      if (rowMatchesQuery(tuple, query, {
        stream: index.stream,
        dateWindow,
        ignoreDateFilter,
        compiled,
        nowMs,
        compactColumnIndex: index.compactColumnIndex,
      })) matchingPositions.push(position);
    }
    const dir = String(sortDir).toUpperCase() === 'ASC' ? 1 : -1;
    const value = (position, field) => rowField(index.compactRows[position], field, index.compactColumnIndex);
    const sortField = sortBy === 'expiring_at' ? 'auction_end' : sortBy;
    matchingPositions.sort((a, b) => (
      compareNullableValues(value(a, sortField), value(b, sortField), dir, sortBy === 'domain')
      || compareNullableValues(value(a, 'auction_end'), value(b, 'auction_end'), 1)
      || String(value(a, 'domain') || '').localeCompare(String(value(b, 'domain') || ''))
    ));
    total = matchingPositions.length;
    for (const position of matchingPositions.slice(offset, offset + limitNum)) {
      pageRows.push(compactIndexRowAt(index, position));
    }
  } else {
    const filteredRows = [];
    for (const row of index.rows) {
      const projected = hasOverrides ? projectRowWithOverrides(row, overrides, nowMs, maxAgeMs) : row;
      if (rowMatchesQuery(projected, query, {
        stream: index.stream,
        dateWindow,
        ignoreDateFilter,
        compiled,
        nowMs,
      })) {
        filteredRows.push(projected);
      }
    }
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
  auctionResponseRowsAreFuture,
  cacheSortValue,
  sortGoDaddyCacheRows,
  buildPageFromIndex,
  // Plain-data override contract (normalizer/projector).
  DEFAULT_OVERRIDE_MAX_AGE_MS,
  normalizeOverrideKey,
  isFreshOverride,
  projectRowWithOverride,
  projectRowWithOverrides,
  getOverrideForRow,
  // Shared end+domain tie-break comparator (exported for direct test coverage).
  compareEffectiveEnd,
};
