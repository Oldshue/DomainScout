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
  Object.freeze({ tape: 'aftermarket', label: 'resale marketplace', match: /afternic|sedo|\bdan\b|dan\.com|undeveloped|squadhelp|atom\.com|\batom\b|brandbucket|hugedomains|buydomains|efty|\bsaw\.com|brandpa|namerific|domainmarket|uniregistry market/i }),
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
  aftermarket: Object.freeze({ tape: 'aftermarket', label: 'resale marketplace or parking' }),
  builder: Object.freeze({ tape: 'builder', label: 'registrar default parking' }),
  noise: Object.freeze({ tape: 'noise', label: 'hosting, expiry or other known DNS' }),
});
const PROVIDER_TAPE = new Map();
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

function homepageState(homepage) {
  if (!homepage || typeof homepage !== 'object') return 'not checked';
  if (homepage.parked) return 'parked';
  if (homepage.placeholder) return 'placeholder';
  const status = Number(homepage.status);
  if (homepage.active && (!Number.isFinite(status) || status < 400)) return 'live site';
  return 'unreachable';
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
  const otherCount = ext && typeof ext === "object" && ext.verified === true && Number.isInteger(ext.count) && ext.count >= 0 ? ext.count : null;
  return {
    tape: vrow ? vrow.tape : 'noise',
    venueKnown: !!vrow,
    classification: entry.classification || null,
    // Likely-sale tier: the stored classification says likely-sale.
    probablySold: entry.classification === 'likely-sale',
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

module.exports = { VENUE_TAPES, TAPES, venueRow, tapeForVenue, registeredYearBand, otherExtensionsBand, lengthBand, homepageState, registeredYear, deriveRow };
