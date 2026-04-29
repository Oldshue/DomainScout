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

async function scrapeGoDaddy() {
  console.log('[GoDaddy] Downloading auction + closeout inventories...');

  // all_listings.json.zip     → competitive auctions (Bid type)
  // closeout_listings.json.zip → closeouts (BuyNow, daily price drops)
  // These are SEPARATE files — do not try to split all_listings by auctionType
  const [allParsed, closeoutParsed] = await Promise.all([
    downloadAndParse('all_listings.json.zip'),
    downloadAndParse('closeout_listings.json.zip'),
  ]);

  const auctions = [];
  const closeouts = [];

  for (const item of (allParsed.data || [])) {
    const domParsed = parseDomain(item.domainName);
    if (!domParsed) continue;
    auctions.push({
      ...domParsed,
      stream: 'godaddy-auction',
      source: 'GoDaddy Auction',
      auction_price: parsePrice(item.price),
      auction_end: item.auctionEndTime || null,
      auction_url: item.link || `https://auctions.godaddy.com/`,
      age_years: item.domainAge || null,
      bid_count: item.numberOfBids || 0,
      _days_left: daysUntil(item.auctionEndTime),
    });
  }

  for (const item of (closeoutParsed.data || [])) {
    const domParsed = parseDomain(item.domainName);
    if (!domParsed) continue;
    closeouts.push({
      ...domParsed,
      stream: 'godaddy-closeout',
      source: 'GoDaddy Closeout',
      auction_price: parsePrice(item.price),
      auction_end: item.auctionEndTime || null,
      auction_url: item.link || `https://auctions.godaddy.com/`,
      age_years: item.domainAge || null,
      bid_count: 0,
      _days_left: daysUntil(item.auctionEndTime),
    });
  }

  console.log(`[GoDaddy] ${auctions.length} auctions + ${closeouts.length} closeouts = ${auctions.length + closeouts.length} total`);

  return [...auctions, ...closeouts];
}

module.exports = { scrapeGoDaddy };
