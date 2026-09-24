'use strict';

/**
 * Nameserver-class primitives: the operator-type classification used by both
 * server/zone-ns-movement.js (zone-wide delegation diffing) and
 * server/sale-watch-evidence.js (per-entry sale-evidence classification).
 *
 * Deliberately dependency-free (no local requires) so requiring it from
 * either caller can never create a require cycle. Provider-neutral: this
 * file knows registrar-default and hosting/CDN nameserver operators, never
 * anything about sale evidence, marketplaces, or a specific vertical.
 *
 * Single source of truth: server/zone-ns-universe.js and server/sale-watch-dns.js
 * both derive their seller/parking/expiry nameserver lists from
 * SELLER_NAMESERVERS / PARKING_NAMESERVERS / EXPIRY_NAMESERVERS below
 * instead of maintaining their own copies.
 */

const CLASS_SELLER = 'seller';
const CLASS_PARKING = 'parking';
const CLASS_REGISTRAR = 'registrar';
const CLASS_HOSTING = 'hosting';
const CLASS_OTHER = 'other';
const CLASS_NONE = 'none';

// Registrar-default DNS: assigned to every name a registrar sells until the
// owner points it somewhere. Being here says "not yet pointed", nothing more.
const REGISTRAR_DEFAULT_NAMESERVERS = Object.freeze([
  { provider: 'GoDaddy default', nameserver: 'domaincontrol.com' },
  { provider: 'Namecheap default', nameserver: 'registrar-servers.com' },
  { provider: 'Hostinger default', nameserver: 'dns-parking.com' },
  { provider: 'eNom / Tucows default', nameserver: 'name-services.com' },
  { provider: 'IONOS default', nameserver: 'ui-dns.com' },
  { provider: 'IONOS default', nameserver: 'ui-dns.org' },
  { provider: 'IONOS default', nameserver: 'ui-dns.biz' },
  { provider: 'IONOS default', nameserver: 'ui-dns.de' },
  { provider: 'Dynadot default', nameserver: 'dynadot.com' },
  { provider: 'NameSilo default', nameserver: 'dnsowl.com' },
  { provider: 'NameSilo default', nameserver: 'namesilo.com' },
  { provider: 'Porkbun default', nameserver: 'porkbun.com' },
  { provider: 'Spaceship default', nameserver: 'spaceship.net' },
  { provider: 'Name.com default', nameserver: 'name.com' },
  { provider: 'Network Solutions default', nameserver: 'worldnic.com' },
  { provider: 'Register.com default', nameserver: 'register.com' },
  { provider: 'Gandi default', nameserver: 'gandi.net' },
  { provider: 'OVH default', nameserver: 'ovh.net' },
  { provider: 'Hover default', nameserver: 'hover.com' },
  { provider: 'Google Domains legacy', nameserver: 'googledomains.com' },
  { provider: 'Squarespace Domains default', nameserver: 'squarespacedns.com' },
  { provider: 'Wix Domains default', nameserver: 'wixdomains.com' },
  { provider: 'GoDaddy hold', nameserver: 'godaddy.com' },
  { provider: 'Alibaba / HiChina default', nameserver: 'hichina.com' },
  { provider: 'Alibaba Cloud default', nameserver: 'alidns.com' },
  { provider: 'DNSPod default', nameserver: 'dnspod.net' },
  { provider: 'Xinnet default', nameserver: 'xincache.com' },
  { provider: 'West.cn default', nameserver: 'myhostadmin.net' },
  { provider: 'Sav default', nameserver: 'sav.com' },
  { provider: 'Domain.com default', nameserver: 'domain.com' },
  { provider: 'Bluehost default', nameserver: 'bluehost.com' },
  { provider: 'HostGator default', nameserver: 'hostgator.com' },
  { provider: 'Namecheap hosting', nameserver: 'namecheaphosting.com' },
  { provider: 'SiteGround', nameserver: 'siteground.net' },
  { provider: 'DreamHost', nameserver: 'dreamhost.com' },
  { provider: '1&1 / IONOS hosting', nameserver: '1and1.com' },
  { provider: 'Cloudflare Registrar', nameserver: 'cloudflare-registrar.com' },
  { provider: 'TransIP default', nameserver: 'transip.net' },
  { provider: 'TransIP default', nameserver: 'transip.nl' },
  { provider: 'TransIP default', nameserver: 'transip.eu' },
  { provider: 'Unstoppable Domains', nameserver: 'unstoppabledomains.com' },
  { provider: 'GiantPanda default', nameserver: 'giantpanda.com' },
  { provider: 'Global Domain Group default', nameserver: 'globaldomaingroup.com' },
  { provider: 'DomainCA default', nameserver: 'domainca.com' },
]);

