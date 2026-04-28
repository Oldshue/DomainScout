/**
 * Dynadot Marketplace API
 * Direct POST to their internal API — no auth required.
 * 539K+ domains across EXPIRED_AUCTION, BACKORDER, USER_LISTING types.
 */
const axios = require('axios');

const TARGET_TLDS = ['.com', '.io', '.ai', '.sh', '.bot', '.net', '.org'];

function matchesTLD(d) { return TARGET_TLDS.some(t => d.endsWith(t)); }

function parseDomain(domain) {
  if (!domain) return null;
  const lower = domain.toLowerCase().trim();
  const dotIdx = lower.lastIndexOf('.');
  const tld = dotIdx >= 0 ? lower.slice(dotIdx) : '';
  const name = dotIdx >= 0 ? lower.slice(0, dotIdx) : lower;
  if (!matchesTLD(lower) || name.includes('.') || !name) return null;
  return { domain: lower, tld, length: name.length, has_numbers: /\d/.test(name) ? 1 : 0, has_hyphens: /-/.test(name) ? 1 : 0 };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const BASE_URL = 'https://www.dynadot.com/dynadot-vue-api/dynadot-service/marketplace-api';
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Referer': 'https://www.dynadot.com/market/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const TYPE_STREAM_MAP = {
  EXPIRED_AUCTION: 'pending-delete',
  BACKORDER:       'pending-delete',
  USER_LISTING:    'marketplace',
};

async function fetchType(type, maxPages = 2, pageSize = 100) {
  const results = [];
  const stream = TYPE_STREAM_MAP[type] || 'marketplace';

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${BASE_URL}?command=get_list&aftermarket_type=${type}&page_size=${pageSize}&page_num=${page}&lang=en`;
      const resp = await axios.post(url, {}, { headers: HEADERS, timeout: 20000 });
      const records = resp.data?.data?.records || [];
      if (records.length === 0) break;

      for (const r of records) {
        const domain = (r.domain || r.utf8_name || '').toLowerCase();
        const parsed = parseDomain(domain);
        if (!parsed) continue;

        const priceRaw = String(r.bid_price || r.price || '').replace(/[^0-9.]/g, '');
        results.push({
          ...parsed,
          stream,
          source: `Dynadot ${type.replace('_', ' ').toLowerCase()}`,
          auction_price: parseFloat(priceRaw) || null,
          auction_end: r.end_time ? new Date(r.end_time).toISOString() : null,
          auction_url: `https://www.dynadot.com/market/domain/${encodeURIComponent(domain)}`,
        });
      }

      await sleep(800);
    } catch (err) {
      console.error(`[Dynadot/${type}/p${page}]:`, err.message);
      break;
    }
  }

  return results;
}

async function scrapeDynadot() {
  console.log('[Dynadot] Fetching expired auctions + backorders...');
  const [expired, backorder] = await Promise.all([
    fetchType('EXPIRED_AUCTION', 3),
    fetchType('BACKORDER', 2),
  ]);

  const all = [...expired, ...backorder];
  const seen = new Set();
  return all.filter(d => {
    if (!d || seen.has(d.domain)) return false;
    seen.add(d.domain);
    return true;
  });
}

module.exports = { scrapeDynadot };
