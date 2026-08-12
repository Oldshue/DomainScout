// Pure, deterministic Node test for the plain-data effective-end override contract in
// server/godaddy-query.js (and its forwarding through server/godaddy-worker.js).
//
// No network, no filesystem beyond reading the worker source, no database, no clock
// reads — every timestamp is derived from a fixed NOW constant so this test is fully
// deterministic on any machine, any day.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildPageFromIndex,
  isFreshOverride,
  projectRowWithOverride,
  normalizeOverrideKey,
  compareEffectiveEnd,
  auctionResponseRowsAreFuture,
  providerResponseHasTimeDependentRows,
} = require('../server/godaddy-query');

const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

function iso(offsetMinutes) {
  return new Date(NOW + offsetMinutes * 60 * 1000).toISOString();
}

function makeRow(domain, endOffsetMinutes, bidCount, price) {
  return {
    domain,
    tld: `.${domain.split('.').slice(1).join('.')}`,
    auction_end: iso(endOffsetMinutes),
    bid_count: bidCount,
    auction_price: price,
    length: domain.split('.')[0].length,
    has_numbers: false,
    has_hyphens: false,
    age_years: 5,
    stream: 'godaddy-auction',
  };
}

// --- Fixture rows -----------------------------------------------------------------
// alpha:    raw ENDED (-60min), fresh override → future (+120min). Must re-enter.
// bravo:    raw LIVE (+180min), 0 bids, fresh override → past (-30min). Must exclude.
// charlie:  raw LIVE (+200min), 5 bids, fresh override → past (-10min). Must exclude.
// delta:    raw ENDED (-90min), STALE override → future (+150min, fetched 40min ago).
//           Override must be ignored; row stays excluded (raw stands).
// echo:     raw LIVE (+90min), INVALID end_time override. Ignored; raw stands, included.
// foxtrot:  raw LIVE (+50min), FUTURE-FETCHED override. Ignored; raw stands, included.
// golf:     raw LIVE (+30min), 0 bids, no override.
// hotel:    raw LIVE (+400min), 0 bids, no override.
//
// Same-effective-end tie-break group (all effective end +250min, mixing STABLE rows
// that never touch the override path with MOVER rows reached via both the base scan
// AND the reentrant pass), added to reproduce and guard the blocking correctness
// failure from review version 1: merge/mover-sort order must resolve ties by domain
// (matching the inventory index's own end+domain tie-break), not by which partition
// (stable vs mover) a row happened to land in.
// mike:     raw LIVE (+250min), no override.                          -> STABLE
// november: raw ENDED (-15min), fresh override -> +250min.             -> MOVER (reentrant)
// oscar:    raw LIVE (+250min), no override.                          -> STABLE
// papa:     raw LIVE (+500min), fresh override -> +250min.             -> MOVER (base loop)
// Correct domain order for the tied group is ASC: mike, november, oscar, papa
// (interleaving stable/mover so neither an "all-stable-first" nor an "all-movers-first"
// bug would accidentally pass), and DESC: papa, oscar, november, mike.
const alpha = makeRow('alpha.com', -60, 1, 10);
const bravo = makeRow('bravo.com', 180, 0, 20);
const charlie = makeRow('charlie.com', 200, 5, 30);
const delta = makeRow('delta.com', -90, 2, 40);
const echo = makeRow('echo.com', 90, 4, 50);
const foxtrot = makeRow('foxtrot.com', 50, 1, 60);
const golf = makeRow('golf.com', 30, 0, 70);
const hotel = makeRow('hotel.com', 400, 0, 80);
const mike = makeRow('mike.com', 250, 2, 90);
const november = makeRow('november.com', -15, 1, 100);
const oscar = makeRow('oscar.com', 250, 3, 110);
const papa = makeRow('papa.com', 500, 0, 120);

const rows = [alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel, mike, november, oscar, papa];
// byAuctionEndAsc mirrors the production inventory index's own ordering: end ASC, then
// domain ASC as the tie-break. The merge/mover-sort logic under test must match this
// SAME tie-break, or a same-end stable+mover pair could order by partition instead.
const byAuctionEndAsc = rows
  .map(row => ({ row, endMs: new Date(row.auction_end).getTime() }))
  .sort((a, b) => a.endMs - b.endMs || String(a.row.domain).localeCompare(String(b.row.domain)));
const index = { stream: 'godaddy-auction', rows, byAuctionEndAsc, generatedAt: NOW };

