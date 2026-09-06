'use strict';

const cheerio = require('cheerio');

// A redirect, an advert or a marketplace logo is not an offer for this asset.
// Require a domain-sale statement tied to the requested domain's page identity.
function classifyLander({ domain, html, status = 200, finalUrl }) {
  if (status < 200 || status >= 300) return { forSale: false, reason: 'unsuccessful_response' };
  const target = String(domain || '').toLowerCase().replace(/^www\./, '');
  const $ = cheerio.load(String(html || ''));
  $('script,style,noscript,nav,footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').toLowerCase();
  const identity = [$('title').text(), $('h1').text(), $('meta[property="og:title"]').attr('content') || ''].join(' ').toLowerCase();
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetPattern = new RegExp(`(^|[^a-z0-9.-])${escaped}(?=$|[^a-z0-9.-])`);
  if (/has been recently registered|recently registered with|domain (?:was|has been) registered/.test(text)) {
    return { forSale: false, reason: 'registration_parking' };
  }
  const sale = /(?:this |the )?domain(?: name)? (?:is |may be |currently |available )*(?:for sale|available for purchase)|(?:buy|purchase|acquire|own|inquire about) this domain(?: name)?/;
  const direct = new RegExp(`(?:^|[^a-z0-9.-])${escaped}\\s+(?:domain\\s+)?(?:is\\s+)?(?:available\\s+)?for sale`);
  let exactMarketplacePath = false;
  try {
    const url = new URL(finalUrl);
    exactMarketplacePath = /(^|\.)(afternic\.com|sedo\.com|sedo\.de|dan\.com|hugedomains\.com|atom\.com)$/.test(url.hostname)
      && (decodeURIComponent(url.pathname).toLowerCase().includes(target) || [...url.searchParams.values()].some(value => value.toLowerCase() === target));
  } catch (_) { /* An invalid URL is not evidence. */ }
  const forSale = direct.test(text) || (targetPattern.test(identity) && sale.test(text)) || (exactMarketplacePath && sale.test(text));
  return { forSale, reason: forSale ? 'subject_domain_sale_statement' : 'no_subject_domain_offer' };
}

module.exports = { classifyLander };
