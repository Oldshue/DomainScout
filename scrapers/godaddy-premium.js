/**
 * GoDaddy Premium / Seller-Listed Auctions (type 38)
 *
 * These are domains listed for sale by their current owners via GoDaddy/Afternic —
 * NOT expiring domains. They appear on the GoDaddy auction site under "Buy Now"
 * but are competitive auctions, not closeouts.
 *
 * The endpoint is Akamai-protected and requires a real browser session.
 * We use Playwright (headless Chromium) to navigate to the auctions page
 * then fetch the internal findApiProxy endpoint from within the browser context.
 *
 * ~9,900 total premium listings, updated continuously.
 * Stream: 'godaddy-premium'
 *
 * Fallback: if GODADDY_API_KEY + GODADDY_API_SECRET have aftermarket access
 * granted by Afternic, this will switch to the cleaner API approach automatically.
 */
const axios = require('axios');

const TARGET_TLDS = new Set([
  '.com', '.net', '.org', '.io', '.ai', '.app', '.dev', '.co',
  '.sh', '.bot', '.xyz', '.info', '.biz', '.us', '.me', '.tv',
  '.cc', '.gg', '.vc', '.tech', '.online', '.store', '.shop',
  '.club', '.pro', '.media', '.agency', '.digital', '.solutions',
]);

function parseDomain(domainName) {
  if (!domainName) return null;
  const lower = domainName.toLowerCase().trim();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const tld = lower.slice(dotIdx);
  const name = lower.slice(0, dotIdx);
  if (!name || name.includes('.')) return null;
  if (!TARGET_TLDS.has(tld)) return null;
  return { domain: lower, tld, length: name.length, has_numbers: /\d/.test(name) ? 1 : 0, has_hyphens: /-/.test(name) ? 1 : 0 };
}

// ── Afternic REST API (requires partner access — contact afternic-integration@godaddy.com) ──
async function scrapeViaApi() {
  const apiKey    = process.env.GODADDY_API_KEY;
  const apiSecret = process.env.GODADDY_API_SECRET;
  if (!apiKey || !apiSecret) return null;

  const auth = { Authorization: `sso-key ${apiKey}:${apiSecret}`, Accept: 'application/json' };
  try {
    const r = await axios.get('https://api.godaddy.com/v1/aftermarket/listings', {
      params: { tlds: '.ai,.io,.com,.net,.org,.sh,.bot', status: 'FOR_SALE', limit: 1000, sort: 'listed', dir: 'desc' },
      headers: auth,
      timeout: 30000,
    });
    if (r.status !== 200) return null;
    const listings = r.data.listings || (Array.isArray(r.data) ? r.data : []);
    if (!listings.length) return null;

    console.log('[GoDaddy Premium] Using Afternic API:', listings.length, 'listings');
    return listings.map(item => {
      const parsed = parseDomain(item.domain);
      if (!parsed) return null;
      return {
        ...parsed,
        stream: 'godaddy-premium',
        source: 'GoDaddy Premium',
        auction_price: item.price?.sellingPrice ?? item.price?.buyItNow ?? null,
        auction_url: `https://www.afternic.com/forsale/${item.domain}`,
        auction_end: item.expiryDate || null,
        bid_count: 0,
      };
    }).filter(Boolean);
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      // Not yet granted aftermarket access — fall through to Playwright
      return null;
    }
    throw err;
  }
}

// ── Playwright browser scrape — fetches findApiProxy from within browser context ──
async function scrapeViaBrowser() {
  let playwright, browser;
  try {
    playwright = require('playwright');
  } catch (err) {
    console.log('[GoDaddy Premium] Playwright not available:', err.message);
    return [];
  }

  console.log('[GoDaddy Premium] Launching headless browser...');
  try {
    const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] };
    // On Railway/Linux, use the system Chromium installed via nixpacks
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }
    browser = await playwright.chromium.launch(launchOpts);
    const page = await browser.newPage();

    // Navigate to the GoDaddy auctions page — this sets the Akamai cookies
    await page.goto('https://auctions.godaddy.com/beta?type=buynow', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Now fetch all type 38 domains from within the page context (has Akamai cookies)
    const allDomains = await page.evaluate(async () => {
      const BASE_URL = 'https://auctions.godaddy.com/beta/findApiProxy/v4/aftermarket/find/auction/recommend';
      const PAGE_SIZE = 200;
      const results = [];
      let offset = 0;

      while (true) {
        const params = new URLSearchParams({
          paginationSize: PAGE_SIZE,
          paginationStart: offset,
          typeIncludeList: '38',
          sortBy: 'auctionValuationPrice:desc',
        });

        let data;
        try {
          const r = await fetch(`${BASE_URL}?${params}`, { headers: { Accept: 'application/json' } });
          data = await r.json();
        } catch (e) {
          break;
        }

        const items = data.results || [];
        if (!items.length) break;

        for (const item of items) {
          results.push({
            fqdn: item.fqdn,
            auction_price: item.auction_price,
            auction_end: item.end_time,
            bid_count: item.bids || 0,
            auction_id: item.auction_id,
          });
        }

        offset += PAGE_SIZE;
        if (items.length < PAGE_SIZE) break;
        // Small delay to avoid hammering the endpoint
        await new Promise(r => setTimeout(r, 300));
      }

      return results;
    });

    console.log(`[GoDaddy Premium] Browser fetched ${allDomains.length} raw listings`);

    const domains = [];
    for (const item of allDomains) {
      const parsed = parseDomain(item.fqdn);
      if (!parsed) continue;
      domains.push({
        ...parsed,
        stream: 'godaddy-premium',
        source: 'GoDaddy Premium',
        auction_price: item.auction_price,
        auction_url: `https://auctions.godaddy.com/trpAuctionItemDetail.aspx?aucid=${item.auction_id}`,
        auction_end: item.auction_end,
        bid_count: item.bid_count || 0,
      });
    }

    return domains;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function scrapeGoDaddyPremium() {
  // Try API first (fast, no browser needed)
  const apiResult = await scrapeViaApi();
  if (apiResult) return apiResult;

  // Fall back to browser scrape
  return scrapeViaBrowser();
}

module.exports = { scrapeGoDaddyPremium };
