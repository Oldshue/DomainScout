/**
 * Dynadot auction adapter.
 *
 * Two supported routes, each used for what it is good at:
 *
 *   - lookupDynadotListing(domain): the exact current auction for ONE name, from the
 *     public marketplace lookup (no account). This is how flagged and watched names
 *     are followed; it is a handful of requests, paced.
 *
 *   - scrapeDynadotAuctions(): the COMPLETE board through Dynadot's official account
 *     API (get_open_auctions, paged). It needs the account's API key in
 *     DOMAINSCOUT_DYNADOT_API_KEY. The public site list is not a board feed: it
 *     requires sign-in past page index 10 and Dynadot's edge blocks an address that
 *     pages it in bulk, so it is deliberately not used for that.
 */
const axios = require('axios');

const STREAM = 'dynadot-auction';
const MARKET_URL = 'https://www.dynadot.com/dynadot-vue-api/dynadot-service/marketplace-api';
const MARKET_HEADERS = {
  Accept: 'application/json',
  Referer: 'https://www.dynadot.com/market/auction',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};
const API_URL = 'https://api.dynadot.com/api3.json';
const API_PAGE_SIZE = 1000;
const API_MAX_PAGES = 5000;
// Regular accounts: one thread, 60 requests a minute.
const API_MIN_INTERVAL_MS = 1100;
const LOOKUP_TYPES = [
  { type: 'EXPIRED_AUCTION', source: 'Dynadot' },
  { type: 'USER_AUCTION', source: 'Dynadot user auction' },
];
const API_TYPE_SOURCES = { expired: 'Dynadot', user: 'Dynadot user auction' };

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function configuredApiKey(options = {}) {
  return String(options.apiKey || process.env.DOMAINSCOUT_DYNADOT_API_KEY || '').trim();
}

function boardConfigured(options = {}) {
  return configuredApiKey(options) !== '';
}

// One auction record (public lookup or official API shape) as a DomainScout row.
function mapRecord(record, { source = 'Dynadot' } = {}) {
  const domain = String(record?.domain || '').toLowerCase().trim();
  const dot = domain.indexOf('.');
  if (dot < 1 || dot === domain.length - 1) return null;
  const name = domain.slice(0, dot);
  const endMs = Number(record.end_time_stamp);
  if (!Number.isFinite(endMs) || endMs <= 0) return null;
  const price = parseFloat(String(record.current_bid_price ?? record.bid_price ?? '').replace(/[^0-9.]/g, ''));
  const display = String(record.utf_name || record.utf8_name || domain).toLowerCase();
  return {
    domain,
    base_name: name,
    tld: domain.slice(dot),
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
    stream: STREAM,
    source,
    auction_price: Number.isFinite(price) ? price : null,
    auction_end: new Date(endMs).toISOString(),
    auction_url: `https://www.dynadot.com/market/auction/${encodeURIComponent(display)}`,
    bid_count: Number(record.bids) || 0,
    age_years: Number(record.age) > 0 ? Number(record.age) : null,
  };
}

// Exact answer for one name: its current Dynadot auction, or null when Dynadot says
// it has none. Anything that is not one of those two answers (blocked, changed
// shape, network) throws, so "could not look" is never read as "not listed".
async function lookupDynadotListing(domain, options = {}) {
  const name = String(domain || '').toLowerCase().trim();
  if (!name) return null;
  const client = options.client || axios;
  for (const { type, source } of LOOKUP_TYPES) {
    const response = await client.request({
      method: 'post',
      url: MARKET_URL,
      params: { command: 'get_aftermarket_item', aftermarket_type: type, domain: name },
      data: '',
      headers: MARKET_HEADERS,
      timeout: options.timeoutMs || 20000,
      validateStatus: () => true,
    });
    const payload = response.data;
    if (response.status !== 200 || !payload || typeof payload !== 'object') {
      throw new Error(`[Dynadot] lookup refused for ${name}: HTTP ${response.status}`);
    }
    if (payload.code === 200 && payload.data?.data) {
      const mapped = mapRecord(payload.data.data, { source });
      if (mapped && mapped.domain === name && Date.parse(mapped.auction_end) > (options.nowMs ?? Date.now())) return mapped;
      continue;
    }
    if (/can ?not find/i.test(String(payload.msg || ''))) continue;
    throw new Error(`[Dynadot] lookup for ${name} answered ${payload.code}: ${String(payload.msg || 'unknown').slice(0, 160)}`);
  }
  return null;
}

function auctionListFrom(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.auction_list)) return payload;
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object' && Array.isArray(value.auction_list)) return value;
  }
  return null;
}