const overrides = {
  'alpha.com': {
    end_time: iso(120), fetched_at: iso(-5), bid_count: 3, price: 15, status: 'active',
    stream: 'closeout', // adversarial: must NEVER be applied to the row's stream
  },
  'bravo.com': { end_time: iso(-30), fetched_at: iso(-5), status: 'ended' },
  'charlie.com': { end_time: iso(-10), fetched_at: iso(-2) },
  'delta.com': { end_time: iso(150), fetched_at: iso(-40) }, // stale (> 15min old)
  'echo.com': { end_time: 'not-a-real-date', fetched_at: iso(-3) }, // invalid end_time
  'foxtrot.com': { end_time: iso(300), fetched_at: iso(10) }, // future-fetched
  'november.com': { end_time: iso(250), fetched_at: iso(-5) }, // fresh, reentrant mover
  'papa.com': { end_time: iso(250), fetched_at: iso(-5) }, // fresh, base-loop mover
};

const TIED_DOMAINS = ['mike.com', 'november.com', 'oscar.com', 'papa.com'];

function domainsOf(res) {
  return res.pageRows.map(r => r.domain);
}

// --- 1. isFreshOverride / projectRowWithOverride unit coverage --------------------
assert.strictEqual(isFreshOverride(overrides['alpha.com'], NOW, MAX_AGE_MS), true, 'alpha override should be fresh');
assert.strictEqual(isFreshOverride(overrides['delta.com'], NOW, MAX_AGE_MS), false, 'delta override should be stale');
assert.strictEqual(isFreshOverride(overrides['echo.com'], NOW, MAX_AGE_MS), false, 'echo override end_time should be invalid');
assert.strictEqual(isFreshOverride(overrides['foxtrot.com'], NOW, MAX_AGE_MS), false, 'foxtrot override should be future-fetched');
assert.strictEqual(isFreshOverride(overrides['november.com'], NOW, MAX_AGE_MS), true, 'november override should be fresh');
assert.strictEqual(isFreshOverride(overrides['papa.com'], NOW, MAX_AGE_MS), true, 'papa override should be fresh');
assert.strictEqual(isFreshOverride(undefined, NOW, MAX_AGE_MS), false, 'missing override must not be fresh');
assert.strictEqual(isFreshOverride({}, NOW, MAX_AGE_MS), false, 'empty override must not be fresh');
assert.strictEqual(normalizeOverrideKey('  Alpha.COM '), 'alpha.com', 'domain key normalization');

const staleProjection = projectRowWithOverride(delta, overrides['delta.com'], NOW, MAX_AGE_MS);
assert.strictEqual(staleProjection, delta, 'stale override must return the same row reference (no override applied)');

const freshProjection = projectRowWithOverride(alpha, overrides['alpha.com'], NOW, MAX_AGE_MS);
assert.strictEqual(freshProjection.auction_end, iso(120), 'fresh override must set effective auction_end');
assert.strictEqual(freshProjection.bid_count, 3, 'fresh override must set fresh bid_count');
assert.strictEqual(freshProjection.auction_price, 15, 'fresh override must set fresh price');
assert.strictEqual(freshProjection.stream, 'godaddy-auction', 'override must never change a row\'s stream (no synthetic closeout)');

// --- 1b. Shared end+domain comparator (compareEffectiveEnd) unit coverage ---------
assert.ok(compareEffectiveEnd({ endMs: 100, domain: 'a.com' }, { endMs: 100, domain: 'b.com' }, 1) < 0,
  'ASC comparator must break same-end ties by domain ascending');
assert.ok(compareEffectiveEnd({ endMs: 100, domain: 'a.com' }, { endMs: 100, domain: 'b.com' }, -1) > 0,
  'DESC comparator must break same-end ties by domain descending (mirror of ASC)');
assert.ok(compareEffectiveEnd({ endMs: 50, domain: 'z.com' }, { endMs: 100, domain: 'a.com' }, 1) < 0,
  'end difference must dominate the domain tie-break in either direction');
assert.strictEqual(compareEffectiveEnd({ endMs: 100, domain: 'a.com' }, { endMs: 100, domain: 'a.com' }, 1), 0,
  'identical end and domain must compare equal');

// A provider snapshot can remain current while a cached page crosses its end time.
// Reusing that page would make the desktop filter every row after pagination and
// display a blank table, so cache reuse must be decided from the returned rows too.
assert.strictEqual(auctionResponseRowsAreFuture({ domains: [golf, hotel] }, NOW), true,
  'a page whose rows are all live may be reused');
