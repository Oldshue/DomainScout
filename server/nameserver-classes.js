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
 * `seller`/`parkingOnly` default to empty: callers that need the
 * seller/parking universe (currently only zone-ns-movement.js) pass those
 * tables in explicitly, keeping this module free of any dependency on the
 * seller/parking nameserver lists (which live alongside sale-evidence code
 * and would otherwise reintroduce a require cycle).
 */
function buildClassifier({
  seller = [],
  parkingOnly = [],
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

module.exports = {
  CLASS_SELLER, CLASS_PARKING, CLASS_REGISTRAR, CLASS_HOSTING, CLASS_OTHER, CLASS_NONE,
  CLASS_PRIORITY,
  REGISTRAR_DEFAULT_NAMESERVERS, HOSTING_NAMESERVERS,
  normalizeHost, buildClassifier, classifyNameservers,
};
