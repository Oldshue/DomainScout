/**
 * Namecheap Market GraphQL scraper
 *
 * Endpoint: https://aftermarketapi.namecheap.com/client/graphql
 * No auth required — public persisted query API.
 * Namecheap is the official .ai auction platform (since Feb 2025).
 */
const axios = require('axios');

const GRAPHQL = 'https://aftermarketapi.namecheap.com/client/graphql';
const QUERY_HASH = '53036454e3240fedbb832b5e2d3406505228288262aea988f15df2c4dbd9f7d1';
const TARGET_TLDS = ['ai', 'io', 'sh', 'bot', 'com', 'net', 'org'];
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 1000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function configuredMaxPages(value = process.env.NAMECHEAP_MAX_PAGES) {
  if (value === undefined || value === '') return DEFAULT_MAX_PAGES;
  const maxPages = Number(value);
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error('NAMECHEAP_MAX_PAGES must be a positive integer');
  }
  return maxPages;
}

function requiredPageCount(total, pageSize = PAGE_SIZE) {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`Namecheap sales.total must be a nonnegative integer; received ${total}`);
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`pageSize must be a positive integer; received ${pageSize}`);
  }
  return Math.ceil(total / pageSize);
}

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

function mapSaleItem(item) {
  const parsed = parseDomain(item?.product?.name);
  if (!parsed) return null;
  return {
    ...parsed,
    stream: 'namecheap-auction',
    source: 'Namecheap',
    auction_price: item.price ?? null,
    auction_end: item.endDate ?? null,
    auction_url: `https://www.namecheap.com/market/${item.product?.name || ''}`,
    bid_count: item.bidCount ?? 0,
  };
}

async function fetchPage(tld, page, pageSize = PAGE_SIZE) {
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
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.namecheap.com',
        'Referer': 'https://www.namecheap.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      timeout: 20000,
    }
  );

  const sales = resp.data?.data?.sales;
  if (!sales) throw new Error(JSON.stringify(resp.data?.errors?.[0]?.message || resp.data));
  return sales;
}

async function scrapeTLD(tld, options = {}) {
  const pageFetcher = options.fetchPage || fetchPage;
  const maxPages = options.maxPages ?? configuredMaxPages();
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error('NAMECHEAP_MAX_PAGES must be a positive integer');
  }
  const delayMs = options.pageDelayMs ?? 300;
  const firstSales = await pageFetcher(tld, 1, PAGE_SIZE);
  const total = firstSales?.total;
  const pageCount = requiredPageCount(total, PAGE_SIZE);
  console.log(`[Namecheap/.${tld}] total available: ${total}`);

  if (pageCount > maxPages) {
    throw new Error(`[Namecheap/.${tld}] requires ${pageCount} pages, exceeding NAMECHEAP_MAX_PAGES=${maxPages}`);
  }
  if (pageCount === 0) return [];

  const unique = new Map();
  for (let page = 1; page <= pageCount; page++) {
    const sales = page === 1 ? firstSales : await pageFetcher(tld, page, PAGE_SIZE);
    if (!Array.isArray(sales?.items)) {
      throw new Error(`[Namecheap/.${tld}] page ${page} did not contain an items array`);
    }
    for (const item of sales.items) {
      const mapped = mapSaleItem(item);
      if (mapped && !unique.has(mapped.domain)) unique.set(mapped.domain, mapped);
    }
    console.log(`[Namecheap/.${tld}] page ${page}: ${sales.items.length} items (${unique.size} unique)`);
    if (page < pageCount && delayMs > 0) await sleep(delayMs);
  }

  if (unique.size !== total) {
    throw new Error(`[Namecheap/.${tld}] incomplete snapshot: expected ${total} unique mapped domains, observed ${unique.size}`);
  }
  return [...unique.values()];
}

async function scrapeNamecheap() {
  console.log('[Namecheap] Starting auction scrape...');
  const allResults = [];
  for (const tld of TARGET_TLDS) {
    allResults.push(...await scrapeTLD(tld));
  }

  const seen = new Set();
  const unique = allResults.filter(row => {
    if (seen.has(row.domain)) return false;
    seen.add(row.domain);
    return true;
  });
  console.log(`[Namecheap] Done: ${unique.length} unique auction domains`);
  return unique;
}

module.exports = { fetchPage, mapSaleItem, requiredPageCount, scrapeNamecheap, scrapeTLD };