assert.strictEqual(auctionResponseRowsAreFuture({ domains: [alpha, golf] }, NOW), false,
  'one ended row must invalidate the entire cached page before pagination is replayed');
assert.strictEqual(auctionResponseRowsAreFuture({ domains: [{ ...golf, auction_end: 'invalid' }] }, NOW), false,
  'an invalid end timestamp must fail closed');
assert.strictEqual(auctionResponseRowsAreFuture(null, NOW), false,
  'a malformed cached response must fail closed');
assert.strictEqual(providerResponseHasTimeDependentRows({
  domains: [{ domain: 'unrelated.shop', stream: 'unrelated-auction', auction_end: iso(30) }],
}), true, 'future provider adapters must inherit time-dependent cache expiry without a name branch');
assert.strictEqual(providerResponseHasTimeDependentRows({
  domains: [{ domain: 'warehouse.shop', stream: 'unrelated-warehouse', auction_end: null }],
}), false, 'non-auction projections remain generation-cacheable');

// --- 2. Extended inclusion + effective ordering (full live listing, ASC) ----------
let res = buildPageFromIndex(index, {}, {
  sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 20,
  dateWindow: null, dateFilterIgnoredReason: null, overrides, nowMs: NOW, maxAgeMs: MAX_AGE_MS,
});
assert.deepStrictEqual(domainsOf(res), [
  'golf.com', 'foxtrot.com', 'echo.com', 'alpha.com', 'mike.com', 'november.com', 'oscar.com', 'papa.com', 'hotel.com',
], 'alpha must re-enter and sort by its EFFECTIVE end; bravo/charlie/delta stay excluded; echo/foxtrot fall back to raw; the tied +250min cluster (stable mike/oscar + mover november/papa) must resolve by domain');
assert.strictEqual(res.total, 9, 'total must reflect projected inclusion/exclusion exactly');
assert.strictEqual(res.pageRows.find(r => r.domain === 'alpha.com').stream, 'godaddy-auction',
  'alpha row in the final page must never carry the adversarial override.stream value');

// --- 2b. Same-end stable+mover tie-break, ASC ---------------------------------------
const tiedAscOrder = domainsOf(res).filter(d => TIED_DOMAINS.includes(d));
assert.deepStrictEqual(tiedAscOrder, ['mike.com', 'november.com', 'oscar.com', 'papa.com'],
  'same-end stable (mike/oscar) and mover (november/papa) rows must interleave by domain, not group by partition');

// --- 3. Terminal exclusion for both zero and nonzero bids -------------------------
const allDomains = domainsOf(res);
assert.ok(!allDomains.includes('bravo.com'), 'zero-bid row with fresh past-end override must be excluded');
assert.ok(!allDomains.includes('charlie.com'), 'nonzero-bid row with fresh past-end override must be excluded');

// --- 4. DESC ordering mirrors ASC exactly (including the tied cluster, reversed) --
res = buildPageFromIndex(index, {}, {
  sortBy: 'auction_end', sortDir: 'DESC', pageNum: 1, limitNum: 20, overrides, nowMs: NOW, maxAgeMs: MAX_AGE_MS,
});
assert.deepStrictEqual(domainsOf(res), [
  'hotel.com', 'papa.com', 'oscar.com', 'november.com', 'mike.com', 'alpha.com', 'echo.com', 'foxtrot.com', 'golf.com',
], 'DESC must be the exact reverse of ASC effective ordering');
assert.strictEqual(res.total, 9);
const tiedDescOrder = domainsOf(res).filter(d => TIED_DOMAINS.includes(d));
assert.deepStrictEqual(tiedDescOrder, ['papa.com', 'oscar.com', 'november.com', 'mike.com'],
  'DESC tie-break must be the domain-descending mirror of ASC, not partition-dependent');

