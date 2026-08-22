'use strict';

const LANDER_PLATFORMS = [
  ['afternic', 'Afternic'],
  ['sedo.com', 'Sedo'],
  ['sedo.de', 'Sedo'],
  ['dan.com', 'Dan.com'],
  ['efty.com', 'Efty'],
  ['undeveloped.com', 'Undeveloped'],
  ['squadhelp', 'Squadhelp'],
  ['hugedomains', 'HugeDomains'],
  ['brandpa', 'Brandpa'],
  ['cashparking', 'GoDaddy Parking'],
  ['uniregistry', 'Uniregistry'],
  ['bolddomains', 'BoldDomains'],
  ['atom.com', 'Atom'],
  ['brandroot', 'Brandroot'],
  ['saw.com', 'Saw.com'],
  ['namerific', 'Namerific'],
  ['domainsbot', 'DomainsBOT'],
  ['epik.com', 'Epik'],
  ['namecheap.com/market', 'Namecheap Market'],
];

const FOR_SALE_PHRASES = [
  'for sale', 'buy this domain', 'purchase this domain',
  'make an offer', 'domain for sale', 'buy domain', 'acquire this domain',
  'buy now', 'buy this domain name', 'lease to own', 'own this domain',
  'this domain is available', 'domain is for sale', 'inquire about this domain',
];

// Redirects are ordinary web behavior. Require a known marketplace or explicit
// sale language before treating a page as aftermarket inventory.
function classifyLanderEvidence({ finalUrl = '', body = '', originalHost = '' } = {}) {
  const normalizedUrl = String(finalUrl).toLowerCase();
  const bodyLow = String(body).toLowerCase().slice(0, 40000);
  const finalHost = normalizedUrl.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  const origHost = String(originalHost).toLowerCase().replace(/^www\./, '');
  const wasRedirected = Boolean(finalHost && origHost && finalHost.replace(/^www\./, '') !== origHost);

  let platform = null;
  for (const [keyword, name] of LANDER_PLATFORMS) {
    if (normalizedUrl.includes(keyword) || bodyLow.includes(keyword)) {
      platform = name;
      break;
    }
  }

  const hasForSalePhrase = FOR_SALE_PHRASES.some(phrase => bodyLow.includes(phrase));
  if (!platform && wasRedirected && hasForSalePhrase) platform = finalHost.replace(/^www\./, '');

  return {
    platform,
    isForSale: Boolean(platform || hasForSalePhrase),
    wasRedirected,
    hasForSalePhrase,
  };
}

module.exports = { LANDER_PLATFORMS, FOR_SALE_PHRASES, classifyLanderEvidence };