const HOSTING_NAMESERVERS = Object.freeze([
  { provider: 'Cloudflare', nameserver: 'ns.cloudflare.com' },
  { provider: 'Wix', nameserver: 'wixdns.net' },
  { provider: 'Squarespace', nameserver: 'squarespace.com' },
  { provider: 'Shopify', nameserver: 'shopify.com' },
  { provider: 'Vercel', nameserver: 'vercel-dns.com' },
  { provider: 'Netlify', nameserver: 'netlify.com' },
  { provider: 'NS1', nameserver: 'nsone.net' },
  { provider: 'AWS Route 53', nameserver: 'awsdns-00.com' },
  { provider: 'AWS Route 53', nameserver: 'awsdns' },
  { provider: 'Azure DNS', nameserver: 'azure-dns.com' },
  { provider: 'Azure DNS', nameserver: 'azure-dns.net' },
  { provider: 'Azure DNS', nameserver: 'azure-dns.org' },
  { provider: 'Azure DNS', nameserver: 'azure-dns.info' },
  { provider: 'Google Cloud DNS', nameserver: 'googledomains.com.' },
  { provider: 'Google Cloud DNS', nameserver: 'google.com' },
  { provider: 'DigitalOcean', nameserver: 'digitalocean.com' },
  { provider: 'Linode / Akamai', nameserver: 'linode.com' },
  { provider: 'Hetzner', nameserver: 'hetzner.com' },
  { provider: 'Hetzner', nameserver: 'hetzner.de' },
  { provider: 'DNSimple', nameserver: 'dnsimple.com' },
  { provider: 'DNS Made Easy', nameserver: 'dnsmadeeasy.com' },
  { provider: 'Hurricane Electric', nameserver: 'he.net' },
  { provider: 'ClouDNS', nameserver: 'cloudns.net' },
  { provider: 'Bunny', nameserver: 'bunny.net' },
  { provider: 'Webflow', nameserver: 'webflow.com' },
  { provider: 'GoDaddy Website Builder', nameserver: 'secureserver.net' },
  { provider: 'WordPress.com', nameserver: 'wordpress.com' },
  { provider: 'WP Engine', nameserver: 'wpengine.com' },
  { provider: 'Kinsta', nameserver: 'kinsta.com' },
  { provider: 'Fastly', nameserver: 'fastly.net' },
  { provider: 'Akamai', nameserver: 'akam.net' },
  { provider: 'Weebly', nameserver: 'weebly.com' },
  { provider: 'Duda', nameserver: 'dudamobile.com' },
  { provider: 'Strikingly', nameserver: 'strikingly.com' },
  { provider: 'Carrd', nameserver: 'carrd.co' },
  { provider: 'Framer', nameserver: 'framer.com' },
  { provider: 'HubSpot', nameserver: 'hubspot.net' },
  { provider: 'Zoho', nameserver: 'zoho.com' },
  { provider: 'Yandex', nameserver: 'yandex.net' },
  { provider: 'Tencent DNSPod Pro', nameserver: 'dnsv1.com' },
  { provider: 'Rackspace', nameserver: 'rackspace.com' },
  { provider: 'DNS.com', nameserver: 'dns.com' },
]);

