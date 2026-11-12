'use strict';

// Derived Sale Watch feed fields, computed only from evidence DomainScout
// already stores on each ledger entry (no model, no network). Pure functions;
// every value returned is plain, structured-clone-safe data.
//
// VENUE_TAPES is the one maintained table that decides the tape:
//   aftermarket  the name left a resale marketplace / reseller nameservers
//   builder      the name left a registrar default parking page
//   noise        anything else (unknown or non-sale venues)
// Matched against the entry's venue and its seller nameservers. Add venues
// here, nowhere else.
const VENUE_TAPES = Object.freeze([
  Object.freeze({ tape: 'aftermarket', label: 'resale marketplace or reseller', match: /afternic|sedo|\bdan\b|dan\.com|undeveloped|squadhelp|atom\.com|\batom\b|brandbucket|hugedomains|buydomains|efty|\bsaw\.com|brandpa|namerific|domainmarket|uniregistry market/i }),
  Object.freeze({ tape: 'builder', label: 'registrar default parking', match: /domaincontrol|godaddy (?:default|parking)|registrar-servers|namecheap (?:default|parking)|porkbun|dynadot (?:default|parking)|name\.com default|googledomains|squarespace|hover\.com|ionos|networksolutions|registrar default/i }),
]);
const TAPES = Object.freeze(['aftermarket', 'builder', 'noise']);

// Every provider name the ledger can emit as a venue comes from the
// nameserver-class tables (marketplaceFromNameservers, the movement classifier
// and the seller-nameserver provider). Those tables back the regex rows above,
// so no real venue falls into noise by omission. Hosting and expiry providers
// are known venues that belong on the noise tape; only names in no table are
// unknown (and reported in the daily response diagnostics).
const nsc = require('./nameserver-classes');
const PROVIDER_ROWS = Object.freeze({
  aftermarket: Object.freeze({ tape: 'aftermarket', label: 'resale marketplace or reseller' }),
  builder: Object.freeze({ tape: 'builder', label: 'registrar default parking' }),
  noise: Object.freeze({ tape: 'noise', label: 'hosting, expiry or other known DNS' }),
});
const PROVIDER_TAPE = new Map();
// Venue class rule (the one place it is decided). 'registrar default parking'
// is a registrar's own default/parking page: Spaceship Parking, Dynadot Parking
// and every REGISTRAR_DEFAULT_NAMESERVERS provider. Every other seller and
// parking provider is 'resale marketplace or reseller'. Hosting and expiry
// providers are known non-sale venues (noise).
const REGISTRAR_DEFAULT_PARKING = Object.freeze(['Spaceship Parking', 'Dynadot Parking']);
for (const name of REGISTRAR_DEFAULT_PARKING) PROVIDER_TAPE.set(name.toLowerCase(), 'builder');
function addProviders(list, tape) {
  for (const e of list || []) {
    const key = String((e && e.provider) || '').trim().toLowerCase();
    if (key && !PROVIDER_TAPE.has(key)) PROVIDER_TAPE.set(key, tape);
  }
}
addProviders(nsc.SELLER_NAMESERVERS, 'aftermarket');
addProviders(nsc.PARKING_NAMESERVERS, 'aftermarket');
addProviders(nsc.REGISTRAR_DEFAULT_NAMESERVERS, 'builder');
addProviders(nsc.HOSTING_NAMESERVERS, 'noise');
addProviders(nsc.EXPIRY_NAMESERVERS, 'noise');
addProviders(nsc.EXPIRY_WILDCARD_HOSTS, 'noise');
const KLASS_TAPE = Object.freeze({ seller: 'aftermarket', parking: 'aftermarket', registrar: 'builder', hosting: 'noise' });
let classifyHost = null;

