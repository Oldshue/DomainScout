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
// ParkLogic proves parking, not an observed seller/marketplace listing. A move
// away remains inspectable on the noise tape but cannot establish resale origin.
PROVIDER_TAPE.set('parklogic', 'noise');
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

// Registration (creation) date from one stored RDAP record: a direct field,
// or the RDAP 'registration' event rdapEvidence stores as { action, date }
// (raw { eventAction, eventDate } is accepted too). Earliest wins.
const REG_KEYS = ['registeredAt', 'createdAt', 'registrationDate', 'created', 'creationDate'];
function isoDay(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
  return m && Number.isFinite(Date.parse(`${m[1]}T00:00:00Z`)) ? m[1] : null;
}
function registeredDate(rdap) {
  if (!rdap || typeof rdap !== 'object') return null;
  const found = [];
  for (const key of REG_KEYS) { const d = isoDay(rdap[key]); if (d) found.push(d); }
  for (const e of Array.isArray(rdap.events) ? rdap.events : []) {
    if (!e || typeof e !== 'object') continue;
    const action = String(e.action || e.eventAction || '').toLowerCase().replace(/[^a-z]/g, '');
    if (action !== 'registration') continue;
    const d = isoDay(e.date || e.eventDate);
    if (d) found.push(d);
  }
  return found.length ? found.sort()[0] : null;
}

/** Registration date from every stored source on an entry (no network):
 *  discovery.rdap, assessment.rdap, and each reconstruction observation's rdap. */
function entryRegisteredDate(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const sources = [(entry.discovery || {}).rdap, (entry.assessment || {}).rdap];
  const obs = entry.reconstruction && Array.isArray(entry.reconstruction.observations) ? entry.reconstruction.observations : [];
  for (const o of obs) if (o && typeof o === 'object') sources.push(o.rdap, o.evidence && o.evidence.rdap);
  const found = sources.map(registeredDate).filter(Boolean).sort();
  return found[0] || null;
}

function departureDay(entry) {
  const d = entry.discovery || {};
  for (const v of [d.departureDate, d.movement && d.movement.day, entry.reportDate]) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
    if (m) return m[1];
  }
  return null;
}

// Stored evidence of a change of control after the departure day (no network):
// a registrar transfer completed (transferAt on/after the departure) or in
// progress (pendingTransfer), or a recorded registrar/registrant change
// observed on/after the departure. Classifier labels transfer-completed and
// transfer-in-progress are themselves built from that evidence.
function transferEvidenceAfter(entry, dep = departureDay(entry)) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.classification === 'transfer-completed' || entry.classification === 'transfer-in-progress') return true;
  const d = entry.discovery || {};
  const onOrAfter = v => { const day = isoDay(v); return !!day && (!dep || day >= dep); };
  const sources = [d.transferEvidence, (entry.assessment || {}).transfer, d.rdap, (entry.assessment || {}).rdap];
  const obs = entry.reconstruction && Array.isArray(entry.reconstruction.observations) ? entry.reconstruction.observations : [];
  for (const o of obs) if (o && typeof o === 'object') sources.push(o.rdap, o.transferEvidence);
  for (const t of sources) {
    if (!t || typeof t !== 'object') continue;
    if (t.pending === true || t.pendingTransfer === true) return true;
    if (onOrAfter(t.transferAt)) return true;
    if ((t.registrarChanged === true || t.registrantChanged === true) && (!t.observedAt || onOrAfter(t.observedAt))) return true;
  }
  return false;
}

/**
 * Tape for one row (2026-11-12 owner correction: registration age is not
 * evidence of a purchase; lmwebui.com left Spaceship parking for its own site):
 *   registrar default parking -> aftermarket ONLY when the stored evidence
 *                shows a registrar transfer (completed or in progress) or a
 *                recorded registrar/registrant change after the departure;
 *                otherwise builder, whatever the registration age
 *   resale marketplace / reseller -> builder when registered <= 90 days
 *                before departure, else aftermarket (unchanged)
 *   any other venue -> builder when registered <= 90 days before departure,
 *                else noise (unchanged)
 */
