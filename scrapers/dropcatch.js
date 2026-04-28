/**
 * DropCatch — direct API scraper
 * No auth required. Uses the same JSON API their SPA calls.
 * 833K+ domains at any given time.
 *
 * Confirmed TLD availability (tested April 2026):
 *   ✅ .com  ~637K   ✅ .net ~42K   ✅ .org ~40K   ✅ .io ~5K
 *   ❌ .ai   0       ❌ .sh  0      ❌ .bot 0
 *
 * recordType mapping:
 *   PreRelease   → pending-delete  (expiring/caught domains)
 *   PrivateSeller → marketplace    (user-listed for sale)
 */
const axios = require('axios');

const TARGET_TLDS = ['.com', '.net', '.org', '.io'];

function matchesTLD(d) { return TARGET_TLDS.some(t => d.endsWith(t)); }

function parseDomain(domain) {
  if (!domain) return null;
  const lower = domain.toLowerCase().trim();
  const dotIdx = lower.lastIndexOf('.');
  const tld = dotIdx >= 0 ? lower.slice(dotIdx) : '';
  const name = dotIdx >= 0 ? lower.slice(0, dotIdx) : lower;
  if (!matchesTLD(lower) || name.includes('.') || !name) return null;
  return {
    domain: lower,
    tld,
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.dropcatch.com',
  'Referer': 'https://www.dropcatch.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

async function scrapeDropCatch({ tlds = TARGET_TLDS, maxPages = 10, pageSize = 200 } = {}) {
  const results = [];
  const tldFilters = tlds
    .map(t => t.replace('.', ''))
    .filter(t => ['com', 'net', 'org', 'io'].includes(t)); // only confirmed working TLDs

  const tldValues = tldFilters.map(t => ({ Value: t }));

  for (let page = 1; page <= maxPages; page++) {
    try {
      const payload = {
        searchTerm: '',
        filters: tldValues.length > 0
          ? [{ values: tldValues, Name: 'Tld' }]
          : [],
        page,
        size: pageSize,
        sorts: [
          { field: 'sortPriority', direction: 'Ascending' },
          { field: 'highBid', direction: 'Descending' },
        ],
      };

      const resp = await axios.post(
        'https://client.dropcatch.com/Search',
        payload,
        { headers: HEADERS, timeout: 20000 }
      );

      const result = resp.data?.result || {};
      const items = result.items || [];
      const totalRecords = result.totalRecords || 0;

      if (items.length === 0) break;

      for (const item of items) {
        const domain = (item.name || '').toLowerCase();
        const parsed = parseDomain(domain);
        if (!parsed) continue;

        // PreRelease = expiring/pending-delete domain being caught
        // PrivateSeller = someone selling a domain they own
        const stream = item.recordType === 'PrivateSeller' ? 'marketplace' : 'pending-delete';
        results.push({
          ...parsed,
          stream,
          source: 'DropCatch',
          auction_price: item.highBid || null,
          auction_end: item.expirationDate || null,
          auction_url: `https://www.dropcatch.com/domain/${encodeURIComponent(domain)}`,
        });
      }

      console.log(`[DropCatch] Page ${page}/${Math.ceil(totalRecords/pageSize)}: ${items.length} items (total ${results.length})`);

      // Stop if we've fetched all available records
      if (results.length >= totalRecords) break;

      await sleep(800);
    } catch (err) {
      console.error(`[DropCatch] Page ${page}:`, err.message);
      break;
    }
  }

  console.log(`[DropCatch] Done: ${results.length} domains`);
  return results;
}

module.exports = { scrapeDropCatch };
