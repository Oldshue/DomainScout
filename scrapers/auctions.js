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
const { scrapeGoDaddy }    = require('./godaddy');

async function runAuctions() {
  console.log('[Auctions] Running DropCatch + Dynadot + Namecheap + GoDaddy...');

  // Run in parallel
  const [dropcatch, dynadot, namecheap, godaddy] = await Promise.allSettled([
    scrapeDropCatch({ maxPages: 5, pageSize: 100 }),
    scrapeDynadot(),
    scrapeNamecheap(),
    scrapeGoDaddy(),
  ]).then(r => r.map(p => p.status === 'fulfilled' ? p.value : []));

  const all = [...dropcatch, ...dynadot, ...namecheap, ...godaddy];
  const seen = new Set();
  return all.filter(d => {
    if (!d || seen.has(d.domain)) return false;
    seen.add(d.domain);
    return true;
  });
}

module.exports = { runAuctions };
