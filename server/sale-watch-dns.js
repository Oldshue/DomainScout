'use strict';

/**
 * Single source of truth: every seller/parking/expiry nameserver host this
 * module reasons about lives in server/nameserver-classes.js. No hand-
 * maintained hostname list is kept here -- SELLER_NS_PATTERNS and
 * PARKING_NS_PATTERNS below are anchored suffix regexes DERIVED from those
 * tables (kept as RegExp arrays because server/sale-watch-discovery.js
 * tests a single hostname against them via `.some(pattern => pattern.test(ns))`).
 *
 * Derivation collapses each table entry to its registrable (last two label)
 * domain -- reproducing the original hand-written "any subdomain of
 * afternic.com" style suffix patterns -- UNLESS that registrable domain is
 * also used by a REGISTRAR_DEFAULT_NAMESERVERS or HOSTING_NAMESERVERS entry
 * (e.g. park1.dynadot.com's registrable domain, dynadot.com, is Dynadot's
 * plain registrar-default host too; ns1.sav.com's registrable domain,
 * sav.com, is Sav's registrar-default host too). For those collision-risk
 * entries the exact host is used instead of its registrable domain, so a
 * domain merely using a registrar's own default DNS is never misclassified
 * as parking.
 */
const {
  SELLER_NAMESERVERS,
  PARKING_NAMESERVERS,
  EXPIRY_NAMESERVERS,
  REGISTRAR_DEFAULT_NAMESERVERS,
  HOSTING_NAMESERVERS,
  normalizeHost,
  registrableNsDomain,
  isExpiryDestination,
} = require('./nameserver-classes');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COLLISION_RISK_DOMAINS = new Set(
  [...REGISTRAR_DEFAULT_NAMESERVERS, ...HOSTING_NAMESERVERS]
    .map((entry) => registrableNsDomain(entry.nameserver))
    .filter(Boolean)
);

function suffixPatternsFor(tables) {
  const values = new Set();
  for (const table of tables) {
    for (const entry of table) {
      const host = normalizeHost(entry?.nameserver);
      if (!host) continue;
      const domain = registrableNsDomain(host);
      values.add(COLLISION_RISK_DOMAINS.has(domain) ? host : domain);
    }
  }
  return [...values].sort().map((value) => new RegExp(`(?:^|\\.)${escapeRegExp(value)}$`, 'i'));
}

const SELLER_NS_PATTERNS = Object.freeze(suffixPatternsFor([SELLER_NAMESERVERS]));
const PARKING_NS_PATTERNS = Object.freeze(suffixPatternsFor([SELLER_NAMESERVERS, PARKING_NAMESERVERS, EXPIRY_NAMESERVERS]));

// Suspended/verification-hold hosts: not a table in server/nameserver-classes.js
// (out of scope for the seller/parking/expiry consolidation -- these are
// registrar compliance holds, not marketplace, parking or expiry infrastructure)
// and kept local, same as before.
const SUSPENDED_HOST_PATTERN = /(?:^|\.)(?:failed-whois-verification\.namecheap\.com|verify-contact-details\.namecheap\.com|[^.]*suspended\.zxcs\.(?:nl|be|de))$/;
const PARKING_ORIGIN_PATTERN = /(?:^|\.)(?:bodis\.com|parkingcrew\.net|sedoparking\.com|parklogic\.com|abovedomains\.com|ztomy\.com|parktons\.com)$/;

// Shared by fresh probes and retained/unprobed movement adjudication.
const normalize = values => (values || []).map(ns => String(ns).toLowerCase().replace(/\.$/, ''));
function delegationEvidence(entry) {
  const before = normalize(entry.sellerNameservers);
  const after = normalize(entry.buyerNameservers);
  const expiration = isExpiryDestination(after).isExpiry;
  const suspended = after.some(ns => SUSPENDED_HOST_PATTERN.test(ns));
  const parking = after.length > 0 && after.every(ns => PARKING_NS_PATTERNS.some(p => p.test(ns)));
  const parkingOrigin = before.length > 0 && before.every(ns => PARKING_ORIGIN_PATTERN.test(ns));
  const sellerOrigin = before.length > 0 && before.some(ns => SELLER_NS_PATTERNS.some(p => p.test(ns))) && !parkingOrigin;
  return { expiration, suspended, parking, parkingOrigin, sellerOrigin, destinationObserved: after.length > 0 };
}
module.exports = { SELLER_NS_PATTERNS, PARKING_NS_PATTERNS, delegationEvidence };
