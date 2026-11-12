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
const crypto = require('crypto');

const BASE = 'https://inventory.auctions.godaddy.com';

// TLDs we care about — filter to keep result set manageable
// GoDaddy has hundreds of thousands of listings
const TARGET_TLDS = new Set([
  '.com', '.net', '.org', '.io', '.ai', '.app', '.dev', '.co',
  '.sh', '.bot', '.xyz', '.info', '.biz', '.us', '.me', '.tv',
  '.cc', '.gg', '.vc', '.tech', '.online', '.store', '.shop',
  '.club', '.pro', '.media', '.agency', '.digital', '.solutions',
]);

/** Text is handed to the CSV parser in pieces of about this many bytes. */
const CSV_CHUNK_BYTES = 4 * 1024 * 1024;

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

/**
 * Incremental form of parseCsvRecords: feed it text in pieces of any size and
 * it calls onRecord for each complete row, keeping only the row in progress.
 * Same grammar (quoted fields, doubled quotes, CR ignored outside quotes).
 */
function createCsvRecordParser(onRecord) {
  let row = [];
  let field = '';
  let inQuotes = false;
  let quotePending = false; // a quote ended the previous piece inside a quoted field
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    pushField();
    if (row.some(value => value !== '')) onRecord(row);
    row = [];
  };
  const plain = (ch) => {
    if (ch === '"') inQuotes = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') pushRow();
    else if (ch !== '\r') field += ch;
  };
  return {
    write(text) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quotePending) {
          quotePending = false;
          if (ch === '"') { field += '"'; continue; }
          inQuotes = false;
          plain(ch);
          continue;
        }
        if (inQuotes) {
          if (ch === '"') quotePending = true;
          else field += ch;
          continue;
        }
        plain(ch);
      }
    },
    end() {
      if (quotePending) { quotePending = false; inQuotes = false; }
      if (field || row.length) pushRow();
    },
  };
}

/** Turns CSV records into header-keyed items one at a time (first record = headers). */
function csvItemSink(onItem) {
  let headers = null;
  return (record) => {
    if (!headers) { headers = record.map(normalizeCsvKey); return; }
    const item = {};
    for (let i = 0; i < headers.length; i++) {
      if (headers[i]) item[headers[i]] = record[i] ?? '';
    }
    onItem(item);
  };
}

/**
 * Inflates the first entry of a zip and hands its text to onText in pieces,
 * so the expanded file is never held whole. Resolves with the entry name.
 */
function inflateFirstZipEntry(filename, compressed, onText) {
  const AdmZip = require('adm-zip');
  const zlib = require('zlib');
  const { StringDecoder } = require('string_decoder');
  const entries = new AdmZip(compressed).getEntries();
  if (!entries.length) throw new Error(`No entries in ${filename}`);
  const entry = entries[0];
  const method = entry.header.method;
  const raw = entry.getCompressedData();
  const decoder = new StringDecoder('utf8');
  if (method === 0) { // stored
    for (let at = 0; at < raw.length; at += CSV_CHUNK_BYTES) onText(decoder.write(raw.subarray(at, at + CSV_CHUNK_BYTES)));
    onText(decoder.end());
    return Promise.resolve(entry.entryName);
  }
  if (method !== 8) throw new Error(`${filename}: unsupported zip compression method ${method}`);
  return new Promise((resolve, reject) => {
    const inflate = zlib.createInflateRaw({ chunkSize: CSV_CHUNK_BYTES });
    inflate.on('data', (chunk) => { try { onText(decoder.write(chunk)); } catch (err) { inflate.destroy(err); } });
    inflate.on('error', reject);
    inflate.on('end', () => { try { onText(decoder.end()); resolve(entry.entryName); } catch (err) { reject(err); } });
    inflate.end(raw);
  });
}

async function downloadCompressed(filename) {
  const url = `${BASE}/${filename}`;
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DomainScout/1.0)' },
  });
  const compressed = Buffer.from(resp.data);
  return {
    compressed,
    evidence: {
      sourceUrl: url,
      sourceFeed: filename,
      fetchedAt: new Date().toISOString(),
      sourceLastModified: resp.headers?.['last-modified'] || null,
      sourceEtag: resp.headers?.etag || null,
      compressedBytes: compressed.length,
      compressedSha256: crypto.createHash('sha256').update(compressed).digest('hex'),
    },
  };
}

/**
 * Downloads one inventory file and calls onItem for each listing in it.
 * A zipped CSV is inflated and parsed in pieces (no expanded text, no row
 * array); JSON is parsed whole, as its format requires, and released when
 * this returns. Resolves with the download evidence.
 */
