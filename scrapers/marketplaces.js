/**
 * Marketplace Scrapers
 *
 * Sedo:    Requires free partner API key. Register at:
 *          https://sedo.com/member/partner/integration.php
 *          Set env vars: SEDO_PARTNER_ID, SEDO_SIGN_KEY
 *
 * Afternic / GoDaddy Aftermarket:
 *          Requires free developer API key. Register at:
 *          https://developer.godaddy.com
 *          Set env vars: GODADDY_API_KEY, GODADDY_API_SECRET
 *          (For aftermarket listing search you may also need to contact
 *           afternic-integration@godaddy.com to enable the endpoint)
 *
 * Dan.com: Attempted as unauthenticated JSON — no key required.
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

// ── Sedo SOAP API ────────────────────────────────────────────────────────────
// Free partner key required: https://sedo.com/member/partner/integration.php
async function scrapeSedo() {
  const partnerId = process.env.SEDO_PARTNER_ID;
  const signKey   = process.env.SEDO_SIGN_KEY;
  if (!partnerId || !signKey) {
    console.log('[Sedo] Skipped — set SEDO_PARTNER_ID + SEDO_SIGN_KEY in .env to enable');
    return [];
  }

  const results = [];
  const exts = ['.com', '.io', '.ai', '.net', '.org'];

  for (const ext of exts) {
    const soap = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://sedo.com/namespaces/">
  <SOAP-ENV:Header>
    <ns1:Security>
      <ns1:UserAuth>
        <ns1:partnerid>${partnerId}</ns1:partnerid>
        <ns1:signkey>${signKey}</ns1:signkey>
      </ns1:UserAuth>
    </ns1:Security>
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <ns1:DomainSearch>
      <ns1:keyword></ns1:keyword>
      <ns1:minimum_price>0</ns1:minimum_price>
      <ns1:maximum_price>5000</ns1:maximum_price>
      <ns1:available_extensions>${ext}</ns1:available_extensions>
      <ns1:language>us</ns1:language>
      <ns1:sortby>priceasc</ns1:sortby>
      <ns1:offset>0</ns1:offset>
      <ns1:loadsize>100</ns1:loadsize>
    </ns1:DomainSearch>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

    try {
      const resp = await axios.post('https://api.sedo.com/api/v1/', soap, {
        headers: {
          'Content-Type': 'text/xml; charset=UTF-8',
          'SOAPAction': 'DomainSearch',
        },
        timeout: 30000,
      });
      const $ = cheerio.load(resp.data, { xmlMode: true });
      $('domain').each((i, el) => {
        const domainText = $(el).find('domainname').text().toLowerCase().trim();
        if (!domainText || !matchesTLD(domainText)) return;
        const parsed = parseDomain(domainText);
        if (!parsed) return;
        const price = parseFloat($(el).find('price').text()) || null;
        const url = $(el).find('domainlink').text().trim()
          || `https://sedo.com/search/details/?domain=${domainText}`;
        results.push({
          ...parsed,
          stream: 'marketplace',
          source: 'Sedo',
          auction_price: price,
          auction_url: url,
        });
      });
      await sleep(1500);
    } catch (err) {
      console.error(`[Sedo/${ext}]:`, err.message);
    }
  }

  console.log(`[Sedo] ${results.length} listings`);
  return results;
}

// ── GoDaddy / Afternic REST API ──────────────────────────────────────────────
// Free developer key: https://developer.godaddy.com
// For aftermarket listing search, contact afternic-integration@godaddy.com to enable
async function scrapeGoDaddyAftermarket() {
  const apiKey    = process.env.GODADDY_API_KEY;
  const apiSecret = process.env.GODADDY_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.log('[GoDaddy/Afternic] Skipped — set GODADDY_API_KEY + GODADDY_API_SECRET in .env to enable');
    return [];
  }

  const results = [];
  const auth = { Authorization: `sso-key ${apiKey}:${apiSecret}`, Accept: 'application/json' };

  // Try both the aftermarket listings endpoint and the expiry listings endpoint
  const endpoints = [
    {
      url: 'https://api.godaddy.com/v1/aftermarket/listings',
      params: { tlds: '.ai,.com,.io,.net,.org', status: 'FOR_SALE', limit: 1000, sort: 'listed', dir: 'desc' },
    },
    {
      url: 'https://api.godaddy.com/v1/aftermarket/listings/expiry',
      params: { tlds: '.ai,.com,.io,.net,.org', limit: 1000, sort: 'listed', dir: 'desc' },
    },
  ];

  for (const ep of endpoints) {
    try {
      const resp = await axios.get(ep.url, { params: ep.params, headers: auth, timeout: 30000 });
      const listings = resp.data.listings || (Array.isArray(resp.data) ? resp.data : []);
      for (const item of listings) {
        const domainText = (item.domain || '').toLowerCase();
        if (!domainText || !matchesTLD(domainText)) continue;
        const parsed = parseDomain(domainText);
        if (!parsed) continue;
        const price = item.price?.sellingPrice ?? item.price?.buyItNow ?? null;
        results.push({
          ...parsed,
          stream: 'marketplace',
          source: 'Afternic',
          auction_price: price,
          auction_url: `https://www.afternic.com/forsale/${domainText}`,
          auction_end: item.expiryDate || null,
        });
      }
    } catch (err) {
      // 401/403 means key doesn't have aftermarket access yet
      if (err.response?.status === 401 || err.response?.status === 403) {
        console.log(`[GoDaddy/Afternic] ${ep.url.split('/').slice(-2).join('/')}: need aftermarket access — contact afternic-integration@godaddy.com`);
      } else {
        console.error(`[GoDaddy/Afternic] ${ep.url}:`, err.message);
      }
    }
  }

  console.log(`[GoDaddy/Afternic] ${results.length} listings`);
  return results;
}

// ── Dan.com (now part of Efty) — unauthenticated JSON ────────────────────────
async function scrapeDan() {
  const results = [];
  // Dan.com was acquired by Efty; try both the old dan.com API and the efty marketplace
  const urls = [
    'https://dan.com/api/v1/domains?extension[]=com&extension[]=io&extension[]=ai&extension[]=net&extension[]=org&per_page=100&sort=created_at&order=desc',
  ];
  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        headers: { ...BASE_HEADERS, Accept: 'application/json' },
        timeout: 20000,
      });
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
      if (results.length) break; // stop on first working URL
    } catch (err) {
      console.error('[Dan.com]:', err.message);
    }
  }
  console.log(`[Dan.com] ${results.length} listings`);
  return results;
}

async function runMarketplaces() {
  console.log('[Marketplaces] Starting...');
  const [sedo, godaddy, dan] = await Promise.all([
    scrapeSedo(), scrapeGoDaddyAftermarket(), scrapeDan(),
  ]);
  const all = [...sedo, ...godaddy, ...dan];
  const seen = new Set();
  return all.filter(d => {
    if (!d || seen.has(d.domain)) return false;
    seen.add(d.domain);
    return true;
  });
}

module.exports = { runMarketplaces };
