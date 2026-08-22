'use strict';

const axios = require('axios');

const STATES = Object.freeze({
  FIXED_PRICE: 'fixed_price',
  LISTED_UNPRICED: 'listed_unpriced',
  ABSENT: 'absent',
  TRANSIENT_ERROR: 'transient_error',
});

function result(provider, state, domain, extra = {}) {
  return {
    provider,
    state,
    domain,
    observedAt: new Date().toISOString(),
    ...extra,
  };
}

function parseNextData(html) {
  const match = String(html || '').match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch (_) { return null; }
}

async function quoteAfternic(domain, { client = axios, timeoutMs = 4500 } = {}) {
  const sourceUrl = `https://www.afternic.com/domain/${domain}`;
  try {
    const response = await client.get(sourceUrl, {
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)', Accept: 'text/html' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = String(response.headers?.location || '');
      return result('Afternic', location.includes('/forsale/') ? STATES.LISTED_UNPRICED : STATES.ABSENT, domain, { sourceUrl, location });
    }
    if (response.status !== 200) return result('Afternic', STATES.TRANSIENT_ERROR, domain, { sourceUrl, httpStatus: response.status });
    const profile = parseNextData(response.data)?.props?.pageProps?.profile;
    if (!profile?.isForSale) return result('Afternic', STATES.ABSENT, domain, { sourceUrl });
    const price = Number(profile.buyNow || 0) / 1_000_000;
    if (!(price > 0)) return result('Afternic', STATES.LISTED_UNPRICED, domain, { sourceUrl });
    return result('Afternic', STATES.FIXED_PRICE, domain, {
      currency: 'USD', price, minOffer: Number(profile.minBid || 0) / 1_000_000, sourceUrl,
    });
  } catch (error) {
    return result('Afternic', STATES.TRANSIENT_ERROR, domain, { sourceUrl, error: error.code || error.message });
  }
}

async function quoteSedo(domain, { client = axios, timeoutMs = 3500 } = {}) {
  const endpoint = `https://sedo.com/api/domain-details/information/${domain}`;
  const sourceUrl = `https://sedo.com/search/details/?domain=${domain}`;
  try {
    const response = await client.get(endpoint, {
      timeout: timeoutMs,
      validateStatus: () => true,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: sourceUrl,
        'User-Agent': 'Mozilla/5.0 (compatible; DomainResearch/1.0)',
      },
    });
    if (response.status === 404) return result('Sedo', STATES.ABSENT, domain, { sourceUrl });
    if (response.status !== 200) return result('Sedo', STATES.TRANSIENT_ERROR, domain, { sourceUrl, httpStatus: response.status });
    const data = response.data || {};
    if (data.domainPriceType !== 'buynow') return result('Sedo', STATES.LISTED_UNPRICED, domain, { sourceUrl, priceType: data.domainPriceType || null });
    const price = Number(data.buynow?.priceOptions?.price || 0) / 100;
    if (!(price > 0)) return result('Sedo', STATES.LISTED_UNPRICED, domain, { sourceUrl, priceType: data.domainPriceType });
    return result('Sedo', STATES.FIXED_PRICE, domain, {
      currency: String(data.buynow?.priceOptions?.currency?.name || 'usd').toUpperCase(), price, sourceUrl,
    });
  } catch (error) {
    return result('Sedo', STATES.TRANSIENT_ERROR, domain, { sourceUrl, error: error.code || error.message });
  }
}

async function quoteListing(domain, options = {}) {
  const normalized = String(domain || '').toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) throw new Error('Invalid domain');
  const afternic = await quoteAfternic(normalized, options);
  if (afternic.state === STATES.FIXED_PRICE) return { ...afternic, quotes: [afternic] };
  const sedo = await quoteSedo(normalized, options);
  const quotes = [afternic, sedo];
  const fixed = quotes.find(quote => quote.state === STATES.FIXED_PRICE);
  if (fixed) return { ...fixed, quotes };
  const listed = quotes.find(quote => quote.state === STATES.LISTED_UNPRICED);
  if (listed) return { ...listed, quotes };
  if (quotes.every(quote => quote.state === STATES.ABSENT)) return { ...afternic, state: STATES.ABSENT, quotes };
  return result('marketplaces', STATES.TRANSIENT_ERROR, normalized, { quotes });
}

module.exports = { STATES, parseNextData, quoteAfternic, quoteSedo, quoteListing };