const SELLER_NAMESERVERS = Object.freeze([
  { provider: 'Afternic', nameserver: 'ns1.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns2.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns3.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns4.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns5.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns6.afternic.com' },
  { provider: 'Dan', nameserver: 'ns1.dan.com' },
  { provider: 'Dan', nameserver: 'ns2.dan.com' },
  { provider: 'Sedo', nameserver: 'ns1.sedoparking.com' },
  { provider: 'Sedo', nameserver: 'ns2.sedoparking.com' },
  { provider: 'Sedo', nameserver: 'sl1.sedo.com' },
  { provider: 'Sedo', nameserver: 'sl2.sedo.com' },
  { provider: 'Atom', nameserver: 'ns1.atom.com' },
  { provider: 'Atom', nameserver: 'ns2.atom.com' },
  { provider: 'Atom / Squadhelp', nameserver: 'ns1.squadhelp.com' },
  { provider: 'Atom / Squadhelp', nameserver: 'ns2.squadhelp.com' },
  { provider: 'BrandBucket', nameserver: 'ns1.brandbucket.com' },
  { provider: 'BrandBucket', nameserver: 'ns2.brandbucket.com' },
  { provider: 'Nameshift', nameserver: 'ns1.nameshift.com' },
  { provider: 'Nameshift', nameserver: 'ns2.nameshift.com' },
  { provider: 'Bodis', nameserver: 'ns1.bodis.com' },
  { provider: 'Bodis', nameserver: 'ns2.bodis.com' },
  { provider: 'ParkingCrew', nameserver: 'ns1.parkingcrew.net' },
  { provider: 'ParkingCrew', nameserver: 'ns2.parkingcrew.net' },
  { provider: 'Efty', nameserver: 'ns1.eftydns.com' },
  { provider: 'Efty', nameserver: 'ns2.eftydns.com' },
  { provider: 'HugeDomains / NameBright', nameserver: 'nsg1.namebrightdns.com' },
  { provider: 'HugeDomains / NameBright', nameserver: 'nsg2.namebrightdns.com' },
  { provider: 'HugeDomains / NameBright internal', nameserver: 'ns1.namebrightdns.com' },
  { provider: 'HugeDomains / NameBright internal', nameserver: 'ns2.namebrightdns.com' },
  { provider: 'BuyDomains', nameserver: 'ns.buydomains.com' },
  { provider: 'BuyDomains', nameserver: 'this-domain-for-sale.com' },
  { provider: 'PerfectDomain', nameserver: 'perfectdomain.com' },
  { provider: 'Moniker', nameserver: 'monikerdns.net' },
  { provider: 'Juming', nameserver: 'juming.com' },
]);

const PARKING_NAMESERVERS = Object.freeze([
  { provider: 'Above.com', nameserver: 'above.com' },
  { provider: 'Uniregistry Market', nameserver: 'uniregistrymarket.link' },
  { provider: 'ParkLogic', nameserver: 'parklogic.com' },
  { provider: 'SmartName', nameserver: 'smartname.com' },
  { provider: 'Dynadot Parking', nameserver: 'park1.dynadot.com' },
  { provider: 'Dynadot Parking', nameserver: 'park2.dynadot.com' },
  { provider: 'Dynadot Parking', nameserver: 'dyna-ns.net' },
  { provider: 'DNParking', nameserver: 'ns1.dnparking.com' },
  { provider: 'DNParking', nameserver: 'ns2.dnparking.com' },
  { provider: 'Epik', nameserver: 'epik.com' },
  { provider: 'Undeveloped', nameserver: 'ns1.undeveloped.com' },
  { provider: 'Undeveloped', nameserver: 'ns2.undeveloped.com' },
  { provider: 'Sav.com', nameserver: 'ns1.sav.com' },
  { provider: 'Sav.com', nameserver: 'ns2.sav.com' },
  { provider: 'Bodis', nameserver: 'ns1.bodis.com' },
  { provider: 'Bodis', nameserver: 'ns2.bodis.com' },
  { provider: 'Above.com', nameserver: 'abovedomains.com' },
  { provider: 'Ztomy', nameserver: 'ztomy.com' },
  { provider: 'SSLParking', nameserver: 'sslparking.com' },
  { provider: 'DCC DNS lander', nameserver: 'dccdns.com' },
  { provider: 'NamePros DNS', nameserver: 'namepros-dns.com' },
  { provider: 'NamePros DNS', nameserver: 'namepros-dns.is' },
  { provider: 'Onamae expired', nameserver: 'onamae-expired.com' },
  { provider: 'Web.com expiry', nameserver: 'pendingrenewaldeletion.com' },
  { provider: 'Web.com expiry', nameserver: 'renewyourname.net' },
  { provider: 'HugeDomains / NameBright expired', nameserver: 'expired1.namebrightdns.com' },
  { provider: 'HugeDomains / NameBright expired', nameserver: 'expired2.namebrightdns.com' },
  { provider: 'Expiration Warning', nameserver: 'ns3.expirationwarning.net' },
  { provider: 'Expiration Warning', nameserver: 'ns7.expirationwarning.net' },
  { provider: 'Parktons', nameserver: 'parktons.com' },
  { provider: 'Spaceship Parking', nameserver: 'launch1.spaceship.net' },
  { provider: 'Spaceship Parking', nameserver: 'launch2.spaceship.net' },
  { provider: 'Your Domain Provider', nameserver: 'yourdomainprovider.net' },
]);

