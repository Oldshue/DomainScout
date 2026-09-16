'use strict';

const SELLER_NS_PATTERNS = Object.freeze([
  /(?:^|\.)afternic\.com$/i,
  /(?:^|\.)dan\.com$/i,
  /(?:^|\.)sedoparking\.com$/i,
  /(?:^|\.)sedo\.com$/i,
  /(?:^|\.)atom\.com$/i,
  /(?:^|\.)squadhelp\.com$/i,
  /(?:^|\.)brandbucket\.com$/i,
  /(?:^|\.)nameshift\.com$/i,
  /(?:^|\.)bodis\.com$/i,
  /(?:^|\.)parkingcrew\.net$/i,
  /(?:^|\.)eftydns\.com$/i,
  /(?:^|\.)namebrightdns\.com$/i,
  /(?:^|\.)buydomains\.com$/i,
]);

const PARKING_NS_PATTERNS = Object.freeze([
  ...SELLER_NS_PATTERNS,
  /(?:^|\.)launch[12]\.spaceship\.net$/i,
  /(?:^|\.)abovedomains\.com$/i,
  /(?:^|\.)parklogic\.com$/i,
  /(?:^|\.)ztomy\.com$/i,
  /(?:^|\.)parktons\.com$/i,
  /(?:^|\.)namepros-dns\.(?:com|is)$/i,
  /(?:^|\.)expired-domain-ns\d+\.fabulous\.com$/i,
  /(?:^|\.)dns-expired\.com$/i,
  /(?:^|\.)[^.]*domain-expired\.myhostadmin\.net$/i,
  /(?:^|\.)[^.]*suspended\.zxcs\.(?:nl|be|de)$/i,
  /(?:^|\.)yourdomainprovider\.net$/i,
  /(?:^|\.)sslparking\.com$/i,
  /(?:^|\.)dccdns\.com$/i,
  /(?:^|\.)epik\.com$/i,
  /(?:^|\.)onamae-expired\.com$/i,
  /(?:^|\.)pendingrenewaldeletion\.com$/i,
  /(?:^|\.)renewyourname\.net$/i,
]);

// Shared by fresh probes and retained/unprobed movement adjudication.
const normalize = values => (values || []).map(ns => String(ns).toLowerCase().replace(/\.$/, ''));
function delegationEvidence(entry) {
  const before = normalize(entry.sellerNameservers);
  const after = normalize(entry.buyerNameservers);
  const expiration = after.some(ns => /(?:^|\.)(?:expirens[0-9]+\.hichina\.com|expired[0-9]*\.namebrightdns\.com|expired-domain-ns[0-9]+\.fabulous\.com|dns-expired\.com|[^.]*domain-expired\.myhostadmin\.net|onamae-expired\.com|pendingrenewaldeletion\.com|renewyourname\.net)$/.test(ns));
  const suspended = after.some(ns => /(?:^|\.)(?:failed-whois-verification\.namecheap\.com|verify-contact-details\.namecheap\.com|[^.]*suspended\.zxcs\.(?:nl|be|de))$/.test(ns));
  const parking = after.length > 0 && after.every(ns => PARKING_NS_PATTERNS.some(p => p.test(ns)));
  const parkingOrigin = before.length > 0 && before.every(ns => /(?:^|\.)(?:bodis\.com|parkingcrew\.net|sedoparking\.com|parklogic\.com|abovedomains\.com|ztomy\.com|parktons\.com)$/.test(ns));
  const sellerOrigin = before.length > 0 && before.some(ns => SELLER_NS_PATTERNS.some(p => p.test(ns))) && !parkingOrigin;
  return { expiration, suspended, parking, parkingOrigin, sellerOrigin, destinationObserved: after.length > 0 };
}
module.exports = { SELLER_NS_PATTERNS, PARKING_NS_PATTERNS, delegationEvidence };
