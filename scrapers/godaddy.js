/**
 * GoDaddy Auctions + Closeouts — inventory.auctions.godaddy.com
 *
 * GoDaddy publishes free bulk JSON inventory files updated every ~hour.
 * No API key, no auth, no scraping — direct zip download.
 *
 * Files used:
 *   all_listings.json.zip         — all active auctions (Bid type)
 *   closeout_listings.json.zip    — closeouts (BuyNow, price drops daily ~$11→$5)
 *
 * auctionType values: "Bid" = competitive auction, "BuyNow" = closeout
 */
const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');
const unzip = promisify(require('zlib').unzip);

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

async function downloadAndParse(filename) {
  const url = `${BASE}/${filename}`;
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DomainScout/1.0)',
    },
  });

  // It's a zip file — unzip it
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(Buffer.from(resp.data));
  const entries = zip.getEntries();
  if (!entries.length) throw new Error(`No entries in ${filename}`);

  const jsonStr = entries[0].getData().toString('utf8');
  return JSON.parse(jsonStr);
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
  if (!priceStr) return null;
  const n = parseFloat(priceStr.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const diff = new Date(isoDate) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

async function scrapeFile(filename, stream) {
  const parsed = await downloadAndParse(filename);
  const items = parsed.data || [];
  const results = [];

  for (const item of items) {
    const domParsed = parseDomain(item.domainName);
    if (!domParsed) continue;

    results.push({
      ...domParsed,
      stream,
      source: item.auctionType === 'BuyNow' ? 'GoDaddy Closeout' : 'GoDaddy Auction',
      auction_price: parsePrice(item.price),
      auction_end: item.auctionEndTime || null,
      auction_url: item.link || `https://auctions.godaddy.com/`,
      age_years: item.domainAge || null,
      // Extra context — days remaining
      _days_left: daysUntil(item.auctionEndTime),
    });
  }

  return results;
}

async function scrapeGoDaddy() {
  console.log('[GoDaddy] Downloading inventory...');

  // all_listings contains both auctions (Bid) and closeouts (BuyNow)
  const results = await scrapeFile('all_listings.json.zip', 'godaddy-auction');

  const auctions  = results.filter(d => d.source === 'GoDaddy Auction').length;
  const closeouts = results.filter(d => d.source === 'GoDaddy Closeout').length;
  console.log(`[GoDaddy] ${auctions} auctions + ${closeouts} closeouts = ${results.length} total`);

  return results;
}

module.exports = { scrapeGoDaddy };
