/**
 * Namecheap Market current-auction adapter.
 *
 * The public GraphQL table has a hard 10,000-result window and cannot be used as
 * a complete inventory feed. The supported customer API is cursor-paginated;
 * this adapter publishes nothing unless the cursor is exhausted and the full
 * snapshot passes basic volume/date validation.
 */
const axios = require('axios');
const deviceCredentialStore = require('../lib/device-credential-store');

const API_URL = 'https://aftermarketapi.namecheap.com/client/api/sales';
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MIN_ACTIVE_ROWS = 100000;
const KEYCHAIN_SERVICE = 'domainscout.namecheap.auctions';
const KEYCHAIN_ACCOUNT = 'hamp';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function positiveInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`expected a positive integer; received ${value}`);
  return n;
}

function configuredApiKey(options = {}) {
  if (options.apiKey) return String(options.apiKey).trim();
  if (process.platform !== 'darwin') return '';
  try {
    const store = options.credentialStore || deviceCredentialStore;
    return store.readUtf8Credential({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT,
      helperPath: options.credentialHelper,
    }).trim();
  } catch (_) {
    return '';
  }
}

function parseDomain(fullName) {
  if (!fullName) return null;
  const lower = String(fullName).toLowerCase().trim();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 1 || dotIdx === lower.length - 1) return null;
  const name = lower.slice(0, dotIdx);
  if (name.includes('.')) return null;
  return {
    domain: lower,
    base_name: name,
    tld: `.${lower.slice(dotIdx + 1)}`,
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
  };
}

function mapSaleItem(item) {
  const fullName = item?.name || item?.product?.name;
  const parsed = parseDomain(fullName);
  if (!parsed) return null;
  return {
    ...parsed,
    stream: 'namecheap-auction',
    source: 'Namecheap',
    auction_price: item.price ?? item.currentPrice ?? null,
    auction_end: item.endDate ?? null,
    auction_url: `https://www.namecheap.com/market/${parsed.domain}`,
    bid_count: item.bidCount ?? 0,
    age_years: item.registeredDate
      ? Math.max(0, Math.floor((Date.now() - Date.parse(item.registeredDate)) / 31557600000))
      : null,
  };
}

async function fetchApiPage({ apiKey, cursor = null, pageSize = DEFAULT_PAGE_SIZE, client = axios }) {
  const params = {
    pageSize,
    orderBy: 'end_time',
    direction: 'asc',
    nsfw: true,
  };
  if (cursor) params.cursor = cursor;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await client.get(API_URL, {
        params,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        timeout: 30000,
      });
      return response.data;
    } catch (err) {
      const status = Number(err.response?.status || 0);
      const retryable = status === 429 || status >= 500 || status === 0;
      if (!retryable || attempt === 6) throw err;
      const retryAfter = Number(err.response?.headers?.['retry-after']);
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(60000, retryAfter * 1000)
        : Math.min(30000, 500 * (2 ** (attempt - 1)));
      await sleep(delayMs);
    }
  }
  throw new Error('[Namecheap] page retry loop exhausted');
}

function validateSnapshot(rows, options = {}) {
  const minRows = positiveInt(options.minRows ?? process.env.NAMECHEAP_MIN_ACTIVE_ROWS, DEFAULT_MIN_ACTIVE_ROWS);
  const nowMs = options.nowMs ?? Date.now();
  const unique = new Set();
  let futureRows = 0;
  let invalidRows = 0;
  for (const row of rows || []) {
    if (!row?.domain || !row?.auction_end || !Number.isFinite(Date.parse(row.auction_end))) {
      invalidRows += 1;
      continue;
    }
    if (unique.has(row.domain)) invalidRows += 1;
    unique.add(row.domain);
    if (Date.parse(row.auction_end) > nowMs) futureRows += 1;
  }
  const errors = [];
  if (!Array.isArray(rows)) errors.push('snapshot is not an array');
  if (unique.size < minRows) errors.push(`only ${unique.size} unique rows; minimum is ${minRows}`);
  if (futureRows !== unique.size) errors.push(`${unique.size - futureRows} rows are not current future auctions`);
  if (invalidRows) errors.push(`${invalidRows} invalid or duplicate rows`);
  return { ok: errors.length === 0, errors, rowCount: unique.size, futureRows, minRows };
}

async function scrapeNamecheap(options = {}) {
  const apiKey = configuredApiKey(options);
  if (!apiKey) {
    throw new Error(
      `Namecheap complete inventory is unavailable: store an Auctions API key in the DomainScout device credential store for service ${KEYCHAIN_SERVICE} account ${KEYCHAIN_ACCOUNT}`
    );
  }
  const pageSize = positiveInt(options.pageSize ?? process.env.NAMECHEAP_API_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const pageFetcher = options.fetchPage || (args => fetchApiPage({ ...args, apiKey, pageSize }));
  const rows = [];
  const seenCursors = new Set();
  let cursor = null;
  let pages = 0;

  console.log('[Namecheap] Fetching complete cursor-paginated auction inventory...');
  while (true) {
    const payload = await pageFetcher({ apiKey, cursor, pageSize });
    if (!payload || !Array.isArray(payload.items) || typeof payload.hasMore !== 'boolean') {
      throw new Error('[Namecheap] invalid Auctions API page shape');
    }
    pages += 1;
    for (const item of payload.items) {
      if (item.status && item.status !== 'active') continue;
      if (item.saleType && item.saleType !== 'auction') continue;
      const mapped = mapSaleItem(item);
      if (mapped && Date.parse(mapped.auction_end) > Date.now()) rows.push(mapped);
    }
    if (!payload.hasMore) break;
    if (!payload.nextCursor || seenCursors.has(payload.nextCursor)) {
      throw new Error('[Namecheap] cursor pagination did not advance');
    }
    seenCursors.add(payload.nextCursor);
    cursor = payload.nextCursor;
  }

  const validation = validateSnapshot(rows, options);
  if (!validation.ok) throw new Error(`[Namecheap] incomplete snapshot: ${validation.errors.join('; ')}`);
  Object.defineProperty(rows, 'snapshotEvidence', {
    value: { source: 'official-customer-api', fetchedAt: new Date().toISOString(), pages, ...validation },
    enumerable: false,
  });
  console.log(`[Namecheap] Complete: ${rows.length.toLocaleString()} active auctions across ${pages.toLocaleString()} pages`);
  return rows;
}

module.exports = {
  API_URL,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  configuredApiKey,
  fetchApiPage,
  mapSaleItem,
  parseDomain,
  scrapeNamecheap,
  validateSnapshot,
};