function tapeForRow(entry) {
  const klass = venueClass(entry.venue, entry.sellerNameservers);
  const reg = entryRegisteredDate(entry);
  const dep = departureDay(entry);
  const ageDays = reg && dep ? Math.floor((Date.parse(`${dep}T00:00:00Z`) - Date.parse(`${reg}T00:00:00Z`)) / DAY_MS) : null;
  const out = { venueClass: klass, registeredDate: reg, registeredAgeDays: ageDays };
  if (klass === 'registrar default parking') return { ...out, tape: transferEvidenceAfter(entry, dep) ? 'aftermarket' : 'builder' };
  if (ageDays !== null && ageDays <= BUILDER_MAX_AGE_DAYS) return { ...out, tape: 'builder' };
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
  const d = registeredDate(rdap);
  return d ? Number(d.slice(0, 4)) : null;
}

// Buyer titles come from scraped <title> text and can carry HTML entities
// ("&#8211;", "&amp;"). Decode named, decimal and hex entities exactly once
// (never recursively: "&amp;lt;" becomes the text "&lt;"), then collapse
// whitespace. The result is plain text; every renderer still escapes it.
const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·',
  bull: '•', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  eacute: 'é', Eacute: 'É', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä',
  ccedil: 'ç', ntilde: 'ñ', szlig: 'ß', times: '×', euro: '€', pound: '£', deg: '°',
  AMP: '&', LT: '<', GT: '>', QUOT: '"',
});
function decodeEntities(value) {
  return String(value == null ? '' : value).replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (all, dec, hex, name) => {
    if (name) return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : all;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all;
    return String.fromCodePoint(code);
  });
}
function cleanTitle(value) {
  if (value == null) return null;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return text || null;
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

// Actionable purchase leads, from stored evidence only. These labels describe
// what was observed; they never turn a movement inference into a completed sale.
// Strongest first, or null for a low-signal candidate:
//   likely-sale                       -> by its basis (built / transfer / off-market)
//   transfer-completed                -> transfer + built site | registrar transfer
//   transfer-in-progress after leaving a resale marketplace or reseller venue
//   acquisition-candidate on the aftermarket tape with assessment.buyerUse and
//   assessment.identity.aligned (a built site matching the name), not relisted,
//   not a parking/template title, not an expiry or portfolio move.
// On the builder tape the same definition reads as 'live'.
const LEAD_REASONS = Object.freeze(['transfer + branded site', 'marketplace exit + registrar transfer', 'transfer pending', 'branded site launched', 'off market 14+ days']);
// Compatibility export for older consumers. Values now use truthful lead terms.
const SOLD_REASONS = LEAD_REASONS;
const TEMPLATE_TITLE = /\b(?:parked|for sale|buy this domain|domain (?:is )?for sale|coming soon|under construction|welcome to nginx|default (?:web )?page|index of|just another wordpress|website builder|launching soon|placeholder|this domain)\b/i;
function builtMatchingSite(entry) {
  const a = entry.assessment || {};
  return a.buyerUse === true && !!(a.identity && a.identity.aligned === true);
}
function leadReason(entry, placed = null) {
  if (!entry || typeof entry !== 'object') return null;
  const a = entry.assessment || {};
  const d = entry.discovery || {};
  const c = entry.classification;
  const built = builtMatchingSite(entry);
  // One destination taking a batch, or one brand adopting a kit, is portfolio
  // movement rather than independent end-user alpha. Keep it in history but
  // never admit it to the default lead feed, even when RDAP says transfer.
  if (Number((d.kit && d.kit.size) || 0) >= 3 || Number((d.movement && d.movement.cohortSize) || 0) >= 10) return null;
  if (c === 'likely-sale') {
    if (a.basis === 'built') return 'transfer + branded site';
    if (a.basis === 'transfer') return 'marketplace exit + registrar transfer';
    if (a.basis === 'off-market') return 'off market 14+ days';
    return built ? 'transfer + branded site' : 'marketplace exit + registrar transfer';
  }
  if (c === 'transfer-completed') return built ? 'transfer + branded site' : 'marketplace exit + registrar transfer';
  const klass = placed && placed.venueClass ? placed.venueClass : venueClass(entry.venue, entry.sellerNameservers);
  if (c === 'transfer-in-progress') return klass === 'resale marketplace or reseller' ? 'transfer pending' : null;
  if (c === 'acquisition-candidate') {
    const tape = placed && placed.tape ? placed.tape : tapeForVenue(entry.venue, entry.sellerNameservers);
    if (tape !== 'aftermarket' && tape !== 'builder') return null;
    // Reseller tape: a live buyer site is evidence of a sale only after a resale
    // marketplace or reseller listing (registrar default parking reaches this tape
    // only with transfer evidence, which the classifier reports as a transfer).
    if (tape === 'aftermarket' && klass !== 'resale marketplace or reseller') return null;
    if (!built || a.relisted === true) return null;
    const title = String((d.homepage && d.homepage.title) || entry.buyerTitle || '');
    if (TEMPLATE_TITLE.test(title)) return null;
    if (a.delegation && (a.delegation.expiration || a.delegation.parking)) return null;
    return 'branded site launched';
  }
  return null;
}

// Final host of a live site when no buyer title is stored (stored evidence only).
function buyerHost(entry) {
  if (cleanTitle(entry.buyerTitle)) return null;
  const hp = (entry.discovery || {}).homepage;
  if (homepageState(hp) !== 'live site') return null;
  for (const u of [hp && hp.finalUrl, entry.buyerUrl]) {
    try { const h = new URL(String(u || '')).hostname.toLowerCase().replace(/^www\./, ''); if (h) return h; } catch (_) { /* not a URL */ }
  }
  return null;
}

// Words inside a name's label (2026-11-12 production correction: the old
// complete-coverage segmenter shredded invented and compound names into
// two-letter dictionary fragments: "behaviour al", "ev es", "gi na").
// A name is made of words only when its WHOLE label segments into at most
// MAX_NAME_WORDS dictionary words of at least MIN_WORD_LEN letters each,
// preferring the fewest and then the longest words (behavioural is one word,
// clinicaltrials is clinical + trials). One trailing digit group and one
// known short affix (NAME_AFFIXES, as its own token at the start or end) are
// allowed. Hyphens are hard word boundaries. Anything else is invented and
// contributes no words. Stop words never appear as words.
// Vocabulary: the shipped everyday list (common-english.txt) for every
// length, the large spelling list (english-words.txt) only for words of
// BIG_DICT_MIN_LEN+ letters (its 3-4 letter entries are residue: tor, vai,
// gree), plus plain inflections (s/es/ed/ing) and British -our- spellings of
// accepted words. Runs where the snapshot is built (the Sale Watch read lane
// child), never on the request path.
const NAME_AFFIXES = Object.freeze(['ai', 'io', 'hq', 'app', 'lab', 'labs', 'hub', 'pay', 'go', 'my', 'get', 'try']);
const STOP_WORDS = Object.freeze(['the', 'to', 'in', 'for', 'of', 'and', 'a', 'an', 'on', 'is', 'it', 'if', 'my']);
const MAX_NAME_WORDS = 3;
const MIN_WORD_LEN = 3;
const BIG_DICT_MIN_LEN = 5;
let _nameVocab = null;
function nameVocabulary() {
  if (_nameVocab) return _nameVocab;
  const fs = require('fs');
  const path = require('path');
  const read = (file, min) => {
    const out = new Set();
    try {
      for (const raw of fs.readFileSync(path.join(__dirname, 'assets', file), 'utf8').split(/\s+/)) {
        const w = raw.trim().toLowerCase();
        if (w.length >= min && /^[a-z]+$/.test(w)) out.add(w);
      }
    } catch (_) { /* vocabulary unavailable: every name reads as invented */ }
    return out;
  };
  _nameVocab = { common: read('common-english.txt', MIN_WORD_LEN), big: read('english-words.txt', BIG_DICT_MIN_LEN) };
  return _nameVocab;
}
function knownWord(w, vocab) { return w.length >= MIN_WORD_LEN && (vocab.common.has(w) || (w.length >= BIG_DICT_MIN_LEN && vocab.big.has(w))); }
// 'exact' (a listed word or its British -our- spelling), 'inflected' (a plain
// inflection of one) or false.
function isNameWord(w, vocab = nameVocabulary()) {
  if (w.length < MIN_WORD_LEN) return false;
  if (knownWord(w, vocab)) return 'exact';
  if (w.includes('our') && knownWord(w.replace(/our/g, 'or'), vocab)) return 'exact';
  for (const suf of ['s', 'es', 'ed', 'ing']) {
    if (!w.endsWith(suf)) continue;
    const base = w.slice(0, -suf.length);
    if (base.length < MIN_WORD_LEN) continue;
    if (knownWord(base, vocab) || ((suf === 'ed' || suf === 'ing') && knownWord(`${base}e`, vocab))) return 'inflected';
    if (base.includes('our') && knownWord(base.replace(/our/g, 'or'), vocab)) return 'inflected';
  }
  return false;
}
// Every split of s into at most MAX_NAME_WORDS words (O(n^2) for n <= 63),
// ranked: fewest words, then fewest inflected words, then the longest
// shortest word (second + sons over seconds + ons), then longest words (sum
// of squared lengths). A word never crosses a hyphen: cuts holds the index
// of the last letter before each hyphen, and a word may end there but not
// continue past it. null when the whole string does not segment.
function nameSegmentRank(words, kinds) {
  return [words.length, kinds.filter(k => k === 'inflected').length, -Math.min(...words.map(w => w.length)), -words.reduce((s, w) => s + w.length * w.length, 0)];
}
function betterRank(a, b) { for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i]; return false; }
function segmentNameWords(s, cuts = new Set(), vocab = nameVocabulary()) {
  const n = s.length;
  if (!n) return null;
  const memo = new Map();
  const word = (i, j) => {
    const k = `${i}:${j}`;
    if (memo.has(k)) return memo.get(k);
    let v = j - i >= MIN_WORD_LEN && isNameWord(s.slice(i, j), vocab);
    if (v) for (const c of cuts) if (c >= i && c < j - 1) { v = false; break; }
    memo.set(k, v);
    return v;
  };
  let best = null;
  const consider = (bounds) => {
    const words = []; const kinds = [];
    for (let x = 0; x < bounds.length - 1; x += 1) { const kind = word(bounds[x], bounds[x + 1]); if (!kind) return; words.push(s.slice(bounds[x], bounds[x + 1])); kinds.push(kind); }
    const rank = nameSegmentRank(words, kinds);
    if (!best || betterRank(rank, best.rank)) best = { words, rank };
  };
  consider([0, n]);
  if (MAX_NAME_WORDS >= 2) for (let a = MIN_WORD_LEN; a <= n - MIN_WORD_LEN; a += 1) consider([0, a, n]);
  if (MAX_NAME_WORDS >= 3) for (let a = MIN_WORD_LEN; a <= n - 2 * MIN_WORD_LEN; a += 1) {
    if (!word(0, a)) continue;
    for (let b = a + MIN_WORD_LEN; b <= n - MIN_WORD_LEN; b += 1) consider([0, a, b, n]);
  }
  return best ? best.words : null;
}
function nameWords(domain) {
  const label = String(domain || '').toLowerCase().split('.')[0] || '';
  const vocab = nameVocabulary();
  let rest = label;
  let digits = null;
  const tail = label.match(/^(.*?[a-z].*?)-?(\d+)$/);
  if (tail) { rest = tail[1]; digits = tail[2]; }
  rest = rest.replace(/^-+|-+$/g, '');
  const invented = (affix = null) => ({ words: [], wordPairs: [], invented: true, affix, digits, segments: [] });
  if (!rest || !/^[a-z-]+$/.test(rest)) return invented();
  const letters = rest.replace(/-/g, '');
  const cuts = new Set();
  { let at = 0; for (const ch of rest) { if (ch === '-') cuts.add(at - 1); else at += 1; } }
  // cuts holds the index of the last letter before each hyphen.
  const shift = (k) => new Set([...cuts].map(c => c - k).filter(c => c >= 0));
  const options = [{ affix: null, at: null, core: letters, cuts }];
  for (const a of NAME_AFFIXES) {
    if (letters.length <= a.length) continue;
    if (letters.startsWith(a) && (a.length === 1 || ![...cuts].some(c => c < a.length - 1))) options.push({ affix: a, at: 'start', core: letters.slice(a.length), cuts: shift(a.length) });
    if (letters.endsWith(a) && ![...cuts].some(c => c > letters.length - a.length - 1 && c < letters.length - 1)) options.push({ affix: a, at: 'end', core: letters.slice(0, -a.length), cuts: new Set([...cuts].filter(c => c < letters.length - a.length - 1)) });
  }
  let pick = null;
  for (const o of options) {
    const seg = segmentNameWords(o.core, o.cuts, vocab);
    if (!seg) continue;
    const tokens = seg.length + (o.affix ? 1 : 0);
    const score = seg.reduce((s, w) => s + w.length * w.length, 0);
    if (!pick || tokens < pick.tokens || (tokens === pick.tokens && !o.affix && pick.affix) || (tokens === pick.tokens && !!o.affix === !!pick.affix && score > pick.score)) pick = { ...o, seg, tokens, score };
  }
  if (!pick) {
    // Invented: still record a known affix at the start or end (nevoxai).
    const a = NAME_AFFIXES.find(x => letters.length >= x.length + 2 && (letters.endsWith(x) || letters.startsWith(x)));
    return invented(a || null);
  }
  const seq = pick.seg.filter(w => !STOP_WORDS.includes(w));
  if (!seq.length) return invented(pick.affix);
  const segments = [...(pick.at === 'start' ? [pick.affix] : []), ...pick.seg, ...(pick.at === 'end' ? [pick.affix] : []), ...(digits ? [digits] : [])];
  const pairs = [];
  for (let i = 0; i < seq.length - 1; i += 1) pairs.push(`${seq[i]} ${seq[i + 1]}`);
  return { words: [...new Set(seq)], wordPairs: [...new Set(pairs)], invented: false, affix: pick.affix, digits, segments };
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
  const placed = tapeForRow(entry);
  const year = placed.registeredDate ? Number(placed.registeredDate.slice(0, 4)) : null;
  const otherCount = ext && typeof ext === "object" && ext.verified === true && Number.isInteger(ext.count) && ext.count >= 0 ? ext.count : null;
  const why = leadReason(entry, placed);
  const likelyPurchase = entry.classification === 'likely-sale';
  return {
    tape: placed.tape,
    venueKnown: !!vrow,
    venueClass: placed.venueClass,
    registeredDate: placed.registeredDate,
    classification: entry.classification || null,
    // Likely-sale tier: the stored classification says likely-sale.
    probablySold: entry.classification === 'likely-sale',
    // A lead is not a confirmed sale. `sold*` remains as a narrow compatibility
    // field and is true only for the classifier's likely-sale inference.
    lead: why != null,
    leadReason: why,
    sold: likelyPurchase,
    soldReason: likelyPurchase ? why : null,
    venue: entry.venue || null,
    buyerTitle: cleanTitle(entry.buyerTitle),
    // Live site with no stored title: the final host is the buyer link text.
    buyerHost: buyerHost(entry),
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

module.exports = { decodeEntities, cleanTitle, buyerHost, LEAD_REASONS, SOLD_REASONS, leadReason, soldReason: leadReason, VENUE_TAPES, TAPES, HOMEPAGE_STATES, VENUE_CLASSES, REGISTRAR_DEFAULT_PARKING, BUILDER_MAX_AGE_DAYS, venueRow, tapeForVenue, venueClass, registeredDate, entryRegisteredDate, departureDay, tapeForRow, transferEvidenceAfter, registeredYearBand, otherExtensionsBand, lengthBand, homepageState, registeredYear, deriveRow, nameWords };
