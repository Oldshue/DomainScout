/**
 * Auction & catching services — confirmed working APIs only
 *
 * ✅ DropCatch  — 811K domains, direct JSON API, no auth
 * ✅ Dynadot    — 539K domains, direct POST API, no auth
 * ✅ Namecheap  — GraphQL API, no auth, 5277 .ai + 9768 .io + more (official .ai auctioner)
 * ✅ GoDaddy    — via official API if prod key is configured
 *
 * ❌ NameJet    — Cloudflare JS challenge blocks headless
 * ❌ Pool.com   — no public API
 */
const { scrapeDropCatch }  = require('./dropcatch');
const { scrapeDynadot }    = require('./dynadot');
const { scrapeNamecheap }  = require('./namecheap');
const axios                = require('axios');

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

// GoDaddy official API — only runs if key is configured
// Endpoint: /v1/aftermarket/listings (not /v1/auctions which returns 404)
// Keys: https://developer.godaddy.com/keys (free, instant)
async function scrapeGoDaddyAPI() {
  if (!process.env.GODADDY_API_KEY || !process.env.GODADDY_API_SECRET) return [];

  const results = [];
  // GoDaddy aftermarket covers ALL TLDs including .ai and .bot
  const tlds = ['ai', 'io', 'com', 'net', 'org', 'sh', 'bot'];
  const authHeader = `sso-key ${process.env.GODADDY_API_KEY}:${process.env.GODADDY_API_SECRET}`;
  const PAGE_SIZE = 200;

  for (const tld of tlds) {
    let startIndex = 0;
    let fetched = 0;
    let totalAvailable = Infinity;

    while (startIndex < totalAvailable) {
      try {
        const resp = await axios.get(
          `https://api.godaddy.com/v1/aftermarket/listings`,
          {
            params: {
              tlds: tld,
              perPage: PAGE_SIZE,
              startIndex,
            },
            headers: {
              Authorization: authHeader,
              Accept: 'application/json',
            },
            timeout: 20000,
          }
        );

        const items = resp.data?.listings || resp.data || [];
        if (!Array.isArray(items) || items.length === 0) break;

        // Total count may be in headers or response wrapper
        if (totalAvailable === Infinity) {
          totalAvailable = resp.data?.total || resp.headers['x-total-count']
            ? parseInt(resp.data?.total || resp.headers['x-total-count'], 10)
            : items.length; // fallback: only this page
        }

        for (const item of items) {
          const domain = (item.domain || item.domainName || '').toLowerCase();
          const parsed = parseDomain(domain);
          if (!parsed) continue;
          results.push({
            ...parsed,
            stream: 'godaddy-auction',
            source: 'GoDaddy API',
            auction_price: item.currentBid || item.reservePrice || null,
            auction_end: item.expireAt || item.expiresAt || null,
            auction_url: `https://auctions.godaddy.com/trpItemListing.aspx?Type=1&domain=${encodeURIComponent(domain)}`,
          });
        }

        fetched += items.length;
        startIndex += PAGE_SIZE;

        console.log(`[GoDaddy API/.${tld}] page offset ${startIndex - PAGE_SIZE}: ${items.length} items`);

        if (items.length < PAGE_SIZE) break; // last page
        await sleep(500);

      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.message || err.message;
        console.error(`[GoDaddy API/.${tld}] offset ${startIndex}:`, status, msg);
        break;
      }
    }

    await sleep(300);
  }

  console.log(`[GoDaddy API] ${results.length} domains across ${tlds.length} TLDs`);
  return results;
}

async function runAuctions() {
  console.log('[Auctions] Running DropCatch + Dynadot + GoDaddy...');

  // Run in parallel
  const [dropcatch, dynadot, namecheap, godaddy] = await Promise.all([
    scrapeDropCatch({ maxPages: 5, pageSize: 100 }),
    scrapeDynadot(),
    scrapeNamecheap(),
    scrapeGoDaddyAPI(),
  ]);

  const all = [...dropcatch, ...dynadot, ...namecheap, ...godaddy];
  const seen = new Set();
  return all.filter(d => {
    if (!d || seen.has(d.domain)) return false;
    seen.add(d.domain);
    return true;
  });
}

module.exports = { runAuctions };