function apiErrorFrom(payload) {
  if (!payload || typeof payload !== 'object') return 'non-JSON response';
  const bodies = [payload, ...Object.values(payload).filter(v => v && typeof v === 'object' && !Array.isArray(v))];
  for (const body of bodies) {
    const status = String(body.status || body.Status || '').toLowerCase();
    if (status === 'error' || body.error || body.Error) return String(body.error || body.Error || 'error').slice(0, 300);
  }
  return null;
}

async function fetchApiPage({ apiKey, type, pageIndex, pageSize = API_PAGE_SIZE, client = axios }) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await client.get(API_URL, {
        params: { key: apiKey, command: 'get_open_auctions', currency: 'usd', type, count_per_page: pageSize, page_index: pageIndex },
        headers: { Accept: 'application/json' },
        timeout: 60000,
      });
      const body = auctionListFrom(response.data);
      if (body) return body.auction_list;
      const apiError = apiErrorFrom(response.data);
      // An account-level refusal (bad key, no API access) will not change on retry.
      throw Object.assign(new Error(`[Dynadot] get_open_auctions ${type} page ${pageIndex}: ${apiError || 'no auction_list in response'}`), { final: Boolean(apiError) });
    } catch (err) {
      lastError = err;
      if (err.final || attempt === 5) break;
      await sleep(Math.min(30000, 2000 * (2 ** (attempt - 1))));
    }
  }
  // Never let the key reach a log line through an axios URL.
  throw new Error(String(lastError?.message || lastError).replace(/key=[^&\s]+/g, 'key=<redacted>'));
}

async function scrapeDynadotAuctions(options = {}) {
  const apiKey = configuredApiKey(options);
  if (!apiKey && !options.fetchPage) {
    throw new Error('Dynadot complete board is unavailable: set DOMAINSCOUT_DYNADOT_API_KEY to the account API key (Dynadot account > Tools > API)');
  }
  const fetchPage = options.fetchPage || (args => fetchApiPage({ ...args, apiKey }));
  const minIntervalMs = options.minIntervalMs ?? API_MIN_INTERVAL_MS;
  const startedAt = Date.now();
  const byDomain = new Map();
  const types = [];
  console.log('[Dynadot] Fetching the complete open-auction board from the account API...');
  for (const [type, source] of Object.entries(API_TYPE_SOURCES)) {
    let pages = 0;
    let rows = 0;
    // The documented first page is 1. Page 0 is read too and de-duplicated, so the
    // board is complete whichever index the API treats as first.
    for (let pageIndex = 0; ; pageIndex += 1) {
      if (pageIndex >= API_MAX_PAGES) throw new Error(`[Dynadot] ${type} pagination exceeded ${API_MAX_PAGES} pages`);
      const pageStartedAt = Date.now();
      let list;
      try {
        list = await fetchPage({ type, pageIndex, pageSize: API_PAGE_SIZE });
      } catch (err) {
        // An API that numbers pages from 1 may refuse page 0; page 1 then decides.
        if (pageIndex !== 0) throw err;
        list = [];
      }
      pages += 1;
      let added = 0;
      for (const record of list) {
        const mapped = mapRecord(record, { source });
        if (!mapped || byDomain.has(mapped.domain)) continue;
        byDomain.set(mapped.domain, mapped);
        added += 1;
      }
      rows += added;
      if (pages % 50 === 0) console.log(`[Dynadot] ${type}: ${pages} pages, ${rows.toLocaleString()} rows`);
      if (pageIndex >= 1 && list.length < API_PAGE_SIZE) break;
      if (pageIndex >= 2 && list.length > 0 && added === 0) {
        throw new Error(`[Dynadot] ${type} pagination did not advance at page ${pageIndex}`);
      }
      const wait = minIntervalMs - (Date.now() - pageStartedAt);
      if (wait > 0) await sleep(wait);
    }
    types.push({ type, pages, rows });
    console.log(`[Dynadot] ${type}: ${rows.toLocaleString()} auctions across ${pages} pages`);
  }
  const nowMs = options.nowMs ?? Date.now();
  const current = [...byDomain.values()].filter(row => Date.parse(row.auction_end) > nowMs);
  Object.defineProperty(current, 'snapshotEvidence', {
    value: { source: 'dynadot-account-api-get_open_auctions', fetchedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, types },
    enumerable: false,
  });
  console.log(`[Dynadot] Complete: ${current.length.toLocaleString()} current auctions`);
  return current;
}

module.exports = {
  API_PAGE_SIZE,
  STREAM,
  boardConfigured,
  configuredApiKey,
  fetchApiPage,
  lookupDynadotListing,
  mapRecord,
  scrapeDynadotAuctions,
};
