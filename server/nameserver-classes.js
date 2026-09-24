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
 * Single source of truth: server/zone-ns-universe.js, server/sale-watch-dns.js
 * and server/sale-watch-discovery.js all derive their seller/parking
 * nameserver lists from SELLER_NAMESERVERS / PARKING_NAMESERVERS below
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
  // Investor / registrar platforms measured absorbing marketplace/parking
  // departures on the 2026-09-22 nameserver-movement tape (see
  // STATIC_PLATFORM_HOSTS below for the parallel sale-candidacy exclusion of
  // these same operators).
  { provider: 'Unstoppable Domains', nameserver: 'unstoppabledomains.com' },
  { provider: 'GiantPanda default', nameserver: 'giantpanda.com' },
  { provider: 'Global Domain Group default', nameserver: 'globaldomaingroup.com' },
  { provider: 'DomainCA default', nameserver: 'domainca.com' },
]);

// Hosting, CDN and site-builder DNS: a name on one of these is being used
// (or at least deliberately pointed) by an operator.
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

// Seller-listing nameservers: an aftermarket/broker/investor marketplace
// that lists a name for sale. Canonical source for every caller that needs
// the seller universe (server/zone-ns-universe.js, server/sale-watch-dns.js,
// server/sale-watch-discovery.js).
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

// Parking/marketplace landers and expiry-processing pages, not already
// covered above. ns1/ns2.domaincontrol.com (GoDaddy's registrar-default DNS)
// is intentionally EXCLUDED here — it is assigned to every GoDaddy-registered
// domain regardless of sale/parking status, so including it would flood the
// universe with false positives.
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
]);

// Static platform-infrastructure hosts: destinations known NOT to be an
// end-user buyer (registrar default, marketplace, parking, expiry or
// investor platform), independent of their seller/parking/registrar/hosting
// CLASS_* above. A departure landing on any host in this table — or on a
// nameserver set later LEARNED as platform infrastructure by volume (see
// LEARNED_PLATFORM_* below) — is excluded from sale candidacy with a
// counted reason. Union of SELLER_NAMESERVERS, PARKING_NAMESERVERS and the
// registrar entries called out as investor/registrar platforms above.
const STATIC_PLATFORM_HOSTS = Object.freeze([
  ...SELLER_NAMESERVERS,
  ...PARKING_NAMESERVERS,
  { provider: 'Unstoppable Domains', nameserver: 'unstoppabledomains.com' },
  { provider: 'GiantPanda', nameserver: 'giantpanda.com' },
  { provider: 'Global Domain Group', nameserver: 'globaldomaingroup.com' },
  { provider: 'DomainCA', nameserver: 'domainca.com' },
]);

// AWS Route 53 nameservers carry a variable numeric segment before the TLD
// (e.g. ns-1472.awsdns-56.org) that exact/suffix table matching cannot
// express. This is the one provider needing a regex fallback; every other
// entry above still matches via plain exact/suffix lookup.
const REGEX_HOST_CLASSIFIERS = Object.freeze([
  { pattern: /^(?:[a-z0-9-]+\.)*awsdns-\d+\.(?:com|net|org|co\.uk)$/i, klass: CLASS_HOSTING, provider: 'AWS Route 53' },
]);

function normalizeHost(value) {
  return String(value || '').toLowerCase().replace(/\.$/, '');
}

/**
 * Builds a suffix classifier over the four operator tables. Lookup is by
 * exact host first, then by every parent suffix of the host, so
 * `ns3.foo.example.net` matches an `example.net` entry.
 *
 * `seller`/`parkingOnly` default to the canonical SELLER_NAMESERVERS /
 * PARKING_NAMESERVERS tables above, so a bare buildClassifier() call already
 * carries the full seller/parking universe; callers that need a restricted
 * or extended set (e.g. zone-ns-movement.js's zone-wide universe) can still
 * pass their own.
 */
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
  // Order matters: parking-only entries (shared with the seller universe by
  // zone-ns-universe) must classify as parking, sellers as seller.
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

/**
 * Classifies a whole nameserver set: seller wins over parking, parking over
 * hosting, hosting over registrar default, registrar over other. The
 * provider is the one behind the winning class.
 */
function classifyNameservers(hosts, classifyHost) {
  if (!hosts || !hosts.length) return { klass: CLASS_NONE, provider: null };
  let best = null;
  for (const host of hosts) {
    const c = classifyHost(host);
    if (!best || CLASS_PRIORITY.indexOf(c.klass) < CLASS_PRIORITY.indexOf(best.klass)) best = c;
  }
  return best;
}

/**
 * Builds a lookup for STATIC_PLATFORM_HOSTS (exact + suffix, same algorithm
 * as buildClassifier's table): returns a function(hosts[]) => { isPlatform,
 * provider, matchedHost } that is true when ANY host in the destination set
 * matches a cataloged platform host.
 */
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

/**
 * The sorted, deduped, comma-joined nameserver set key used to group
 * departures by exact destination for the learned-platform volume test.
 * Two departures land on "the same platform" for this purpose only when
 * their full nameserver sets match exactly.
 */
function nsSetKey(hosts) {
  return [...new Set((hosts || []).map(normalizeHost).filter(Boolean))].sort().join(',');
}

/**
 * The registrable (last two label) domain of a nameserver host, used to
 * label a learned-platform nsKey for a human-readable "top learned
 * platforms" summary (e.g. ns1.example-registrar.com -> example-registrar.com).
 */
function registrableNsDomain(host) {
  const normalized = normalizeHost(host);
  const parts = normalized.split('.');
  return parts.length <= 2 ? normalized : parts.slice(-2).join('.');
}

// Generalized platform-learning thresholds: any destination nameserver set
// absorbing at least this many seller/parking departures in one day, or at
// least this many in a trailing 7-day window, is platform infrastructure —
// not a buyer — regardless of whether it is in the static table above.
const LEARNED_PLATFORM_DAILY_THRESHOLD = 10;
const LEARNED_PLATFORM_TRAILING_THRESHOLD = 25;
const LEARNED_PLATFORM_TRAILING_DAYS = 7;

/**
 * Pure decision function: given the count of departures landing on one nsKey
 * TODAY and the trailing count over the prior LEARNED_PLATFORM_TRAILING_DAYS
 * (not including today), decides whether that destination has crossed the
 * generalized learned-platform threshold. Kept dependency-free (no DB) so it
 * is directly unit-testable; persistence/lookback live in
 * server/sale-watch-reconstruction.js, which owns the SQLite schema.
 */
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
  normalizeHost, buildClassifier, classifyNameservers,
  buildPlatformMatcher, nsSetKey, registrableNsDomain,
  LEARNED_PLATFORM_DAILY_THRESHOLD, LEARNED_PLATFORM_TRAILING_THRESHOLD, LEARNED_PLATFORM_TRAILING_DAYS,
  isLearnedPlatformCohort,
};