const STATIC_PLATFORM_HOSTS = Object.freeze([
  ...SELLER_NAMESERVERS,
  ...PARKING_NAMESERVERS,
  { provider: 'Unstoppable Domains', nameserver: 'unstoppabledomains.com' },
  { provider: 'GiantPanda', nameserver: 'giantpanda.com' },
  { provider: 'Global Domain Group', nameserver: 'globaldomaingroup.com' },
  { provider: 'DomainCA', nameserver: 'domainca.com' },
]);

const EXPIRY_NAMESERVERS = Object.freeze([
  { provider: 'HugeDomains / NameBright expired', nameserver: 'expired1.namebrightdns.com' },
  { provider: 'HugeDomains / NameBright expired', nameserver: 'expired2.namebrightdns.com' },
  { provider: 'Expiration Warning', nameserver: 'ns3.expirationwarning.net' },
  { provider: 'Expiration Warning', nameserver: 'ns7.expirationwarning.net' },
  { provider: 'Web.com expiry', nameserver: 'pendingrenewaldeletion.com' },
  { provider: 'Web.com expiry', nameserver: 'renewyourname.net' },
  { provider: 'Onamae expired', nameserver: 'onamae-expired.com' },
  { provider: 'DNS Expired', nameserver: 'dns-expired.com' },
]);

const EXPIRY_WILDCARD_HOSTS = Object.freeze([
  { pattern: /^(?:[a-z0-9-]+\.)*expirens[0-9]+\.hichina\.com$/i, provider: 'Alibaba / HiChina expiry' },
  { pattern: /^(?:[a-z0-9-]+\.)*expired-domain-ns[0-9]+\.fabulous\.com$/i, provider: 'Fabulous expired' },
  { pattern: /^(?:[a-z0-9-]+\.)*[^.]*domain-expired\.myhostadmin\.net$/i, provider: 'West.cn expired' },
]);

const REGEX_HOST_CLASSIFIERS = Object.freeze([
  { pattern: /^(?:[a-z0-9-]+\.)*awsdns-\d+\.(?:com|net|org|co\.uk)$/i, klass: CLASS_HOSTING, provider: 'AWS Route 53' },
]);

function normalizeHost(value) {
  return String(value || '').toLowerCase().replace(/\.$/, '');
}

function buildClassifier({
  seller = SELLER_NAMESERVERS,
  parkingOnly = PARKING_NAMESERVERS,
  registrar = REGISTRAR_DEFAULT_NAMESERVERS,
  hosting = HOSTING_NAMESERVERS,
} = {}) {
  const table = new Map();
  const add = (list, klass) => {
    for (const entry of list) {
      const host = normalizeHost(entry?.nameserver);
      if (!host || table.has(host)) continue;
      table.set(host, { klass, provider: entry.provider });
    }
  };
  add(parkingOnly, CLASS_PARKING);
  add(seller, CLASS_SELLER);
  add(hosting, CLASS_HOSTING);
  add(registrar, CLASS_REGISTRAR);
  const cache = new Map();
  return function classifyHost(rawHost) {
    const host = normalizeHost(rawHost);
    if (!host) return { klass: CLASS_OTHER, provider: null };
    const cached = cache.get(host);
    if (cached) return cached;
    let found = null;
    let probe = host;
    for (;;) {
      const hit = table.get(probe);
      if (hit) { found = hit; break; }
      const dot = probe.indexOf('.');
      if (dot < 0) break;
      probe = probe.slice(dot + 1);
    }
    if (!found) {
      const regexHit = REGEX_HOST_CLASSIFIERS.find(entry => entry.pattern.test(host));
      if (regexHit) found = { klass: regexHit.klass, provider: regexHit.provider };
    }
    const result = found || { klass: CLASS_OTHER, provider: null };
    if (cache.size < 200000) cache.set(host, result);
    return result;
  };
}

const CLASS_PRIORITY = [CLASS_SELLER, CLASS_PARKING, CLASS_HOSTING, CLASS_REGISTRAR, CLASS_OTHER];

