/**
 * Namecheap Market GraphQL scraper
 *
 * Endpoint: https://aftermarketapi.namecheap.com/client/graphql
 * No auth required — public persisted query API.
 * Namecheap is the official .ai auction platform (since Feb 2025).
 *
 * SaleTable persisted query hash: 53036454e3240fedbb832b5e2d3406505228288262aea988f15df2c4dbd9f7d1
 * filter.tld = single TLD string ('ai', 'io', 'com', etc.)
 * product.name = full domain including TLD (e.g. "example.ai")
 */
const axios = require('axios');

const GRAPHQL = 'https://aftermarketapi.namecheap.com/client/graphql';
const QUERY_HASH = '53036454e3240fedbb832b5e2d3406505228288262aea988f15df2c4dbd9f7d1';
const TARGET_TLDS = ['ai', 'io', 'sh', 'bot', 'com', 'net', 'org'];

// Max pages per TLD (100 per page)
const TLD_MAX_PAGES = { ai: 53, io: 10, sh: 5, bot: 5, com: 5, net: 3, org: 3 };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseDomain(fullName) {
  if (!fullName) return null;
  const lower = fullName.toLowerCase().trim();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const tld = '.' + lower.slice(dotIdx + 1);
  const name = lower.slice(0, dotIdx);
  if (!name || name.includes('.')) return null;
  return {
    domain: lower,
    tld,
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
  };
}

async function fetchPage(tld, page, pageSize = 100) {
  const resp = await axios.post(
    GRAPHQL,
    {
      operationName: 'SaleTable',
      variables: {
        filter: { tld },
        sort: [{ column: 'endDate', direction: 'asc' }],
        page,
        pageSize,
      },
      extensions: {
        persistedQuery: { version: 1, sha256Hash: QUERY_HASH },
      },
    },
    {
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Origin':        'https://www.namecheap.com',
        'Referer':       'https://www.namecheap.com/',
        'User-Agent':    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      timeout: 20000,
    }
  );

  const sales = resp.data?.data?.sales;
  if (!sales) throw new Error(JSON.stringify(resp.data?.errors?.[0]?.message || resp.data));
  return sales;
}

async function scrapeTLD(tld, maxPages) {
  const results = [];
  let totalAvailable = Infinity;

  for (let page = 1; page <= maxPages; page++) {
    try {
      const sales = await fetchPage(tld, page);

      if (totalAvailable === Infinity) {
        totalAvailable = sales.total ?? 0;
        console.log(`[Namecheap/.${tld}] total available: ${totalAvailable}`);
      }

      const items = sales.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        const parsed = parseDomain(item.product?.name);
        if (!parsed) continue;

        results.push({
          ...parsed,
          stream:        'namecheap-auction',
          source:        'Namecheap',
          auction_price: item.price ?? null,
          auction_end:   item.endDate ?? null,
          auction_url:   `https://www.namecheap.com/market/${item.product?.name || ''}`,
        });
      }

      console.log(`[Namecheap/.${tld}] page ${page}: ${items.length} items (${results.length} total)`);
      if (items.length < 100) break;
      if (results.length >= totalAvailable) break;

      await sleep(300);
    } catch (err) {
      console.error(`[Namecheap/.${tld}] page ${page} error: ${err.message}`);
      break;
    }
  }

  return results;
}

async function scrapeNamecheap() {
  console.log('[Namecheap] Starting auction scrape...');
  const allResults = [];

  for (const tld of TARGET_TLDS) {
    const maxPages = TLD_MAX_PAGES[tld] ?? 5;
    const results = await scrapeTLD(tld, maxPages);
    allResults.push(...results);
  }

  const seen = new Set();
  const unique = allResults.filter(r => {
    if (seen.has(r.domain)) return false;
    seen.add(r.domain);
    return true;
  });

  console.log(`[Namecheap] Done: ${unique.length} unique auction domains`);
  return unique;
}

module.exports = { scrapeNamecheap };