async function forEachInventoryItem(filename, onItem) {
  const { compressed, evidence } = await downloadCompressed(filename);
  if (/\.csv\.zip$/i.test(filename)) {
    const parser = createCsvRecordParser(csvItemSink(onItem));
    await inflateFirstZipEntry(filename, compressed, text => parser.write(text));
    parser.end();
    return evidence;
  }
  for (const item of extractItems(parseJsonPayload(filename, compressed))) onItem(item);
  return evidence;
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

  const compressed = Buffer.from(resp.data);
  return {
    parsed: parseJsonPayload(filename, compressed),
    evidence: {
      sourceUrl: url,
      sourceFeed: filename,
      fetchedAt: new Date().toISOString(),
      sourceLastModified: resp.headers?.['last-modified'] || null,
      sourceEtag: resp.headers?.etag || null,
      compressedBytes: compressed.length,
      compressedSha256: crypto.createHash('sha256').update(compressed).digest('hex'),
    },
  };
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
  // Parse GoDaddy's explicit Pacific-zone CSV shape ourselves before Date.parse.
  // V8 accepts the string but has historically interpreted the parenthesized zone
  // inconsistently with the host timezone, shifting auction endings by hours.
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*\((PDT|PST)\)$/i);
  if (m) {
    let [, mm, dd, yyyy, hh, min, ampm, zone] = m;
    let hour = parseInt(hh, 10);
    if (/PM/i.test(ampm) && hour !== 12) hour += 12;
    if (/AM/i.test(ampm) && hour === 12) hour = 0;
    const offset = zone.toUpperCase() === 'PDT' ? '-07:00' : '-08:00';
    const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${min}:00${offset}`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
  }
  const direct = new Date(raw);
  return Number.isNaN(direct.getTime()) ? raw : direct.toISOString();
}

async function scrapeFile(filename, stream) {
  const result = await downloadAndParse(filename);
  const items = extractItems(result.parsed);

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

  Object.defineProperty(parsed_domains, 'snapshotEvidence', {
    value: result.evidence,
    enumerable: false,
  });
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
  const itemId = firstValue(item, ['itemId', 'itemID', 'itemid', 'miid']);
  const defaultUrl = itemId
    ? `https://www.godaddy.com/domain-auctions/${domParsed.domain.replace(/\./g, '-')}-${itemId}?isc=json_biddable`
    : 'https://auctions.godaddy.com/';
  return {
    ...domParsed,
    stream,
    source,
    source_feed: sourceFeed,
    auction_price: parsePrice(firstValue(item, ['price', 'currentPrice', 'minimumBid', 'buyNowPrice'])),
    auction_end: auctionEnd,
    auction_url: firstValue(item, ['link', 'auctionUrl', 'url']) || defaultUrl,
    age_years: parseInteger(firstValue(item, ['domainAge', 'age', 'ageYears', 'domainage'])),
    bid_count: parseInteger(firstValue(item, ['numberOfBids', 'bidCount', 'bids'])) || 0,
    metrics: extractMetrics(item),
    _days_left: daysUntil(auctionEnd),
  };
}

async function scrapeGoDaddy() {
  console.log('[GoDaddy] Downloading auction + closeout inventories...');

  // One file at a time, each listing reduced to its stored shape as it is
  // read; the last listing of a domain wins, at its first position (the
  // order a Map built from the listings in file order gives). Nothing raw survives its own file.
  const auctions = new Map();
  const closeouts = new Map();

  // Prefer the official CSV. It represents the same hourly biddable inventory but
  // is far smaller when expanded, so ingestion does not depend on V8's maximum JSON
  // string length as GoDaddy's catalog grows. JSON remains a verified fallback.
  let auctionFilename = null;
  let auctionEvidence = null;
  let lastErr = null;
  for (const filename of ['expiring_service_auctions.csv.zip', 'all_biddable_auctions.json.zip']) {
    auctions.clear();
    closeouts.clear();
    try {
      auctionEvidence = await forEachInventoryItem(filename, (item) => {
        const auctionType = String(firstValue(item, ['auctionType', 'auctiontype']) || '').toLowerCase();
        const isCloseout = auctionType.includes('buynow') || auctionType.includes('buy now');
        const parsed = parseListing(
          item,
          isCloseout ? 'godaddy-closeout' : 'godaddy-auction',
          isCloseout ? 'GoDaddy Closeout' : 'GoDaddy Auction',
          filename
        );
        if (!parsed) return;
        (isCloseout ? closeouts : auctions).set(parsed.domain, parsed);
      });
      auctionFilename = filename;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[GoDaddy] auction: ${filename} unavailable (${err.response?.status || err.message})`);
    }
  }
  if (!auctionFilename) throw lastErr || new Error('No auction inventory file available');

  const closeoutFilename = 'closeout_listings.json.zip';
  let closeoutEvidence;
  try {
    closeoutEvidence = await forEachInventoryItem(closeoutFilename, (item) => {
      const parsed = parseListing(item, 'godaddy-closeout', 'GoDaddy Closeout', closeoutFilename);
      if (!parsed) return;
      parsed.bid_count = 0;
      closeouts.set(parsed.domain, parsed);
    });
  } catch (err) {
    console.warn(`[GoDaddy] closeout: ${closeoutFilename} unavailable (${err.response?.status || err.message})`);
    throw err;
  }

  console.log(`[GoDaddy] ${auctions.size} auctions (${auctionFilename}) + ${closeouts.size} closeouts (${closeoutFilename}) = ${auctions.size + closeouts.size} total`);

  const domains = [...auctions.values(), ...closeouts.values()];
  auctions.clear();
  closeouts.clear();
  Object.defineProperty(domains, 'snapshotEvidence', {
    value: {
      auction: auctionEvidence,
      closeout: closeoutEvidence,
    },
    enumerable: false,
  });
  return domains;
}

// Fetch the CURRENT GoDaddy closeout feed directly (no DB). Closeouts are a
// live external feed updated ~hourly; serving them on-demand avoids importing
// ~470k rows into a space-constrained SQLite snapshot (which fills the volume).
async function fetchLiveCloseouts() {
  return scrapeFile('closeout_listings.json.zip', 'godaddy-closeout');
}

module.exports = {
  scrapeGoDaddy,
  fetchLiveCloseouts,
  _test: {
    parseCsvPayload,
    parseListing,
    createCsvRecordParser,
    csvItemSink,
    inflateFirstZipEntry,
    forEachInventoryItem,
  },
};