function providerTape(venue) {
  const name = String(venue || '').trim().toLowerCase();
  if (!name) return null;
  if (PROVIDER_TAPE.has(name)) return PROVIDER_TAPE.get(name);
  // discovery joins several providers with ' / ' (some names contain it too).
  const tapes = name.split(' / ').map(p => PROVIDER_TAPE.get(p.trim())).filter(Boolean);
  for (const t of TAPES) if (tapes.includes(t)) return t;
  return null;
}

function venueRow(venue, sellerNameservers = []) {
  // An exact provider name from the nameserver-class tables wins over the
  // regex rows (e.g. 'Dynadot Parking' is parking, not a registrar default).
  const byName = providerTape(venue);
  if (byName) return PROVIDER_ROWS[byName];
  const hay = [venue || '', ...(Array.isArray(sellerNameservers) ? sellerNameservers : [])].join(' ');
  for (const row of VENUE_TAPES) if (row.match.test(hay)) return row;
  if (!classifyHost) classifyHost = nsc.buildClassifier();
  const found = new Set();
  for (const ns of Array.isArray(sellerNameservers) ? sellerNameservers : []) {
    const t = KLASS_TAPE[classifyHost(ns).klass];
    if (t) found.add(t);
  }
  for (const t of TAPES) if (found.has(t)) return PROVIDER_ROWS[t];
  return null;
}

function tapeForVenue(venue, sellerNameservers = []) {
  const row = venueRow(venue, sellerNameservers);
  return row ? row.tape : 'noise';
}

const VENUE_CLASSES = Object.freeze({ builder: 'registrar default parking', aftermarket: 'resale marketplace or reseller' });
/** 'registrar default parking' | 'resale marketplace or reseller' | null (other known or unknown DNS). */
function venueClass(venue, sellerNameservers = []) {
  const row = venueRow(venue, sellerNameservers);
  return row ? VENUE_CLASSES[row.tape] || null : null;
}

// A name registered this many days or fewer before it left the venue is a
// builder's fresh registration, whatever the venue.
const BUILDER_MAX_AGE_DAYS = 90;
const DAY_MS = 86400000;

function registeredDate(rdap) {
  if (!rdap || typeof rdap !== 'object') return null;
  for (const key of ['registeredAt', 'createdAt', 'registrationDate', 'created']) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(rdap[key] || ''));
    if (m && Number.isFinite(Date.parse(`${m[1]}T00:00:00Z`))) return m[1];
  }
  return null;
}

function departureDay(entry) {
  const d = entry.discovery || {};
  for (const v of [d.departureDate, d.movement && d.movement.day, entry.reportDate]) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
    if (m) return m[1];
  }
  return null;
}

/**
 * Tape for one row from venue class AND stored registration date:
 *   builder      registered <= 90 days before departure (any venue), or
 *                registrar default parking with no known registration date
 *   aftermarket  resale marketplace / reseller venue, or registrar default
 *                parking registered > 90 days before departure ('older name':
 *                most likely a private purchase)
 *   noise        any other venue without a fresh registration
 */
function tapeForRow(entry) {
  const klass = venueClass(entry.venue, entry.sellerNameservers);
  const reg = registeredDate((entry.discovery || {}).rdap);
  const dep = departureDay(entry);
  const ageDays = reg && dep ? Math.floor((Date.parse(`${dep}T00:00:00Z`) - Date.parse(`${reg}T00:00:00Z`)) / DAY_MS) : null;
  const out = { venueClass: klass, registeredDate: reg, registeredAgeDays: ageDays, olderName: false };
  if (ageDays !== null && ageDays <= BUILDER_MAX_AGE_DAYS) return { ...out, tape: 'builder' };
  if (klass === 'registrar default parking') {
    if (ageDays === null) return { ...out, tape: 'builder' };
    return { ...out, tape: 'aftermarket', olderName: true };
  }
  if (klass === 'resale marketplace or reseller') return { ...out, tape: 'aftermarket' };
  return { ...out, tape: 'noise' };
}

function registeredYearBand(y) {
  if (!Number.isInteger(y)) return null;
  if (y < 2000) return 'before 2000';
  if (y < 2010) return '2000-2009';
  if (y < 2020) return '2010-2019';
  return '2020 or later';
}