function classifyNameservers(hosts, classifyHost) {
  if (!hosts || !hosts.length) return { klass: CLASS_NONE, provider: null };
  let best = null;
  for (const host of hosts) {
    const c = classifyHost(host);
    if (!best || CLASS_PRIORITY.indexOf(c.klass) < CLASS_PRIORITY.indexOf(best.klass)) best = c;
  }
  return best;
}

function buildPlatformMatcher(hosts = STATIC_PLATFORM_HOSTS) {
  const table = new Map();
  for (const entry of hosts) {
    const host = normalizeHost(entry?.nameserver);
    if (!host || table.has(host)) continue;
    table.set(host, entry.provider);
  }
  const lookupOne = (rawHost) => {
    const host = normalizeHost(rawHost);
    if (!host) return null;
    let probe = host;
    for (;;) {
      if (table.has(probe)) return table.get(probe);
      const dot = probe.indexOf('.');
      if (dot < 0) return null;
      probe = probe.slice(dot + 1);
    }
  };
  return function matchPlatform(destinationHosts) {
    for (const host of destinationHosts || []) {
      const provider = lookupOne(host);
      if (provider) return { isPlatform: true, provider, matchedHost: normalizeHost(host) };
    }
    return { isPlatform: false, provider: null, matchedHost: null };
  };
}

function matchWildcardHosts(hosts, wildcards) {
  for (const rawHost of hosts || []) {
    const host = normalizeHost(rawHost);
    if (!host) continue;
    for (const entry of wildcards) {
      if (entry.pattern.test(host)) return { matched: true, provider: entry.provider, matchedHost: host };
    }
  }
  return { matched: false, provider: null, matchedHost: null };
}

function isExpiryDestination(hosts) {
  const staticMatch = buildPlatformMatcher(EXPIRY_NAMESERVERS)(hosts);
  if (staticMatch.isPlatform) return { isExpiry: true, provider: staticMatch.provider, matchedHost: staticMatch.matchedHost };
  const wildcardMatch = matchWildcardHosts(hosts, EXPIRY_WILDCARD_HOSTS);
  if (wildcardMatch.matched) return { isExpiry: true, provider: wildcardMatch.provider, matchedHost: wildcardMatch.matchedHost };
  return { isExpiry: false, provider: null, matchedHost: null };
}

function nsSetKey(hosts) {
  return [...new Set((hosts || []).map(normalizeHost).filter(Boolean))].sort().join(',');
}

function registrableNsDomain(host) {
  const normalized = normalizeHost(host);
  const parts = normalized.split('.');
  return parts.length <= 2 ? normalized : parts.slice(-2).join('.');
}

const LEARNED_PLATFORM_DAILY_THRESHOLD = 10;
const LEARNED_PLATFORM_TRAILING_THRESHOLD = 25;
const LEARNED_PLATFORM_TRAILING_DAYS = 7;

function isLearnedPlatformCohort({ dailyCount = 0, trailingCount = 0 } = {}) {
  const daily = Number(dailyCount) || 0;
  const trailing = Number(trailingCount) || 0;
  if (daily >= LEARNED_PLATFORM_DAILY_THRESHOLD) return { learned: true, reason: 'daily-threshold' };
  if (daily + trailing >= LEARNED_PLATFORM_TRAILING_THRESHOLD) return { learned: true, reason: 'trailing-threshold' };
  return { learned: false, reason: null };
}

module.exports = {
  CLASS_SELLER, CLASS_PARKING, CLASS_REGISTRAR, CLASS_HOSTING, CLASS_OTHER, CLASS_NONE,
  CLASS_PRIORITY,
  REGISTRAR_DEFAULT_NAMESERVERS, HOSTING_NAMESERVERS,
  SELLER_NAMESERVERS, PARKING_NAMESERVERS, STATIC_PLATFORM_HOSTS,
  EXPIRY_NAMESERVERS, EXPIRY_WILDCARD_HOSTS,
  normalizeHost, buildClassifier, classifyNameservers,
  buildPlatformMatcher, matchWildcardHosts, isExpiryDestination,
  nsSetKey, registrableNsDomain,
  LEARNED_PLATFORM_DAILY_THRESHOLD, LEARNED_PLATFORM_TRAILING_THRESHOLD, LEARNED_PLATFORM_TRAILING_DAYS,
  isLearnedPlatformCohort,
};