// --- 5. Paging consistency, ASC (offset/limit boundaries exact, no duplicates,
//        deliberately split the tied cluster mid-tie: page 3 ends at november.com,
//        page 4 begins at oscar.com) -----------------------------------------------
const fullAsc = ['golf.com', 'foxtrot.com', 'echo.com', 'alpha.com', 'mike.com', 'november.com', 'oscar.com', 'papa.com', 'hotel.com'];
const seen = new Set();
const collected = [];
for (let pageNum = 1; pageNum <= 5; pageNum += 1) {
  const pageRes = buildPageFromIndex(index, {}, {
    sortBy: 'auction_end', sortDir: 'ASC', pageNum, limitNum: 2, overrides, nowMs: NOW, maxAgeMs: MAX_AGE_MS,
  });
  assert.strictEqual(pageRes.total, 9, `total must stay exact on page ${pageNum}`);
  for (const d of domainsOf(pageRes)) {
    assert.ok(!seen.has(d), `duplicate domain "${d}" found across pages`);
    seen.add(d);
    collected.push(d);
  }
  if (pageNum === 3) {
    assert.deepStrictEqual(domainsOf(pageRes), ['mike.com', 'november.com'], 'page 3 must end mid-tie at november.com (stable then mover, exact boundary)');
  }
  if (pageNum === 4) {
    assert.deepStrictEqual(domainsOf(pageRes), ['oscar.com', 'papa.com'], 'page 4 must resume mid-tie at oscar.com with no overlap or gap from page 3');
  }
}
assert.deepStrictEqual(collected, fullAsc, 'paged fetches concatenated must equal the single full fetch, in the same order, even across a mid-tie page boundary');

// --- 5b. Paging consistency, DESC (different split point inside the tied cluster:
//         page 1 ends at november.com, page 2 begins at mike.com) ------------------
const fullDesc = ['hotel.com', 'papa.com', 'oscar.com', 'november.com', 'mike.com', 'alpha.com', 'echo.com', 'foxtrot.com', 'golf.com'];
const seenDesc = new Set();
const collectedDesc = [];
for (let pageNum = 1; pageNum <= 3; pageNum += 1) {
  const pageRes = buildPageFromIndex(index, {}, {
    sortBy: 'auction_end', sortDir: 'DESC', pageNum, limitNum: 4, overrides, nowMs: NOW, maxAgeMs: MAX_AGE_MS,
  });
  assert.strictEqual(pageRes.total, 9, `DESC total must stay exact on page ${pageNum}`);
  for (const d of domainsOf(pageRes)) {
    assert.ok(!seenDesc.has(d), `duplicate domain "${d}" found across DESC pages`);
    seenDesc.add(d);
    collectedDesc.push(d);
  }
  if (pageNum === 1) {
    assert.deepStrictEqual(domainsOf(pageRes), ['hotel.com', 'papa.com', 'oscar.com', 'november.com'], 'DESC page 1 must end mid-tie at november.com');
  }
  if (pageNum === 2) {
    assert.deepStrictEqual(domainsOf(pageRes), ['mike.com', 'alpha.com', 'echo.com', 'foxtrot.com'], 'DESC page 2 must resume mid-tie at mike.com with no overlap or gap from page 1');
  }
}
assert.deepStrictEqual(collectedDesc, fullDesc, 'DESC paged fetches concatenated must equal the single full DESC fetch, in the same order');

// --- 6. Date window consistency (combined with overrides) --------------------------
const dateWindow = { start: iso(0), end: iso(200) };
res = buildPageFromIndex(index, {}, {
  sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 10, dateWindow, overrides, nowMs: NOW, maxAgeMs: MAX_AGE_MS,
});
assert.deepStrictEqual(domainsOf(res), ['golf.com', 'foxtrot.com', 'echo.com', 'alpha.com'],
  'hotel/mike/november/oscar/papa (effective >= +200min) must fall outside the [0,200) date window; alpha (effective +120min) must fall inside it');
assert.strictEqual(res.total, 4);

// --- 7. hasBids filter consistency uses PROJECTED bid_count, including the tied
//        cluster (papa has 0 bids and must be excluded even though its effective end
//        ties with three included rows) -------------------------------------------
res = buildPageFromIndex(index, { hasBids: '1' }, {
  sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 10, overrides, nowMs: NOW, maxAgeMs: MAX_AGE_MS,
});
assert.deepStrictEqual(domainsOf(res), ['foxtrot.com', 'echo.com', 'alpha.com', 'mike.com', 'november.com', 'oscar.com'],
  'hasBids must exclude golf/hotel/papa (0 bids) and use alpha\'s fresh override bid_count; the tied cluster keeps its domain order minus papa');
assert.strictEqual(res.total, 6);

