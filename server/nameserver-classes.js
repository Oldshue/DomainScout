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
  // Registrar defaults seen among production's volume-learned destinations
  // (2026-11-24 movement tape); each host answered a lookup on 2026-11-26.
  { provider: 'REG.RU default', nameserver: 'reg.ru' },
  { provider: 'Aruba default', nameserver: 'technorail.com' },
  { provider: 'iPage default', nameserver: 'ipage.com' },
  { provider: 'Joker.com default', nameserver: 'joker.com' },
  { provider: 'United Domains default', nameserver: 'ns14.net' },
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
  // Shared hosting / managed DNS added 2026-11-26 (each host answered a lookup
  // that day; the last block was seen in production's 2026-11-24 movement tape).
  { provider: 'Vultr', nameserver: 'vultr.com' },
  { provider: 'UltraDNS', nameserver: 'ultradns.net' },
  { provider: 'easyDNS', nameserver: 'easydns.com' },
  { provider: 'deSEC', nameserver: 'desec.io' },
  { provider: 'Gcore', nameserver: 'gcorelabs.net' },
  { provider: 'Hostinger', nameserver: 'hostinger.com' },
  { provider: 'InMotion Hosting', nameserver: 'inmotionhosting.com' },
  { provider: 'A2 Hosting', nameserver: 'a2hosting.com' },
  { provider: 'GreenGeeks', nameserver: 'greengeeks.com' },
  { provider: 'HostPapa', nameserver: 'hostpapa.com' },
  { provider: 'Contabo', nameserver: 'contabo.net' },
  { provider: 'Hostwinds', nameserver: 'hostwinds.com' },
  { provider: 'Scaleway', nameserver: 'scaleway.com' },
  { provider: 'Liquid Web', nameserver: 'liquidweb.com' },
  { provider: 'Cloudways', nameserver: 'cloudways.com' },
  { provider: 'Media Temple', nameserver: 'mediatemple.net' },
  { provider: 'pair Networks', nameserver: 'pair.com' },
  { provider: 'Selectel', nameserver: 'selectel.org' },
  { provider: 'Timeweb', nameserver: 'timeweb.ru' },
  { provider: 'Beget', nameserver: 'beget.com' },
  { provider: 'netcup', nameserver: 'netcup.net' },
  { provider: 'STRATO', nameserver: 'strato.de' },
  { provider: 'one.com', nameserver: 'one.com' },
  { provider: 'Oracle Dyn', nameserver: 'dynect.net' },
  { provider: 'Huawei Cloud DNS', nameserver: 'huaweicloud-dns.cn' },
  { provider: 'Websupport', nameserver: 'websupport.sk' },
  { provider: 'Webglobe', nameserver: 'webglobe.cz' },
  { provider: 'TheHost', nameserver: 'thehost.ua' },
  { provider: 'Turbify', nameserver: 'turbify.com' },
  // Shared nameservers whose operator is not cataloged: names known to have
  // sold sat behind them (gpuarch.com, inferenceflow.com). Hosting class, so a
  // bulk cohort on one exact set is still read as one operator.
  { provider: 'ns36.de', nameserver: 'ns36.de' },
  { provider: 'nameserver.run', nameserver: 'nameserver.run' },
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
  // Sale inventory seen as the largest uncataloged nameserver destinations in
  // production's learned-platform table (2026-11-25); each is a marketplace,
  // a dealer's own stock or a broker lander, so a name leaving it is a
  // seller departure.
  { provider: 'GoDaddy NameFind', nameserver: 'namefind.com' },
  { provider: 'DomainMarket', nameserver: 'domain-is-4-sale-at-domainmarket.com' },
  { provider: 'Saw.com', nameserver: 'sawsells.com' },
  { provider: 'Nameify', nameserver: 'nameify.com' },
  { provider: 'NameAgents', nameserver: 'nameagents.com' },
  { provider: 'DNX', nameserver: 'dnx.com' },
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
  { provider: 'GoDaddy CashParking', nameserver: 'cashparking.com' },
  { provider: 'Park My Domain', nameserver: 'park-my-domain.net' },
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
  { provider: 'Sav expired', nameserver: 'ns1-expired.sav.com' },
  { provider: 'Sav expired', nameserver: 'ns2-expired.sav.com' },
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

