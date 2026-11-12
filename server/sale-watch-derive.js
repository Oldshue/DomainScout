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

function tapeForVenue(venue, sellerNameservers = []) {
  const hay = [venue || '', ...(Array.isArray(sellerNameservers) ? sellerNameservers : [])].join(' ');
  for (const row of VENUE_TAPES) if (row.match.test(hay)) return row.tape;
  return 'noise';
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
  const other = Number(discovery.otherExtensionsTaken ?? discovery.extensionCount);
  return {
    tape: tapeForVenue(entry.venue, entry.sellerNameservers),
    venue: entry.venue || null,
    buyerTitle: entry.buyerTitle || null,
    buyerUrl: entry.buyerUrl || null,
    homepageState: homepageState(discovery.homepage),
    registrar: rdap.registrar || null,
    registeredYear: registeredYear(rdap),
    length: label.length,
    lengthBand: lengthBand(label.length),
    extension: domain.slice(label.length + 1) || null,
    hasHyphen: label.includes('-'),
    hasDigit: /\d/.test(label),
    // Only when the stored evidence carries it; the zone index is not read here.
    otherExtensions: Number.isInteger(other) && other >= 0 ? other : null,
    tier: entry.tier || null,
    timeline: timeline(entry),
  };
}

module.exports = { VENUE_TAPES, TAPES, tapeForVenue, lengthBand, homepageState, registeredYear, deriveRow };
