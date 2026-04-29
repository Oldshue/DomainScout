/**
 * GoDaddy / Afternic marketplace — fixed-price seller listings
 *
 * These are domains listed "For Sale" by their owners at fixed Buy-It-Now prices
 * via Afternic (GoDaddy's premium marketplace). Millions of listings, indefinitely
 * priced — completely separate from expiring/closeout/auction inventory.
 *
 * Requires Afternic partner API access:
 *   Email: afternic-integration@godaddy.com
 *   Endpoint: GET /v1/aftermarket/listings
 *
 * Until access is granted this scraper returns [] silently.
 * Once granted, set GODADDY_API_KEY + GODADDY_API_SECRET and it activates automatically.
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

async function scrapeGoDaddyPremium() {
  const apiKey    = process.env.GODADDY_API_KEY;
  const apiSecret = process.env.GODADDY_API_SECRET;
  if (!apiKey || !apiSecret) return [];

  const auth = { Authorization: `sso-key ${apiKey}:${apiSecret}`, Accept: 'application/json' };
  const results = [];

  // Page through all Afternic fixed-price listings across target TLDs
  const tlds = '.com,.net,.org,.io,.ai,.app,.dev,.co,.sh,.bot,.xyz,.info,.biz,.us,.me,.tv,.cc,.gg,.vc,.tech,.online,.store,.shop,.club,.pro,.media,.agency,.digital,.solutions';

  let offset = 0;
  const limit = 1000;

  while (true) {
    let resp;
    try {
      resp = await axios.get('https://api.godaddy.com/v1/aftermarket/listings', {
        params: { tlds, status: 'FOR_SALE', limit, offset, sort: 'listed', dir: 'desc' },
        headers: auth,
        timeout: 30000,
      });
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        // Partner access not yet granted — skip silently
        console.log('[GoDaddy Premium] Afternic API not yet enabled (401/403) — waiting on partner access');
        return [];
      }
      console.error('[GoDaddy Premium] API error:', err.message);
      break;
    }

    const listings = resp.data.listings || (Array.isArray(resp.data) ? resp.data : []);
    if (!listings.length) break;

    for (const item of listings) {
      const parsed = parseDomain(item.domain);
      if (!parsed) continue;
      const price = item.price?.sellingPrice ?? item.price?.buyItNow ?? item.buyItNow ?? null;
      results.push({
        ...parsed,
        stream: 'godaddy-premium',
        source: 'GoDaddy Premium',
        auction_price: price ? Math.round(price) : null,
        auction_url: `https://www.afternic.com/forsale/${item.domain}`,
        auction_end: null, // fixed-price, no expiry
        bid_count: 0,
      });
    }

    if (listings.length < limit) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[GoDaddy Premium] ${results.length} Afternic marketplace listings`);
  return results;
}

module.exports = { scrapeGoDaddyPremium };
