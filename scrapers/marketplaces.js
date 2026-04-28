/**
 * Marketplace Scrapers
 * Sources: Sedo, Dan.com (Efty), Afternic, Namecheap Market
 * All public listings. No auth required.
 */
const axios = require('axios');
const cheerio = require('cheerio');

const TARGET_TLDS = ['.com', '.io', '.ai', '.sh', '.bot', '.net', '.org'];

function matchesTLD(domain) {
  return TARGET_TLDS.some(tld => domain.toLowerCase().endsWith(tld));
}

function parseDomain(domain) {
  const lower = domain.toLowerCase().trim().replace(/^\*\./, '');
  const dotIdx = lower.lastIndexOf('.');
  const tld = dotIdx >= 0 ? lower.slice(dotIdx) : '';
  const name = dotIdx >= 0 ? lower.slice(0, dotIdx) : lower;
  if (name.includes('.')) return null;
  return {
    domain: lower,
    tld,
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function scrapeSedo() {
  const results = [];
  const exts = ['com', 'io', 'ai', 'net', 'org'];
  for (const ext of exts) {
    try {
      // Sedo search for cheapest recent listings
      const url = `https://sedo.com/search/searchresult.php?language=us&extension=.${ext}&minprice=0&maxprice=5000&orderby=date_added&orderdir=DESC&offset=0&limit=100`;
      const resp = await axios.get(url, {
        headers: { ...BASE_HEADERS, Accept: 'text/html,application/xhtml+xml' },
        timeout: 20000,
      });
      const $ = cheerio.load(resp.data);
      $('table.result-table tbody tr, .search-result-list li').each((i, el) => {
        const domainEl = $(el).find('.domain a, td.domain a, .domainname a');
        const text = domainEl.text().trim().toLowerCase();
        if (!text || !text.includes('.')) return;
        if (!matchesTLD(text)) return;
        const parsed = parseDomain(text);
        if (!parsed) return;
        const price = $(el).find('.price, td.price').text().trim();
        const href = domainEl.attr('href') || '';
        results.push({
          ...parsed,
          stream: 'marketplace',
          source: 'Sedo',
          auction_price: parseFloat(price.replace(/[^0-9.]/g, '') || '0') || null,
          auction_url: href.startsWith('http') ? href : `https://sedo.com${href}`,
        });
      });
      await sleep(2000);
    } catch (err) {
      console.error(`[Sedo/${ext}]:`, err.message);
    }
  }
  return results;
}

async function scrapeDan() {
  const results = [];
  try {
    // Dan.com (now Efty) has a JSON API for domain listings
    const resp = await axios.get(
      'https://dan.com/api/v1/domains?extension[]=com&extension[]=io&extension[]=ai&extension[]=net&extension[]=org&per_page=100&sort=created_at&order=desc',
      { headers: { ...BASE_HEADERS, Accept: 'application/json' }, timeout: 20000 }
    );
    const items = resp.data.data || resp.data.domains || (Array.isArray(resp.data) ? resp.data : []);
    for (const item of items) {
      const domain = (item.domain || item.name || '').toLowerCase();
      if (!domain || !matchesTLD(domain)) continue;
      const parsed = parseDomain(domain);
      if (!parsed) continue;
      results.push({
        ...parsed,
        stream: 'marketplace',
        source: 'Dan.com',
        auction_price: item.buy_now_price || item.minimum_offer || item.price || null,
        auction_url: item.url || `https://dan.com/buy-domain/${domain}`,
      });
    }
  } catch (err) {
    console.error('[Dan.com]:', err.message);
  }
  return results;
}

async function scrapeAfternic() {
  const results = [];
  try {
    // Afternic (GoDaddy-owned) has a public search
    const resp = await axios.get(
      'https://www.afternic.com/forsale/search?tlds=com,net,org,io,ai&maxprice=5000&sort=priceAsc&results=100',
      { headers: { ...BASE_HEADERS, Accept: 'text/html,application/xhtml+xml' }, timeout: 20000 }
    );
    const $ = cheerio.load(resp.data);
    $('.domain-name, .result-domain, table tbody tr td:first-child').each((i, el) => {
      const text = $(el).text().trim().toLowerCase();
      if (!text || !text.includes('.')) return;
      if (!matchesTLD(text)) return;
      const parsed = parseDomain(text);
      if (!parsed) return;
      const priceEl = $(el).closest('tr, .result-row').find('.price, td.price');
      results.push({
        ...parsed,
        stream: 'marketplace',
        source: 'Afternic',
        auction_price: parseFloat(priceEl.text().replace(/[^0-9.]/g, '') || '0') || null,
        auction_url: `https://www.afternic.com/forsale/${text}`,
      });
    });
  } catch (err) {
    console.error('[Afternic]:', err.message);
  }
  return results;
}

async function runMarketplaces() {
  console.log('[Marketplaces] Starting...');
  const [sedo, dan, afternic] = await Promise.all([
    scrapeSedo(), scrapeDan(), scrapeAfternic(),
  ]);
  const all = [...sedo, ...dan, ...afternic];
  const seen = new Set();
  return all.filter(d => {
    if (!d || seen.has(d.domain)) return false;
    seen.add(d.domain);
    return true;
  });
}

module.exports = { runMarketplaces };