function otherExtensionsBand(n) {
  if (!Number.isInteger(n) || n < 0) return null;
  if (n === 0) return '0 other';
  if (n <= 4) return '1-4 other';
  if (n <= 19) return '5-19 other';
  return '20+ other';
}

function lengthBand(n) {
  if (n <= 4) return '1-4';
  if (n <= 6) return '5-6';
  if (n <= 8) return '7-8';
  if (n <= 11) return '9-11';
  return '12+';
}

// Homepage state in plain words, one of HOMEPAGE_STATES.
const HOMEPAGE_STATES = Object.freeze(['live site', 'parked', 'for sale', 'no site yet', 'site not checked']);
function homepageState(homepage) {
  if (!homepage || typeof homepage !== 'object') return 'site not checked';
  const purpose = homepage.purpose && typeof homepage.purpose === 'object' ? homepage.purpose : {};
  if (purpose.forSale === true || purpose.kind === 'sales-lander') return 'for sale';
  if (homepage.parked) return 'parked';
  if (homepage.placeholder) return 'no site yet';
  const status = Number(homepage.status);
  if (homepage.active && (!Number.isFinite(status) || status < 400)) return 'live site';
  return 'no site yet';
}

function registeredYear(rdap) {
  if (!rdap || typeof rdap !== 'object') return null;
  for (const key of ['registeredAt', 'createdAt', 'registrationDate', 'created']) {
    const m = /^(\d{4})/.exec(String(rdap[key] || ''));
    if (m) return Number(m[1]);
  }
  return null;
}

function timeline(entry) {
  const out = [];
  const mv = entry.discovery && entry.discovery.movement;
  if (mv && mv.day) out.push({ at: String(mv.day), kind: 'movement', detail: `${mv.prevDay || '?'} → ${mv.day}: left ${mv.previousProvider || 'seller'} DNS` });
  const obs = (entry.reconstruction && Array.isArray(entry.reconstruction.observations)) ? entry.reconstruction.observations : [];
  for (const o of obs.slice(-11)) {
    if (!o || typeof o !== 'object') continue;
    const detail = o.kind === 'movement'
      ? `${(o.previousNameservers || []).join(', ')} → ${(o.currentNameservers || []).join(', ')}`
      : [o.registrar || null, o.homepage && o.homepage.finalUrl || null, o.classification || o.tier || null].filter(Boolean).join(' · ');
    out.push({ at: String(o.at || o.day || ''), kind: String(o.kind || 'probe'), detail: detail || 'observed' });
  }
  return out;
}

