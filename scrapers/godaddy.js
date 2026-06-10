/**
 * GoDaddy Auctions + Closeouts — inventory.auctions.godaddy.com
 *
 * GoDaddy publishes free bulk JSON inventory files updated every ~hour.
 * No API key, no auth, no scraping — direct zip download.
 *
 * Files used:
 *   all_biddable_auctions.json.zip — active biddable auctions
 *   closeout_listings.json.zip     — closeouts (BuyNow, price drops daily ~$11→$5)
 *   expiring_service_auctions.csv.zip — CSV fallback if the JSON auction file fails
 *
 * auctionType values: "Bid" = competitive auction, "BuyNow" = closeout
 */
const axios = require('axios');
const { constants: bufferConstants } = require('buffer');

const BASE = 'https://inventory.auctions.godaddy.com';

// TLDs we care about — filter to keep result set manageable
// GoDaddy has hundreds of thousands of listings
const TARGET_TLDS = new Set([
  '.com', '.net', '.org', '.io', '.ai', '.app', '.dev', '.co',
  '.sh', '.bot', '.xyz', '.info', '.biz', '.us', '.me', '.tv',
  '.cc', '.gg', '.vc', '.tech', '.online', '.store', '.shop',
  '.club', '.pro', '.media', '.agency', '.digital', '.solutions',
]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseCsvRecords(text, onRecord) {
  let row = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.some(value => value !== '')) onRecord(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field || row.length) pushRow();
}

function normalizeCsvKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsvPayload(filename, data) {
  const text = Buffer.from(data).toString('utf8');
  let headers = null;
  const rows = [];
  parseCsvRecords(text, (record) => {
    if (!headers) {
      headers = record.map(normalizeCsvKey);
      return;
    }
    const item = {};
    for (let i = 0; i < headers.length; i++) {
      if (headers[i]) item[headers[i]] = record[i] ?? '';
    }
    rows.push(item);
  });
  return { data: rows, sourceFormat: 'csv', filename };
}

function parseJsonPayload(filename, data) {
  const buffer = Buffer.from(data);
  if (/\.zip$/i.test(filename)) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (!entries.length) throw new Error(`No entries in ${filename}`);
    const entry = entries[0];
    if (/\.csv$/i.test(entry.entryName)) {
      return parseCsvPayload(filename, entry.getData());
    }
    if (entry.header.size > bufferConstants.MAX_STRING_LENGTH) {
      throw new Error(`${filename} JSON is too large for in-memory parse (${entry.header.size} bytes)`);
    }
    return JSON.parse(entry.getData().toString('utf8'));
  }
  if (/\.csv$/i.test(filename)) return parseCsvPayload(filename, buffer);
  if (buffer.length > bufferConstants.MAX_STRING_LENGTH) {
    throw new Error(`${filename} JSON is too large for in-memory parse (${buffer.length} bytes)`);
  }
  return JSON.parse(buffer.toString('utf8'));
}

async function downloadAndParse(filename) {
  const url = `${BASE}/${filename}`;
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DomainScout/1.0)',
    },
  });

  return parseJsonPayload(filename, resp.data);
}

async function downloadFirstAvailable(filenames, label) {
  let lastErr = null;
  for (const filename of filenames) {
    try {
      const parsed = await downloadAndParse(filename);
      return { parsed, filename };
    } catch (err) {
      lastErr = err;
      console.warn(`[GoDaddy] ${label}: ${filename} unavailable (${err.response?.status || err.message})`);
    }
  }
  throw lastErr || new Error(`No ${label} inventory file available`);
}

function parseDomain(domainName) {
  if (!domainName) return null;
  const lower = domainName.toLowerCase().trim();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const tld = lower.slice(dotIdx);
  const name = lower.slice(0, dotIdx);
  if (!name || name.includes('.')) return null;
  if (!TARGET_TLDS.has(tld)) return null;
  return {
    domain: lower,
    tld,
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
  };
}

function parsePrice(priceStr) {
  if (priceStr === null || priceStr === undefined || priceStr === '') return null;
  if (typeof priceStr === 'number') return Number.isFinite(priceStr) ? priceStr : null;
  const n = parseFloat(String(priceStr).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function firstValue(item, keys) {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== '') return item[key];
  }
  return null;
}

function parseInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const diff = new Date(isoDate) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function parseAuctionEnd(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*\((PDT|PST)\)$/i);
  if (!m) return raw;
  let [, mm, dd, yyyy, hh, min, ampm, zone] = m;
  let hour = parseInt(hh, 10);
  if (/PM/i.test(ampm) && hour !== 12) hour += 12;
  if (/AM/i.test(ampm) && hour === 12) hour = 0;
  const offset = zone.toUpperCase() === 'PDT' ? '-07:00' : '-08:00';
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${min}:00${offset}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