// --- 8. Overrides omitted entirely must reproduce the ORIGINAL fast-path result,
//        including the same-end mike/oscar stable tie-break by domain -------------
res = buildPageFromIndex(index, {}, {
  sortBy: 'auction_end', sortDir: 'ASC', pageNum: 1, limitNum: 10, nowMs: NOW,
});
assert.deepStrictEqual(domainsOf(res), [
  'golf.com', 'foxtrot.com', 'echo.com', 'bravo.com', 'charlie.com', 'mike.com', 'oscar.com', 'hotel.com', 'papa.com',
], 'without an overrides object, raw inventory must stand exactly as before (alpha/delta/november stay excluded, bravo/charlie stay included, mike/oscar tie-break by domain)');
assert.strictEqual(res.total, 9);

// --- 9. Worker forwards the same plain override contract, unchanged ---------------
const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'large-provider-worker.js'), 'utf8');
assert.ok(/overrides\s*:\s*msg\.overrides/.test(workerSrc), 'worker must forward overrides to buildPageFromIndex');
assert.ok(/nowMs\s*:\s*msg\.nowMs/.test(workerSrc), 'worker must forward nowMs to buildPageFromIndex');
assert.ok(/maxAgeMs\s*:\s*msg\.maxAgeMs/.test(workerSrc), 'worker must forward maxAgeMs to buildPageFromIndex');
assert.ok(!/readFileSync|require\('fs'\)|require\("fs"\)/.test(workerSrc), 'worker must add no filesystem access');
assert.ok(!/better-sqlite3|\.prepare\(/.test(workerSrc), 'worker must add no database access');

// --- 10. Main-thread and UI live-truth wiring ------------------------------
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const syncStart = serverSrc.indexOf('function buildGoDaddyCacheDomainsResponse');
const syncEnd = serverSrc.indexOf('\n}\n\n// Resolve the FULL filtered', syncStart);
const syncSrc = serverSrc.slice(syncStart, syncEnd);
assert.ok(/const \{ total, pageRows \} = buildPageFromIndex\(index, req\.query/.test(syncSrc), 'sync GoDaddy response must use shared future-only query logic');
assert.ok(syncSrc.includes('overrides: liveSnapshot.overrides'), 'sync GoDaddy response must pass fresh live overrides');
assert.ok(serverSrc.includes('overrides: liveSnapshot.overrides'), 'worker request must pass the same fresh live overrides');
assert.ok(serverSrc.includes("::live:${liveSnapshot.revision}"), 'GoDaddy response cache must include live revision');
assert.ok(serverSrc.includes('goDaddyResponseCache.clear();'), 'storing live observations must invalidate GoDaddy response cache');
assert.ok(serverSrc.includes('auctionResponseRowsAreFuture(entry.data, nowMs)'), 'cached auction pages must expire as soon as a returned row ends');
assert.ok(serverSrc.includes('GODADDY_ACTIVE_RESPONSE_CACHE_TTL_MS'), 'live auction totals must be periodically recounted within a current provider snapshot');
assert.ok(serverSrc.includes('timeDependent: providerResponseHasTimeDependentRows(value)'), 'all provider auction projections must derive time-dependent cache expiry from their rows');
assert.ok(serverSrc.includes('d.auction_end = new Date(endMs).toISOString()'), 'fresh live end must project onto returned rows');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const activeFilterAt = appSrc.indexOf("const filteredDomains = state.stream === 'godaddy-auction'");
const domainMapAt = appSrc.indexOf('state.domainMap = {};', activeFilterAt);
assert.ok(activeFilterAt >= 0 && domainMapAt > activeFilterAt, 'active-auction future filter must run before domainMap population');
assert.ok(appSrc.includes('Current live auction price unavailable'), 'active auction must not present stale bulk price as current');
assert.ok(appSrc.includes('Current live bid count unavailable'), 'active auction must not present stale bulk bids as current');
assert.ok(appSrc.includes('d.auction_end = new Date(endMs).toISOString()'), 'live refresh must apply a five-minute end extension');
assert.ok(appSrc.includes("document.getElementById(`row-${d.id}`)?.remove()"), 'confirmed terminal live result must remove its row');
assert.ok(appSrc.includes("if (!Number.isFinite(auctionEndMs) || auctionEndMs <= Date.now()) return '';"), 'renderRow must refuse ended active rows');
assert.ok(!appSrc.includes("state.stream === 'godaddy-closeout'\n      ? domains.filter"), 'closeouts must remain exempt from active-auction end filtering');

console.log('ok - godaddy-auction-lifecycle.test.js (live query, price, end, terminal, and closeout truth gates)');
