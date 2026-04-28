/**
 * Browser-based scrapers using Playwright
 * Bypasses Cloudflare and JS rendering requirements.
 * Used for: NameJet, Dynadot, Pool, DropCatch, GoDaddy auction pages, Sedo
 *
 * Runs headless Chromium — acts like a real browser, passes bot detection.
 */
const { chromium } = require('playwright');

const TARGET_TLDS = ['.com', '.io', '.ai', '.sh', '.bot', '.net', '.org'];

function matchesTLD(domain) {
  return TARGET_TLDS.some(tld => domain.toLowerCase().endsWith(tld));
}

function parseDomain(domain) {
  if (!domain) return null;
  const lower = domain.toLowerCase().trim().replace(/^\*\./, '');
  const dotIdx = lower.lastIndexOf('.');
  const tld = dotIdx >= 0 ? lower.slice(dotIdx) : '';
  const name = dotIdx >= 0 ? lower.slice(0, dotIdx) : lower;
  if (!tld || name.includes('.') || !matchesTLD(lower)) return null;
  return {
    domain: lower,
    tld,
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
  };
}

async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  // Remove webdriver fingerprint
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  try {
    const result = await fn(page);
    return result;
  } finally {
    await browser.close();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Extract all domain-like text from a page
function extractDomainsFromText(text) {
  const regex = /\b([a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?\.(com|net|org|io|ai|sh|bot))\b/gi;
  const matches = [...text.matchAll(regex)];
  return [...new Set(matches.map(m => m[0].toLowerCase()))];
}

// ── NameJet ──────────────────────────────────────────────────────────────────
async function scrapeNameJet() {
  console.log('[NameJet] Launching browser...');
  try {
    return await withBrowser(async (page) => {
      const results = [];
      const urls = [
        'https://www.namejet.com/Pages/Auctions/BackorderAuctions.aspx',
        'https://www.namejet.com/Pages/Auctions/PreReleaseAuctions.aspx',
      ];

      for (const url of urls) {
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
          await sleep(2000);

          // Try to find domain table rows
          const rows = await page.$$('table tr, .auction-row, .domain-row');
          for (const row of rows) {
            const text = await row.innerText().catch(() => '');
            const domains = extractDomainsFromText(text);
            for (const domain of domains) {
              const parsed = parseDomain(domain);
              if (!parsed) continue;
              // Try to get price
              const priceEl = await row.$('.price, td:nth-child(2), td:nth-child(3)');
              const priceText = priceEl ? await priceEl.innerText().catch(() => '') : '';
              results.push({
                ...parsed,
                stream: 'godaddy-auction',
                source: 'NameJet',
                auction_price: parseFloat(priceText.replace(/[^0-9.]/g, '') || '0') || null,
                auction_url: `https://www.namejet.com`,
              });
            }
          }
        } catch (err) {
          console.error(`[NameJet] ${url}:`, err.message);
        }
        await sleep(3000);
      }

      console.log(`[NameJet] Found ${results.length} domains`);
      return results;
    });
  } catch (err) {
    console.error('[NameJet] Browser error:', err.message);
    return [];
  }
}

// ── Dynadot ──────────────────────────────────────────────────────────────────
async function scrapeDynadot() {
  console.log('[Dynadot] Launching browser...');
  try {
    return await withBrowser(async (page) => {
      const results = [];
      const tlds = ['com', 'io', 'ai', 'net', 'org'];

      for (const tld of tlds) {
        try {
          await page.goto(
            `https://www.dynadot.com/market/closeout?tld=${tld}&sort=endtime&dir=asc`,
            { waitUntil: 'networkidle', timeout: 30000 }
          );
          await sleep(2000);

          // Dynadot market table
          const rows = await page.$$('table tbody tr, .market-item, .domain-item');
          for (const row of rows) {
            const domainEl = await row.$('a.domain, .domain-name a, td:first-child a, td:first-child');
            const domainText = domainEl ? (await domainEl.innerText().catch(() => '')) : '';
            const parsed = parseDomain(domainText.trim().toLowerCase());
            if (!parsed) continue;

            const priceEl = await row.$('.price, td:nth-child(2)');
            const priceText = priceEl ? await priceEl.innerText().catch(() => '') : '';
            const linkEl = await row.$('a[href]');
            const href = linkEl ? await linkEl.getAttribute('href').catch(() => '') : '';

            results.push({
              ...parsed,
              stream: 'marketplace',
              source: 'Dynadot Closeout',
              auction_price: parseFloat(priceText.replace(/[^0-9.]/g, '') || '0') || null,
              auction_url: href ? (href.startsWith('http') ? href : `https://www.dynadot.com${href}`) : `https://www.dynadot.com/market/closeout`,
            });
          }

          await sleep(2000);
        } catch (err) {
          console.error(`[Dynadot/${tld}]:`, err.message);
        }
      }

      console.log(`[Dynadot] Found ${results.length} domains`);
      return results;
    });
  } catch (err) {
    console.error('[Dynadot] Browser error:', err.message);
    return [];
  }
}

// ── DropCatch ────────────────────────────────────────────────────────────────
async function scrapeDropCatch() {
  console.log('[DropCatch] Launching browser...');
  try {
    return await withBrowser(async (page) => {
      const results = [];

      // Intercept XHR to catch JSON API responses
      const apiData = [];
      page.on('response', async (response) => {
        if (response.url().includes('/api') || response.url().includes('auctions')) {
          try {
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('json')) {
              const json = await response.json().catch(() => null);
              if (json) apiData.push(json);
            }
          } catch (_) {}
        }
      });

      await page.goto('https://www.dropcatch.com/auctions', { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(3000);

      // Process any API data caught
      for (const data of apiData) {
        const items = data.domains || data.data || data.results || (Array.isArray(data) ? data : []);
        for (const item of items) {
          const domain = (item.domain || item.name || '').toLowerCase();
          if (!domain) continue;
          const parsed = parseDomain(domain);
          if (!parsed) continue;
          results.push({
            ...parsed,
            stream: 'pending-delete',
            source: 'DropCatch',
            auction_price: item.currentBid || item.bid || item.price || null,
            auction_end: item.endTime || null,
            auction_url: `https://www.dropcatch.com/domain/${encodeURIComponent(domain)}`,
          });
        }
      }

      // Also scrape the visible page
      if (results.length === 0) {
        const rows = await page.$$('table tbody tr, .auction-item, .domain-row');
        for (const row of rows) {
          const text = await row.innerText().catch(() => '');
          const domains = extractDomainsFromText(text);
          for (const domain of domains) {
            const parsed = parseDomain(domain);
            if (!parsed) continue;
            results.push({
              ...parsed,
              stream: 'pending-delete',
              source: 'DropCatch',
              auction_url: `https://www.dropcatch.com/domain/${encodeURIComponent(domain)}`,
            });
          }
        }
      }

      console.log(`[DropCatch] Found ${results.length} domains`);
      return results;
    });
  } catch (err) {
    console.error('[DropCatch] Browser error:', err.message);
    return [];
  }
}

// ── GoDaddy Auctions ─────────────────────────────────────────────────────────
async function scrapeGoDaddy() {
  // If API key is set, use the official API (faster, more reliable)
  if (process.env.GODADDY_API_KEY && process.env.GODADDY_API_SECRET) {
    return scrapeGoDaddyAPI();
  }

  console.log('[GoDaddy] Launching browser (tip: add GODADDY_API_KEY to .env for faster access)...');
  try {
    return await withBrowser(async (page) => {
      const results = [];
      const apiData = [];

      // Intercept the JSON auction API calls the page makes
      page.on('response', async (response) => {
        if (response.url().includes('auctions') || response.url().includes('trfcd')) {
          try {
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('json')) {
              const json = await response.json().catch(() => null);
              if (json) apiData.push(json);
            }
          } catch (_) {}
        }
      });

      await page.goto(
        'https://www.godaddy.com/domain-auctions/expired-domains',
        { waitUntil: 'networkidle', timeout: 40000 }
      );
      await sleep(4000);

      for (const data of apiData) {
        const items = data.domainResults || data.auctions || data.results || (Array.isArray(data) ? data : []);
        for (const item of items) {
          const domain = (item.domain || item.domainName || '').toLowerCase();
          if (!domain || !matchesTLD(domain)) continue;
          const parsed = parseDomain(domain);
          if (!parsed) continue;
          results.push({
            ...parsed,
            stream: 'godaddy-auction',
            source: 'GoDaddy',
            auction_price: item.currentBid || item.price || null,
            auction_end: item.auctionEndTime || null,
            auction_url: `https://www.godaddy.com/domain-auctions/domain/${encodeURIComponent(domain)}`,
          });
        }
      }

      // Fallback: scrape visible text
      if (results.length === 0) {
        const content = await page.content();
        const domains = extractDomainsFromText(content);
        for (const domain of domains) {
          const parsed = parseDomain(domain);
          if (!parsed) continue;
          results.push({
            ...parsed,
            stream: 'godaddy-auction',
            source: 'GoDaddy',
            auction_url: `https://www.godaddy.com/domain-auctions/domain/${encodeURIComponent(domain)}`,
          });
        }
      }

      console.log(`[GoDaddy] Found ${results.length} domains`);
      return results;
    });
  } catch (err) {
    console.error('[GoDaddy] Browser error:', err.message);
    return [];
  }
}

// GoDaddy official API (if key is set)
async function scrapeGoDaddyAPI() {
  const axios = require('axios');
  const results = [];
  const tlds = ['com', 'io', 'ai', 'net', 'org', 'sh'];

  for (const tld of tlds) {
    try {
      const resp = await axios.get(
        `https://api.godaddy.com/v1/auctions?tlds=${tld}&limit=200`,
        {
          headers: {
            Authorization: `sso-key ${process.env.GODADDY_API_KEY}:${process.env.GODADDY_API_SECRET}`,
            Accept: 'application/json',
          },
          timeout: 15000,
        }
      );
      const items = resp.data || [];
      for (const item of items) {
        const domain = (item.domain || '').toLowerCase();
        if (!domain) continue;
        const parsed = parseDomain(domain);
        if (!parsed) continue;
        results.push({
          ...parsed,
          stream: 'godaddy-auction',
          source: 'GoDaddy API',
          auction_price: item.currentBid || null,
          auction_end: item.expiresAt || null,
          auction_url: `https://www.godaddy.com/domain-auctions/domain/${encodeURIComponent(domain)}`,
        });
      }
      await sleep(500);
    } catch (err) {
      console.error(`[GoDaddy API/${tld}]:`, err.message);
    }
  }

  return results;
}

module.exports = { scrapeNameJet, scrapeDynadot, scrapeDropCatch, scrapeGoDaddy };
