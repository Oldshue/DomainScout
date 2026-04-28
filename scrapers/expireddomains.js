/**
 * ExpiredDomains.net scraper — pending delete lists for ccTLDs
 *
 * Pulls pending-delete domains for .ai/.io/.sh/.bot from expireddomains.net.
 * Requires EXPIREDDOMAINS_USER and EXPIREDDOMAINS_PASS in .env
 *
 * TLD IDs (ftlds[] query param):
 *   .ai  → 26, 1531, 1532, 1533
 *   .io  → 125
 *   .sh  → 215, 2533, 2534, 2536
 *   .bot → 867
 */
const axios   = require('axios');
const cheerio = require('cheerio');

const BASE     = 'https://www.expireddomains.net';
const DELAY_MS = 1500; // ~0.67 req/sec — stay within free tier limits

// TLD → ftlds[] IDs
const TLD_IDS = {
  '.ai':  [26, 1531, 1532, 1533],
  '.io':  [125],
  '.sh':  [215, 2533, 2534, 2536],
  '.bot': [867],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Log in and return a cookie string to attach to subsequent requests.
 */
async function login(username, password) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const cookies = {};

  function parseCookies(setCookieArr) {
    for (const h of setCookieArr || []) {
      const [pair] = h.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
  }

  function cookieHeader() {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // Step 1 — GET login page to collect any pre-session cookies
  const getResp = await axios.get(`${BASE}/login/`, {
    headers,
    timeout: 15000,
    validateStatus: () => true,
  });
  parseCookies(getResp.headers['set-cookie']);

  // Step 2 — POST credentials
  const postResp = await axios.post(
    `${BASE}/login/`,
    new URLSearchParams({ login: username, pass: password, redirect: '' }).toString(),
    {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader(),
        Referer: `${BASE}/login/`,
      },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
    }
  );
  parseCookies(postResp.headers['set-cookie']);

  // Verify we're not stuck on the login page
  const finalUrl = postResp.request?.res?.responseUrl || postResp.config?.url || '';
  if (finalUrl.includes('/login') || postResp.data?.includes('id="error"')) {
    throw new Error('Login failed — check credentials or activate account at expireddomains.net');
  }

  return cookieHeader();
}

/**
 * Scrape one page of pending delete results for a set of TLD IDs.
 * Returns { domains: [...], hasMore: bool }
 */
async function scrapePage(cookieStr, tldIds, start = 0) {
  const qs  = tldIds.map(id => `ftlds[]=${id}`).join('&');
  const url = `${BASE}/expired-domains/?${qs}&fwhois=pendingdelete&start=${start}`;

  const resp = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Cookie: cookieStr,
      Referer: `${BASE}/expired-domains/`,
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (resp.status !== 200) throw new Error(`HTTP ${resp.status} for ${url}`);

  const $ = cheerio.load(resp.data);
  const domains = [];

  // Table rows: <tr id="listing_domain.tld">
  $('table.base1 tbody tr[id^="listing_"]').each((_, row) => {
    const $row = $(row);

    // Domain name — in td.field_domain, the link text is the domain
    const domainRaw = $row.find('td.field_domain a').first().text().trim().toLowerCase();
    if (!domainRaw || !domainRaw.includes('.')) return;

    const dotIdx = domainRaw.lastIndexOf('.');
    const name   = domainRaw.slice(0, dotIdx);
    const tld    = domainRaw.slice(dotIdx);
    if (!name || name.includes('.')) return;

    // Drop date — td.field_date_epp (registry expiry date)
    let dropRaw = $row.find('td.field_date_epp').first().text().trim();
    // Sometimes wrapped in a span with a title
    if (!dropRaw || dropRaw === '-') {
      dropRaw = $row.find('td.field_date_epp span').first().attr('title') || '';
    }
    const dropDate    = dropRaw && dropRaw !== '-' ? dropRaw.trim() : null;
    const expiryDate  = dropDate ? tryParseDate(dropDate) : null;

    domains.push({ domain: domainRaw, tld, name, drop_date: dropDate, expiry_date: expiryDate });
  });

  // Pagination: expireddomains.net shows 25 rows/page; hasMore if we got a full page
  const hasMore = domains.length >= 25;

  return { domains, hasMore };
}

function tryParseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Scrape all pages for one TLD, up to maxPages pages.
 */
async function scrapeAllPages(cookieStr, tld, maxPages = 40) {
  const ids = TLD_IDS[tld];
  if (!ids) return [];

  const all = [];
  let start = 0;

  for (let page = 0; page < maxPages; page++) {
    try {
      const { domains, hasMore } = await scrapePage(cookieStr, ids, start);
      all.push(...domains);
      if (domains.length > 0) {
        console.log(`[ExpiredDomains] ${tld} page ${page + 1}: ${domains.length} (total ${all.length})`);
      }
      if (!hasMore || domains.length === 0) break;
      start += 25;
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`[ExpiredDomains] Error scraping ${tld} page ${page + 1}:`, err.message);
      break;
    }
  }

  return all;
}

/**
 * Main entry point.
 * Returns array of domain objects ready to insert into the pending-delete stream.
 */
async function runExpiredDomains() {
  const username = process.env.EXPIREDDOMAINS_USER;
  const password = process.env.EXPIREDDOMAINS_PASS;

  if (!username || !password) {
    console.log('[ExpiredDomains] Skipping — EXPIREDDOMAINS_USER/PASS not configured');
    return [];
  }

  let cookieStr;
  try {
    console.log('[ExpiredDomains] Logging in...');
    cookieStr = await login(username, password);
    console.log('[ExpiredDomains] Login OK');
  } catch (err) {
    console.error('[ExpiredDomains]', err.message);
    return [];
  }

  const results = [];

  for (const tld of Object.keys(TLD_IDS)) {
    await sleep(DELAY_MS);
    const raw = await scrapeAllPages(cookieStr, tld);

    for (const d of raw) {
      results.push({
        domain:       d.domain,
        tld:          d.tld,
        stream:       'pending-delete',
        source:       'expireddomains.net',
        length:       d.name.length,
        has_numbers:  /\d/.test(d.name)  ? 1 : 0,
        has_hyphens:  /-/.test(d.name)   ? 1 : 0,
        drop_date:    d.drop_date,
        expiry_date:  d.expiry_date,
      });
    }
  }

  console.log(`[ExpiredDomains] Done — ${results.length} pending-delete domains`);
  return results;
}

module.exports = { runExpiredDomains };