async function scrapeFile(filename, stream) {
  const parsed = await downloadAndParse(filename);
  const items = parsed.data || [];

  // Parse all valid domains first
  const parsed_domains = [];
  for (const item of items) {
    const domParsed = parseDomain(item.domainName);
    if (!domParsed) continue;
    parsed_domains.push({
      ...domParsed,
      stream,
      source: item.auctionType === 'BuyNow' ? 'GoDaddy Closeout' : 'GoDaddy Auction',
      auction_price: parsePrice(item.price),
      auction_end: item.auctionEndTime || null,
      auction_url: item.link || `https://auctions.godaddy.com/`,
      age_years: item.domainAge || null,
      bid_count: item.numberOfBids || 0,
      _days_left: daysUntil(item.auctionEndTime),
    });
  }

  return parsed_domains;
}

// Extract items from JSON — inventory files use either {data:[...]} or a bare array [...]
function extractItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.items)) return parsed.items;
  if (Array.isArray(parsed.listings)) return parsed.listings;
  return [];
}

function extractMetrics(item) {
  const metrics = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (!/(majestic|estibot|semrush|valuation|traffic|trust|citation|backlink|referring)/i.test(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    metrics[key] = value;
  }
  return Object.keys(metrics).length ? metrics : null;
}

function parseListing(item, stream, source, sourceFeed) {
  const domainName = firstValue(item, ['domainName', 'domain', 'name', 'domainname']);
  const domParsed = parseDomain(domainName);
  if (!domParsed) return null;
  const auctionEnd = parseAuctionEnd(firstValue(item, ['auctionEndTime', 'auctionEnd', 'endTime', 'endDate', 'expirationDate', 'timeleft']));
  return {
    ...domParsed,
    stream,
    source,
    source_feed: sourceFeed,
    auction_price: parsePrice(firstValue(item, ['price', 'currentPrice', 'minimumBid', 'buyNowPrice'])),
    auction_end: auctionEnd,
    auction_url: firstValue(item, ['link', 'auctionUrl', 'url']) || `https://auctions.godaddy.com/`,
    age_years: parseInteger(firstValue(item, ['domainAge', 'age', 'ageYears', 'domainage'])),
    bid_count: parseInteger(firstValue(item, ['numberOfBids', 'bidCount', 'bids'])) || 0,
    metrics: extractMetrics(item),
    _days_left: daysUntil(auctionEnd),
  };
}

function dedupeListings(domains) {
  return [...new Map(domains.map(domain => [domain.domain, domain])).values()];
}

async function scrapeGoDaddy() {
  console.log('[GoDaddy] Downloading auction + closeout inventories...');

  let auctionFile = null;
  try {
    auctionFile = await downloadFirstAvailable([
      'all_biddable_auctions.json.zip',
    ], 'auction');
  } catch (auctionErr) {
    console.warn(`[GoDaddy] auction JSON unavailable; trying CSV fallback (${auctionErr.response?.status || auctionErr.message})`);
    auctionFile = await downloadFirstAvailable([
      'expiring_service_auctions.csv.zip',
    ], 'auction-csv');
  }

  const closeoutFile = await downloadFirstAvailable([
    'closeout_listings.json.zip',
  ], 'closeout');

  const auctions = [];
  const closeouts = [];

  for (const item of extractItems(auctionFile.parsed)) {
    const auctionType = String(firstValue(item, ['auctionType', 'auctiontype']) || '').toLowerCase();
    const isCloseout = auctionType.includes('buynow') || auctionType.includes('buy now');
    const parsed = parseListing(
      item,
      isCloseout ? 'godaddy-closeout' : 'godaddy-auction',
      isCloseout ? 'GoDaddy Closeout' : 'GoDaddy Auction',
      auctionFile.filename
    );
    if (!parsed) continue;
    if (isCloseout) closeouts.push(parsed);
    else auctions.push(parsed);
  }

  for (const item of extractItems(closeoutFile.parsed)) {
    const parsed = parseListing(item, 'godaddy-closeout', 'GoDaddy Closeout', closeoutFile.filename);
    if (parsed) {
      parsed.bid_count = 0;
      closeouts.push(parsed);
    }
  }

  const uniqueAuctions = dedupeListings(auctions);
  const uniqueCloseouts = dedupeListings(closeouts);

  console.log(`[GoDaddy] ${uniqueAuctions.length} auctions (${auctionFile.filename}) + ${uniqueCloseouts.length} closeouts (${closeoutFile.filename}) = ${uniqueAuctions.length + uniqueCloseouts.length} total`);

  return [...uniqueAuctions, ...uniqueCloseouts];
}

module.exports = { scrapeGoDaddy };