// SOLD, the feed's default and headline number (owner decision). One function,
// stored evidence only, never the suspected view. Returns the plain-words
// reason, strongest first, or null for a candidate:
//   likely-sale                       -> by its basis (built / transfer / off-market)
//   transfer-completed                -> transfer + built site | registrar transfer
//   transfer-in-progress after leaving a resale marketplace or reseller venue
//   acquisition-candidate on the aftermarket tape with assessment.buyerUse and
//   assessment.identity.aligned (a built site matching the name), not relisted,
//   not a parking/template title, not an expiry or portfolio move.
// On the builder tape the same definition reads as 'live'.
const SOLD_REASONS = Object.freeze(['transfer + built site', 'registrar transfer', 'transfer in progress', 'buyer site live', 'off market 14+ days']);
const TEMPLATE_TITLE = /\b(?:parked|for sale|buy this domain|domain (?:is )?for sale|coming soon|under construction|welcome to nginx|default (?:web )?page|index of|just another wordpress|website builder|launching soon|placeholder|this domain)\b/i;
function builtMatchingSite(entry) {
  const a = entry.assessment || {};
  return a.buyerUse === true && !!(a.identity && a.identity.aligned === true);
}
function soldReason(entry, placed = null) {
  if (!entry || typeof entry !== 'object') return null;
  const a = entry.assessment || {};
  const d = entry.discovery || {};
  const c = entry.classification;
  const built = builtMatchingSite(entry);
  if (c === 'likely-sale') {
    if (a.basis === 'built') return 'transfer + built site';
    if (a.basis === 'transfer') return 'registrar transfer';
    if (a.basis === 'off-market') return 'off market 14+ days';
    return built ? 'transfer + built site' : 'registrar transfer';
  }
  if (c === 'transfer-completed') return built ? 'transfer + built site' : 'registrar transfer';
  const klass = placed && placed.venueClass ? placed.venueClass : venueClass(entry.venue, entry.sellerNameservers);
  if (c === 'transfer-in-progress') return klass === 'resale marketplace or reseller' ? 'transfer in progress' : null;
  if (c === 'acquisition-candidate') {
    const tape = placed && placed.tape ? placed.tape : tapeForVenue(entry.venue, entry.sellerNameservers);
    if (tape !== 'aftermarket' && tape !== 'builder') return null;
    if (!built || a.relisted === true) return null;
    const title = String((d.homepage && d.homepage.title) || entry.buyerTitle || '');
    if (TEMPLATE_TITLE.test(title)) return null;
    if (a.delegation && (a.delegation.expiration || a.delegation.parking)) return null;
    if (Number((d.kit && d.kit.size) || 0) >= 3 || Number((d.movement && d.movement.cohortSize) || 0) >= 10) return null;
    return 'buyer site live';
  }
  return null;
}

/** Derived feed fields for one normalized ledger entry. */
function deriveRow(entry) {
  const domain = String(entry.domain || '');
  const label = domain.split('.')[0] || '';
  const discovery = entry.discovery || {};
  const rdap = discovery.rdap || {};
  // Other extensions: only a verified whole-root count ({ count, verified: true }).
  // Zone-index or lower-bound observations are never shown as a count.
  const ext = discovery.otherExtensions;
  const vrow = venueRow(entry.venue, entry.sellerNameservers);
  const year = registeredYear(rdap);
  const placed = tapeForRow(entry);
  const otherCount = ext && typeof ext === "object" && ext.verified === true && Number.isInteger(ext.count) && ext.count >= 0 ? ext.count : null;
  const why = soldReason(entry, placed);
  return {
    tape: placed.tape,
    venueKnown: !!vrow,
    venueClass: placed.venueClass,
    registeredDate: placed.registeredDate,
    olderName: placed.olderName,
    classification: entry.classification || null,
    // Likely-sale tier: the stored classification says likely-sale.
    probablySold: entry.classification === 'likely-sale',
    // SOLD (owner definition): reason in plain words, or null for a candidate.
    sold: why != null,
    soldReason: why,
    venue: entry.venue || null,
    buyerTitle: entry.buyerTitle || null,
    buyerUrl: entry.buyerUrl || null,
    homepageState: homepageState(discovery.homepage),
    registrar: rdap.registrar || null,
    registeredYear: year,
    registeredYearBand: registeredYearBand(year),
    length: label.length,
    lengthBand: lengthBand(label.length),
    extension: domain.slice(label.length + 1) || null,
    hasHyphen: label.includes('-'),
    hasDigit: /\d/.test(label),
    // Verified whole-root count only; otherwise null and nothing is shown.
    otherExtensions: otherCount,
    otherExtensionsBand: otherExtensionsBand(otherCount),
    tier: entry.tier || null,
    timeline: timeline(entry),
  };
}

module.exports = { SOLD_REASONS, soldReason, VENUE_TAPES, TAPES, HOMEPAGE_STATES, VENUE_CLASSES, REGISTRAR_DEFAULT_PARKING, BUILDER_MAX_AGE_DAYS, venueRow, tapeForVenue, venueClass, registeredDate, departureDay, tapeForRow, registeredYearBand, otherExtensionsBand, lengthBand, homepageState, registeredYear, deriveRow };