// ── Shared DNS is never a platform by volume alone ──────────────────────
// The learned rule above reads "many seller departures landed on this exact
// nameserver set" as "one operator took them". That holds for a private
// nameserver pair and fails for DNS that thousands of unrelated owners share:
// a registrar's default nameservers, or a hosting / CDN DNS provider. Those
// are exactly where a buyer's name sits after a marketplace sale, so volume
// on them says nothing about who owns a name.
//   registrar default: never learned as a platform, whatever the volume;
//   shared hosting DNS: learned only when one exact nameserver set took a
//     cohort chance cannot explain in ONE day (SHARED_HOSTING_BULK_THRESHOLD);
//     the trailing window is not used (a busy pair reaches 25 in a week by
//     chance);
//   everything else: the learned rule above, unchanged.
//
// SHARED_HOSTING_BULK_THRESHOLD = 100. Production, 2026-11-24, seller
// departures to Cloudflare by exact nameserver pair (see the PR for the full
// table): 2,713 pairs took one name, 234 took
// two, and 3,229 of the 3,326 pairs took ten or fewer (4,522 names): about
// 0.17 names per pair in use, so chance puts 6 names on one pair less than
// once in ten million pairs. Above that sat one pair with 5,296 names, five
// with 497 to 777, and ten with 100 to 186: 9,850 names on 16 pairs. 100 is
// also 2.4 times the busiest provider whose customers all share ONE set
// (Vercel and Wix, 41 names each that day), where a count is the provider's
// whole organic volume and not a cohort.
const SHARED_HOSTING_BULK_THRESHOLD = 100;

let sharedClassifier = null;
let sharedPlatformMatcher = null;
/**
 * 'registrar' | 'hosting' when the destination nameserver set is DNS shared by
 * unrelated owners (cataloged registrar-default or hosting / CDN DNS) and no
 * host in it is a cataloged marketplace, parking or expiry host; else null.
 */
function sharedDnsClass(hosts) {
  const list = (hosts || []).map(normalizeHost).filter(Boolean);
  if (!list.length) return null;
  if (!sharedClassifier) { sharedClassifier = buildClassifier(); sharedPlatformMatcher = buildPlatformMatcher(); }
  if (sharedPlatformMatcher(list).isPlatform || isExpiryDestination(list).isExpiry) return null;
  const klass = classifyNameservers(list, sharedClassifier).klass;
  return klass === CLASS_REGISTRAR || klass === CLASS_HOSTING ? klass : null;
}

/** A short label for a destination nameserver set: its cataloged provider, else the registrable domain of its first host. */
function destinationLabel(hosts) {
  const list = [...new Set((hosts || []).map(normalizeHost).filter(Boolean))].sort();
  if (!list.length) return null;
  if (!sharedClassifier) { sharedClassifier = buildClassifier(); sharedPlatformMatcher = buildPlatformMatcher(); }
  const platform = sharedPlatformMatcher(list);
  if (platform.isPlatform) return platform.provider;
  return classifyNameservers(list, sharedClassifier).provider || registrableNsDomain(list[0]);
}

/**
 * The ONE "did this destination nameserver set take a platform-sized cohort"
 * rule, used by the movement import, the ledger backfill, the excluded-row
 * rescore and the adjudicator: { learned, reason, shared }. `hosts` is the
 * destination set (or its nsSetKey string).
 */
function learnedPlatformDecision(hosts, { dailyCount = 0, trailingCount = 0 } = {}) {
  const list = typeof hosts === 'string' ? hosts.split(',') : (hosts || []);
  const shared = sharedDnsClass(list);
  if (shared === CLASS_REGISTRAR) return { learned: false, reason: null, shared };
  if (shared === CLASS_HOSTING) {
    return (Number(dailyCount) || 0) >= SHARED_HOSTING_BULK_THRESHOLD
      ? { learned: true, reason: 'shared-hosting-bulk', shared }
      : { learned: false, reason: null, shared };
  }
  return { ...isLearnedPlatformCohort({ dailyCount, trailingCount }), shared: null };
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
  SHARED_HOSTING_BULK_THRESHOLD, sharedDnsClass, learnedPlatformDecision, destinationLabel,
};
