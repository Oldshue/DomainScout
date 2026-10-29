'use strict';

/**
 * Sale Watch buyer-meaningful search.
 *
 * A Sale Watch query must match only what a buyer means by a name: the domain,
 * its label split into words, and what the probe saw on the site (title,
 * description, headline/brand text and the short text sample it stored). It
 * must never match JSON keys, classifier reasons, counterEvidence, nameserver
 * hostnames or registrar names -- the old instr(lower(evidence_json), q)
 * matched "inference" inside "Expiration/deletion evidence contradicts a
 * purchase inference" on every expiry-flavoured row.
 *
 * Each row's search document is computed ONCE, on the writable handle (ingest,
 * probe waves, reassessment, and the version-gated boot backfill), and
 * persisted as:
 *   - sale_watch_candidates.search_text  readable summary
 *     ("name: ... | site: ... | theme: ai(llm gpu)")
 *   - sale_watch_search_docs + the FTS5 index sale_watch_search over its
 *     name/site/theme columns, so a q filter is an index lookup and never
 *     touches evidence_json.
 * Readers (the read-only worker) only SELECT from these tables.
 *
 * Theme tags reuse the semantic families in server/movement-report-semantics.js
 * (themeMatches/themesForTerm). When q names a family member, every row tagged
 * with that family matches. matchedOn is 'name' | 'site' | 'theme'.
 *
 * Precision rules (v5):
 *   - name matches use label segments from the existing segmenter, plus plain
 *     inflections (compute -> computes/computing), never a longer different
 *     word (computer, computers);
 *   - theme matches require a non-weak name (assessNameAlpha), so random /
 *     hash-like kit labels never theme-match;
 *   - short members (tpu, gpu, llm) only count as whole segments, never split
 *     out of a longer word (tpusa, tpuss);
 *   - rows whose stored assessment is spam/adult/gambling (purpose.kind
 *     'spam', contentQuality 'spam', or an adult/gambling name segment) match
 *     only by name, never by site or theme.
 * resultRank orders a result: buyer-built on-theme sites, then alpha names,
 * then the rest, kit/batch rows last; name > site > theme within each tier.
 */

const fs = require('node:fs');
const path = require('node:path');
const { namingProfile, THEME_WORDS, themeMatches, themesForTerm, subthemeQualifies } = require('./movement-report-semantics');
const { loadDictionary, classifyTermSignal } = require('./domainlab');
const { assessNameAlpha } = require('./domain-quality');
const { nsSetKey, isExpiryDestination } = require('./nameserver-classes');

// v2: documents also carry the narrow census facts the candidate tape needs
// (departure day, destination key, expiry origin, site class, buyer use), so a
// window census never re-parses evidence_json for indexed rows.
// v3: report_day falls back to exit_observed_day (DEPARTURE_DATE_SQL), and the
// census is served from covering indexes over these narrow columns.
// v4: theme tags carry sub-themes (q=inference expands to AI inference/compute
// only, not every ai-tagged row), and site-derived theme tags come from the
// page title/description words only, never the long text sample.
// v5: segment-bounded name words (compute never matches computer), theme tags
// only for non-weak names, short members only as whole segments, spam/adult/
// gambling rows carry no site/theme words, and documents record kit rows.
// v6: a sub-theme is tagged only when one of its own strong members is in the
// document (serving/tokens/compute/accelerator never tag AI inference alone).
const SEARCH_VERSION = 'sale-watch-search/v6';
const DOCS_TABLE = 'sale_watch_search_docs';
const FTS_TABLE = 'sale_watch_search';
const MAX_SITE_CHARS = 1200;
const MAX_SITE_WORDS = 200;
const MAX_TERM_LEN = 40;
// Query terms this short (ai, ml, gpu) match only whole tokens: a label
// segment or a standalone site word, never a substring of another word.
const SHORT_TERM_MAX = 3;
const MATCH_RANK = Object.freeze({ name: 0, site: 1, theme: 2 });
// Bulk indexing writes at most this many rows per transaction, so the main
// writer (probe waves, ingest) never waits behind the indexer for more than a
// few hundred milliseconds.
const DEFAULT_BATCH = 200;
// sale_watch_meta row the indexer heartbeats while it runs (read by coverage).
const INDEXER_META_KEY = 'search_indexer';
const INDEXER_STALE_MS = 120000;

function words(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(word => word.length >= 2 && word.length <= MAX_TERM_LEN);
}

function unique(list) {
  return [...new Set(list)];
}

// Whole words plus adjacent-word joins ("model serving" -> "modelserving").
function withJoins(list) {
  const out = new Set(list);
  for (let index = 0; index < list.length - 1; index += 1) out.add(`${list[index]}${list[index + 1]}`);
  return out;
}

let vocabulary = null;
function knownWord(word) {
  if (!vocabulary) {
    // Lazy: the theme-source adapter requires sale-watch-candidates, which requires this module.
    const { SALE_TAPE_VOCABULARY } = require('./sale-watch-candidate-theme-source');
    vocabulary = new Set([...SALE_TAPE_VOCABULARY, ...THEME_WORDS]);
  }
  return vocabulary.has(word) || loadDictionary().has(word);
}

// An unresolved segment such as "llmhub" is a family member glued to a known
// word. Split it only when BOTH halves are recognized, longest member first.
const AFFIX_WORDS = THEME_WORDS.filter(word => word.length >= 3).sort((a, b) => b.length - a.length);
function splitThemeAffix(text) {
  if (!/^[a-z]{5,}$/.test(text)) return null;
  for (const word of AFFIX_WORDS) {
    if (text.length - word.length < 2) continue;
    if (text.startsWith(word)) {
      const rest = text.slice(word.length);
      if (knownWord(rest) && shortAffixAllowed(word, rest, 'tail')) return [word, rest];
    }
    if (text.endsWith(word)) {
      const rest = text.slice(0, -word.length);
      if (knownWord(rest) && shortAffixAllowed(word, rest, 'head')) return [rest, word];
    }
  }
  return null;
}

let commonWords = null;
function commonWord(word) {
  if (!commonWords) {
    try {
      commonWords = new Set(fs.readFileSync(path.join(__dirname, 'assets', 'common-english.txt'), 'utf8').trim().split(/\s+/));
    } catch (_) {
      commonWords = new Set();
    }
  }
  return commonWords.has(word);
}

// A short member (tpu, gpu, llm) split off an unresolved segment counts only
// when the residue is a pronounceable word and no common word swallows the
// whole residue plus letters of the member: "tpusa" reads tp+usa and "tpuss"
// leaves the unpronounceable "ss", so neither carries tpu; lallm (la+llm),
// gpuvast (gpu+vast) and llmhub (llm+hub) still split.
function shortAffixAllowed(member, rest, side) {
  if (member.length > SHORT_TERM_MAX) return true;
  if (!/[aeiouy]/.test(rest)) return false;
  for (let k = 1; k < member.length; k += 1) {
    const crossing = side === 'tail' ? `${member.slice(-k)}${rest}` : `${rest}${member.slice(0, k)}`;
    if (commonWord(crossing)) return false;
  }
  return true;
}

function nameTerms(domain) {
  const canonical = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  const label = canonical.split('.')[0] || '';
  const terms = [];
  const push = term => {
    if (term && term.length >= 2 && term.length <= 63 && !terms.includes(term)) terms.push(term);
  };
  push(label);
  for (const part of label.split(/[^a-z0-9]+/)) push(part);
  let components = [];
  try { components = namingProfile(canonical).components || []; } catch (_) { components = []; }
  const segments = [];
  for (const component of components) {
    if (component.kind === 'unresolved-language' || component.kind === 'number') continue;
    const text = String(component.text || '').toLowerCase();
    const split = component.kind === 'unresolved' ? splitThemeAffix(text) : null;
    // Single letters (the "g" of g89pu140bt) are never segments: joining them
    // to a neighbour manufactured gpu/llm/tpu out of random kit labels.
    for (const word of split || [text]) if (/^[a-z0-9]+$/.test(word) && word.length >= 2) segments.push(word);
  }
  for (const segment of segments) push(segment);
  return { terms, segments };
}

// What the probe saw on the site. A failed homepage probe contributes nothing.
function siteText(evidence) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {};
  const homepage = (ev.discovery && ev.discovery.homepage) || {};
  const parts = homepage.error ? [] : [homepage.title, homepage.description, homepage.brandText, homepage.textSample];
  parts.push(ev.buyerTitle);
  return parts.filter(value => typeof value === 'string' && value.trim()).join(' ').slice(0, MAX_SITE_CHARS);
}

// The site's headline (title, description, buyer-facing title). Theme tags
// from the site come only from these words, never from long page text.
function siteHeadline(evidence) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {};
  const homepage = (ev.discovery && ev.discovery.homepage) || {};
  const parts = homepage.error ? [] : [homepage.title, homepage.description];
  parts.push(ev.buyerTitle);
  return parts.filter(value => typeof value === 'string' && value.trim()).join(' ').slice(0, MAX_SITE_CHARS);
}

/**
 * Pure: whether q names this domain. A domain or label equal to q matches
 * outright; otherwise q (longer than SHORT_TERM_MAX letters) must occur in the
 * domain AND every query word must be a label segment from the segmenter, or a
 * plain inflection of one: compute matches pilotcompute, never computerdealz
 * or oaklandcomputerrepair. A short term ("ai") must match a whole label
 * segment through the name terms instead (never prezzi/chair).
 */
function domainSubstringMatch(domain, q) {
  const raw = String(q || '').trim().toLowerCase();
  if (raw.replace(/[^a-z0-9]/g, '').length <= SHORT_TERM_MAX) return false;
  const canonical = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!canonical.includes(raw)) return false;
  if (canonical === raw || canonical.split('.')[0] === raw) return true;
  const forms = queryForms(queryWords(raw));
  if (!forms.length) return false;
  const { terms } = nameTerms(canonical);
  return forms.every(set => terms.some(term => set.has(term)));
}

// Theme matches need a name worth buying: assessNameAlpha 'alpha' or
// 'standard', never 'weak' (digits, hyphens, junk length, zero-signal tld).
function themeNameQualifies(domain) {
  try {
    return assessNameAlpha(String(domain || '').trim().toLowerCase().replace(/\.$/, '')).tier !== 'weak';
  } catch (_) {
    return false;
  }
}

// A label segment that IS an adult/gambling lexicon word (or an inflection of
// one: casino(s), betting, porn) -- never a longer word containing it
// (better, sussex). Reuses domainlab's existing classifier lexicon.
function lexiconSegment(segment) {
  const hit = classifyTermSignal(segment).lexiconHit;
  return !!hit && inflectionsOf(hit).has(segment);
}

// Stored assessment says spam/adult/gambling: the probe's purpose classifier
// (purpose.kind 'spam'), the adjudicated contentQuality, or the name itself.
function contentJunk(evidence, segments) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {};
  const homepage = (ev.discovery && ev.discovery.homepage) || {};
  const purposes = [homepage.purpose, ev.purpose].filter(value => value && typeof value === 'object');
  if (purposes.some(purpose => purpose.kind === 'spam' || purpose.spam === true)) return true;
  if (ev.assessment && typeof ev.assessment === 'object' && ev.assessment.contentQuality === 'spam') return true;
  return (segments || []).some(lexiconSegment);
}

// A title kit (one operator adopting 3+ names) or an adjudicated portfolio kit.
function kitRow(evidence) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {};
  const discovery = ev.discovery && typeof ev.discovery === 'object' ? ev.discovery : {};
  if (Number((discovery.kit && discovery.kit.size) || 0) >= 3) return true;
  const classification = ev.classification || (ev.assessment && ev.assessment.classification);
  return classification === 'portfolio-kit';
}

/**
 * Pure: the buyer-meaningful search document for one row. `evidence` is the
 * stored evidence object (or a ledger entry of the same shape).
 */
function buildSearchDocument(domain, evidence) {
  const { terms, segments } = nameTerms(domain);
  const junk = contentJunk(evidence, segments.length ? segments : terms);
  const themeEligible = !junk && themeNameQualifies(domain);
  const siteWords = junk ? [] : unique(words(siteText(evidence))).slice(0, MAX_SITE_WORDS);
  const headlineWords = junk ? [] : unique(words(siteHeadline(evidence))).slice(0, MAX_SITE_WORDS);
  const byId = new Map();
  if (themeEligible) {
    for (const match of [...themeMatches(withJoins(segments.length ? segments : terms)), ...themeMatches(withJoins(headlineWords))]) {
      byId.set(match.id, unique([...(byId.get(match.id) || []), ...match.terms]));
    }
  }
  const themeTerms = Object.fromEntries(byId);
  const themeIds = [...byId.keys()];
  const name = terms.join(' ');
  const site = siteWords.join(' ');
  const theme = themeIds.join(' ');
  const searchText = [
    `name: ${name}`,
    `site: ${site}`,
    `theme: ${themeIds.map(id => `${id}(${byId.get(id).join(' ')})`).join(' ')}`,
  ].join(' | ');
  return { name, site, theme, themeTerms, searchText, kit: kitRow(evidence) ? 1 : 0, junk };
}

/**
 * Pure: the narrow, window-census facts of one row, derived exactly the way
 * server/sale-watch-candidates.js derives them in SQL from evidence_json
 * (DEPARTURE_DATE_SQL's reportDate, DESTINATION_JSON_SQL, SITE_CLASS_SQL,
 * buyerUse) plus the expiry-origin test (nameserver-classes isExpiryDestination
 * over the seller nameservers). No new classification.
 */
function censusFacts(evidence) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {};
  const discovery = ev.discovery && typeof ev.discovery === 'object' ? ev.discovery : {};
  const movement = discovery.movement && typeof discovery.movement === 'object' ? discovery.movement : {};
  const homepage = discovery.homepage && typeof discovery.homepage === 'object' ? discovery.homepage : {};
  const destination = Array.isArray(movement.currentNameservers)
    ? movement.currentNameservers
    : (Array.isArray(ev.buyerNameservers) ? ev.buyerNameservers : []);
  const seller = Array.isArray(ev.sellerNameservers) ? ev.sellerNameservers : [];
  const sellerKey = nsSetKey(seller);
  const flag = value => value === true || value === 1;
  let siteClass = null;
  if (homepage.error !== undefined && homepage.error !== null) siteClass = null;
  else if (flag(homepage.parked)) siteClass = 'parked';
  else if (flag(homepage.placeholder)) siteClass = 'placeholder';
  else if (flag(homepage.active)) siteClass = 'built';
  else if (homepage.status !== undefined && homepage.status !== null) siteClass = 'inactive';
  const buyerUse = discovery.buyerUse;
  return {
    reportDay: typeof ev.reportDate === 'string' ? ev.reportDate : (ev.reportDate ? String(ev.reportDate) : ''),
    destinationKey: nsSetKey(destination) || '',
    expiryOrigin: sellerKey && isExpiryDestination(seller).isExpiry === true ? 1 : 0,
    siteClass,
    buyerUse: (buyerUse === true || buyerUse === 1 || buyerUse === '1' || buyerUse === 'true') ? 1 : 0,
  };
}

function queryWords(q) {
  return unique(words(q));
}

// The plain inflections of a query word: compute -> computes, computed,
// computing; agent -> agents; bet -> betting. Never a different, longer word
// (computer, inference for infer, graphics for graph).
function inflectionsOf(word) {
  const forms = new Set([word, `${word}s`, `${word}es`, `${word}ed`, `${word}ing`]);
  if (word.endsWith('e')) {
    forms.add(`${word}d`);
    forms.add(`${word.slice(0, -1)}ing`);
  }
  if (/[^aeiou]y$/.test(word)) {
    forms.add(`${word.slice(0, -1)}ies`);
    forms.add(`${word.slice(0, -1)}ied`);
  }
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(word)) {
    const last = word.slice(-1);
    forms.add(`${word}${last}ing`);
    forms.add(`${word}${last}ed`);
  }
  return forms;
}

// Per query word, the set of whole terms it matches. Short words ("ai")
// match only themselves, never aid/air/aim.
function queryForms(wanted) {
  return wanted.map(word => (word.length <= SHORT_TERM_MAX ? new Set([word]) : inflectionsOf(word)));
}

function firstThemeTerm(themeTerms, families) {
  for (const family of families) {
    const terms = themeTerms && themeTerms[family];
    if (Array.isArray(terms) && terms.length) return terms[0];
  }
  return families[0] || null;
}

const splitList = value => String(value || '').split(' ').filter(Boolean);

// The per-theme matched terms of a document: an object (in-memory documents)
// or the stored theme_terms JSON (SQL rows). null when unknown.
function themeTermsOf(doc) {
  const raw = doc && doc.themeTerms;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw) {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : null; } catch (_) { return null; }
  }
  return null;
}

/**
 * Pure: the shared verdict for one document (in-memory ledger rows and the
 * SQL candidates read both use it). { matchedOn, onTheme, hit } or null.
 * A theme match additionally re-checks name quality, so documents built by
 * an older SEARCH_VERSION obey the quality gate before they are re-rendered.
 */
function evaluateMatch(doc, compiled, domain = '') {
  if (!compiled || !compiled.q) return null;
  const forms = compiled.forms || [];
  const all = list => forms.length > 0 && forms.every(set => list.some(term => set.has(term)));
  const nameList = splitList(doc.name);
  const siteList = splitList(doc.site);
  const tagged = new Set(splitList(doc.theme));
  // Strong-term rule at match time too: a document built before v6 that was
  // tagged aiinference from weak terms alone (serving, tokens) never matches.
  const termsById = themeTermsOf(doc);
  const hit = (compiled.families || []).filter(family => tagged.has(family)
    && (!termsById || subthemeQualifies(family, termsById[family])));
  if (all(nameList) || domainSubstringMatch(domain, compiled.q)) return { matchedOn: 'name', onTheme: hit.length > 0 || all(siteList), hit };
  if (all(siteList)) return { matchedOn: 'site', onTheme: true, hit };
  if (hit.length && (!domain || themeNameQualifies(domain))) return { matchedOn: 'theme', onTheme: true, hit };
  return null;
}

/**
 * Pure: why (if at all) a search document matches q. Used for in-memory
 * ledger rows; the SQL path (searchCandidates) applies the same rules.
 */
function matchDocument(doc, q, domain = '') {
  const compiled = compileSearch(q);
  const match = evaluateMatch(doc, compiled, domain);
  if (!match) return null;
  if (match.matchedOn !== 'theme') return { matchedOn: match.matchedOn, matchedTerm: compiled.q };
  return { matchedOn: 'theme', matchedTerm: firstThemeTerm(doc.themeTerms, match.hit), theme: match.hit[0] };
}

/**
 * Pure: the sort rank of a q result (lower first; encoded in the cursor).
 * Tier 0 buyer-built site on the query's theme, 1 alpha-quality name, 2 the
 * rest, 3 kit/batch rows; within a tier name, then site, then theme.
 * `built` and `batch` come from the caller's census row.
 */
function resultRank(match, { domain = '', built = false, batch = false } = {}) {
  if (!match) return 0;
  const kind = MATCH_RANK[match.matchedOn] ?? MATCH_RANK.theme;
  let tier = 2;
  if (batch || match.kit) tier = 3;
  else if (built && match.onTheme) tier = 0;
  else if (assessNameAlpha(String(domain || '').toLowerCase()).tier === 'alpha') tier = 1;
  return tier * 3 + kind;
}

// ── schema + writes (writable handle only) ─────────────────────────────────

function ensureSearchSchema(db) {
  const columns = db.prepare('PRAGMA table_info(sale_watch_candidates)').all();
  if (!columns.some(column => column.name === 'search_text')) {
    db.exec('ALTER TABLE sale_watch_candidates ADD COLUMN search_text TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sale_watch_search_missing
      ON sale_watch_candidates (exit_observed_day) WHERE search_text IS NULL AND evidence_json IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sale_watch_search_unindexed
      ON sale_watch_candidates (exit_observed_day) WHERE search_text IS NULL;
    CREATE TABLE IF NOT EXISTS ${DOCS_TABLE} (
      id INTEGER PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      name TEXT, site TEXT, theme TEXT, theme_terms TEXT,
      report_day TEXT, destination_key TEXT, expiry_origin INTEGER, site_class TEXT, buyer_use INTEGER, kit INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      name, site, theme, content='${DOCS_TABLE}', content_rowid='id', tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS ${DOCS_TABLE}_ai AFTER INSERT ON ${DOCS_TABLE} BEGIN
      INSERT INTO ${FTS_TABLE}(rowid, name, site, theme) VALUES (new.id, new.name, new.site, new.theme);
    END;
    CREATE TRIGGER IF NOT EXISTS ${DOCS_TABLE}_ad AFTER DELETE ON ${DOCS_TABLE} BEGIN
      INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, name, site, theme) VALUES ('delete', old.id, old.name, old.site, old.theme);
    END;
    CREATE TRIGGER IF NOT EXISTS ${DOCS_TABLE}_au AFTER UPDATE ON ${DOCS_TABLE} BEGIN
      INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, name, site, theme) VALUES ('delete', old.id, old.name, old.site, old.theme);
      INSERT INTO ${FTS_TABLE}(rowid, name, site, theme) VALUES (new.id, new.name, new.site, new.theme);
    END;
    CREATE TABLE IF NOT EXISTS sale_watch_meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const docColumns = db.prepare(`PRAGMA table_info(${DOCS_TABLE})`).all().map(column => column.name);
  // search_version: the SEARCH_VERSION each row's document was built with.
  // A version bump re-renders rows in place; readers keep using whatever
  // document a row has until it is replaced.
  for (const [name, type] of [['report_day', 'TEXT'], ['destination_key', 'TEXT'], ['expiry_origin', 'INTEGER'], ['site_class', 'TEXT'], ['buyer_use', 'INTEGER'], ['search_version', 'TEXT'], ['kit', 'INTEGER']]) {
    if (!docColumns.includes(name)) db.exec(`ALTER TABLE ${DOCS_TABLE} ADD COLUMN ${name} ${type}`);
  }
  // Covering indexes for the window census: the docs side by departure day,
  // the candidate side by domain, partial on indexed rows, so the census
  // never reads the evidence_json overflow pages.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sale_watch_search_docs_census
      ON ${DOCS_TABLE} (report_day, domain, destination_key, expiry_origin, site_class, buyer_use);
    CREATE INDEX IF NOT EXISTS idx_sale_watch_search_docs_version
      ON ${DOCS_TABLE} (search_version, report_day);
    CREATE INDEX IF NOT EXISTS idx_sale_watch_candidates_census
      ON sale_watch_candidates (domain, state, outcome, probe_count)
      WHERE evidence_json IS NOT NULL AND search_text IS NOT NULL;
  `);
  // Per-day destination-set census, trigger-maintained on this handle.
  require('./sale-watch-candidates').ensureDestinationDaySchema(db);
}

const writeStatements = new WeakMap();
function statementsFor(db) {
  let statements = writeStatements.get(db);
  if (!statements) {
    statements = {
      setText: db.prepare('UPDATE sale_watch_candidates SET search_text = ? WHERE domain = ?'),
      upsertDoc: db.prepare(`INSERT INTO ${DOCS_TABLE} (domain, name, site, theme, theme_terms, report_day, destination_key, expiry_origin, site_class, buyer_use, search_version, kit)
        VALUES (@domain, @name, @site, @theme, @themeTerms,
          COALESCE(NULLIF(@reportDay, ''), (SELECT exit_observed_day FROM sale_watch_candidates WHERE domain = @domain), ''),
          @destinationKey, @expiryOrigin, @siteClass, @buyerUse, @version, @kit)
        ON CONFLICT(domain) DO UPDATE SET name = excluded.name, site = excluded.site, theme = excluded.theme, theme_terms = excluded.theme_terms,
          report_day = excluded.report_day, destination_key = excluded.destination_key, expiry_origin = excluded.expiry_origin,
          site_class = excluded.site_class, buyer_use = excluded.buyer_use, search_version = excluded.search_version, kit = excluded.kit`),
    };
    writeStatements.set(db, statements);
  }
  return statements;
}

function parseEvidence(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

/** Writes one row's search document. Writable handle only. */
function writeSearchDocument(db, domain, evidence) {
  // Search indexing must never fail the evidence write it follows (e.g. a
  // handle whose schema predates the search tables): log and continue.
  try {
    const parsed = parseEvidence(evidence) || {};
    const doc = buildSearchDocument(domain, parsed);
    const facts = censusFacts(parsed);
    const statements = statementsFor(db);
    statements.upsertDoc.run({ domain, name: doc.name, site: doc.site, theme: doc.theme, themeTerms: JSON.stringify(doc.themeTerms), ...facts, version: SEARCH_VERSION, kit: doc.kit });
    // search_text last: a non-NULL search_text always has a current document.
    statements.setText.run(doc.searchText, domain);
    return doc;
  } catch (error) {
    if (!writeSearchDocument.warned) {
      writeSearchDocument.warned = true;
      console.warn(`[SaleWatchSearch] search document write failed: ${error.message}`);
    }
    return null;
  }
}

function dayMinus(day, days) {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

// Search indexing is cooperative: better-sqlite3 is synchronous, so every
// multi-page path writes one `batch`-row transaction and then yields to the
// event loop, keeping HTTP requests on the same process responsive.
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

const DAY_SENTINEL = '￿';

/**
 * Indexes rows whose search_text is still NULL (new inserts from any intake
 * path, or rows whose evidence ingest replaced), newest exit_observed_day
 * first. Every row is indexed: a row with no probe evidence yet (evidence_json
 * NULL, e.g. a fresh departure) gets a name-only document (name terms + theme
 * tags from the domain alone); the probe write replaces it with the full
 * document when evidence arrives. Writes `batch`-row transactions and awaits setImmediate between
 * them. `limit` caps the rows examined by this call (default: no cap);
 * `sinceDays: null` removes the day cutoff (rows with no exit day are then
 * indexed last). A keyset cursor over (exit_observed_day, rowid) means a row
 * whose write fails is skipped rather than retried forever, and no call ever
 * materializes more than one page. Writable handle only.
 */
async function indexMissingSearchDocuments(db, {
  now = new Date(), sinceDays = null, limit = Infinity, batch = DEFAULT_BATCH, onProgress = null, progressEvery = 50000, onBatch = null,
} = {}) {
  const started = Date.now();
  const today = new Date(now || Date.now()).toISOString().slice(0, 10);
  const cutoff = sinceDays === null || sinceDays === undefined ? '' : dayMinus(today, sinceDays);
  const max = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Math.floor(Number(limit)) : Infinity;
  const size = Math.max(1, Math.floor(Number(batch)) || DEFAULT_BATCH);
  const dated = db.prepare(`
    SELECT rowid AS rid, domain, evidence_json, exit_observed_day AS day FROM sale_watch_candidates
    WHERE search_text IS NULL
      AND exit_observed_day IS NOT NULL AND exit_observed_day >= @cutoff
      AND (exit_observed_day, rowid) < (@day, @rid)
    ORDER BY exit_observed_day DESC, rowid DESC LIMIT @take`);
  const undated = cutoff === '' ? db.prepare(`
    SELECT rowid AS rid, domain, evidence_json FROM sale_watch_candidates
    WHERE search_text IS NULL AND exit_observed_day IS NULL AND rowid > @rid
    ORDER BY rowid LIMIT @take`) : null;
  const write = db.transaction(chunk => {
    let ok = 0;
    for (const row of chunk) if (writeSearchDocument(db, row.domain, row.evidence_json)) ok += 1;
    if (onBatch) onBatch(db);
    return ok;
  });
  let phase = 'dated';
  let cursorDay = DAY_SENTINEL;
  let cursorRid = Number.MAX_SAFE_INTEGER;
  let undatedRid = 0;
  let examined = 0;
  let indexed = 0;
  let pages = 0;
  let exhausted = false;
  let nextProgress = progressEvery;
  while (examined < max) {
    const take = Math.min(size, max - examined);
    const rows = phase === 'dated'
      ? dated.all({ cutoff, day: cursorDay, rid: cursorRid, take })
      : undated.all({ rid: undatedRid, take });
    if (rows.length) {
      indexed += write(rows);
      examined += rows.length;
      pages += 1;
      const last = rows[rows.length - 1];
      if (phase === 'dated') { cursorDay = last.day; cursorRid = last.rid; } else undatedRid = last.rid;
    }
    if (rows.length < take) {
      if (phase === 'dated' && undated) phase = 'undated';
      else exhausted = true;
    }
    if (onProgress && progressEvery > 0 && examined >= nextProgress) {
      nextProgress = examined + progressEvery;
      try { onProgress({ indexed, examined, pages, ms: Date.now() - started }); } catch (_) { /* progress logging never fails indexing */ }
    }
    await yieldToEventLoop();
    if (exhausted) break;
  }
  return { indexed, failed: examined - indexed, examined, exhausted, pages, ms: Date.now() - started };
}

/** Indexes every still-unindexed row (any day), cooperatively. Writable handle only. */
async function indexAllMissingSearchDocuments(db, opts = {}) {
  return indexMissingSearchDocuments(db, { ...opts, sinceDays: null });
}

/**
 * Re-renders, in place, every indexed row whose document was built by an
 * older SEARCH_VERSION (newest document first). Nothing is cleared first: a
 * row keeps its old document, which readers keep using, until this pass
 * overwrites it with the current version. `batch`-row transactions; rows with
 * search_text NULL belong to indexMissingSearchDocuments. Writable handle only.
 */
async function indexStaleSearchDocuments(db, {
  limit = Infinity, batch = DEFAULT_BATCH, onProgress = null, progressEvery = 50000, onBatch = null,
} = {}) {
  const started = Date.now();
  const max = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Math.floor(Number(limit)) : Infinity;
  const size = Math.max(1, Math.floor(Number(batch)) || DEFAULT_BATCH);
  const select = db.prepare(`SELECT d.id AS id, c.domain AS domain, c.evidence_json AS evidence_json
    FROM ${DOCS_TABLE} d JOIN sale_watch_candidates c ON c.domain = d.domain
    WHERE d.id < @id AND (d.search_version IS NULL OR d.search_version <> @version) AND c.search_text IS NOT NULL
    ORDER BY d.id DESC LIMIT @take`);
  const write = db.transaction(chunk => {
    let ok = 0;
    for (const row of chunk) if (writeSearchDocument(db, row.domain, row.evidence_json)) ok += 1;
    if (onBatch) onBatch(db);
    return ok;
  });
  let cursor = Number.MAX_SAFE_INTEGER;
  let examined = 0;
  let indexed = 0;
  let pages = 0;
  let exhausted = false;
  let nextProgress = progressEvery;
  while (examined < max) {
    const take = Math.min(size, max - examined);
    const rows = select.all({ id: cursor, version: SEARCH_VERSION, take });
    if (rows.length) {
      indexed += write(rows);
      examined += rows.length;
      pages += 1;
      cursor = rows[rows.length - 1].id;
    }
    if (rows.length < take) exhausted = true;
    if (onProgress && progressEvery > 0 && examined >= nextProgress) {
      nextProgress = examined + progressEvery;
      try { onProgress({ phase: 'stale', indexed, examined, pages, ms: Date.now() - started }); } catch (_) { /* never fails indexing */ }
    }
    await yieldToEventLoop();
    if (exhausted) break;
  }
  return { indexed, failed: examined - indexed, examined, exhausted, pages, ms: Date.now() - started };
}

function storedSearchVersion(db) {
  try {
    const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get('search_version');
    return row ? row.value : null;
  } catch (_) {
    return null;
  }
}

/** Records the indexer's state/heartbeat in sale_watch_meta. Writable handle only. */
function writeIndexerStatus(db, status) {
  db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(INDEXER_META_KEY, JSON.stringify(status));
}

/**
 * The indexer's last recorded status (read-only). running is true only while
 * its heartbeat is fresh, so a dead indexer stops reporting running.
 */
function searchIndexerStatus(db, { now = Date.now() } = {}) {
  try {
    const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(INDEXER_META_KEY);
    if (!row) return { running: false };
    const status = JSON.parse(row.value) || {};
    const beat = Date.parse(status.heartbeatAt || '');
    return { ...status, running: status.state === 'running' && Number.isFinite(beat) && Number(now) - beat < INDEXER_STALE_MS };
  } catch (_) {
    return { running: false };
  }
}

/**
 * The full bulk pass (boot, version bump, post-ingest and per-wave catch-up).
 * Never clears search_text or documents: purges orphan documents, indexes rows
 * still missing a document (newest exit day first), and when the stored
 * search_version differs from SEARCH_VERSION re-renders stale rows in place,
 * recording SEARCH_VERSION once none remain. `limit` caps the rows each pass
 * writes (per-wave catch-up). Then the per-day destination census is rebuilt
 * if its version changed. All writes are `batch`-row transactions. Writable
 * handle only; production runs this in the indexer worker
 * (server/sale-watch-index-worker.js), never on the HTTP thread.
 */
async function ensureSearchIndex(db, {
  now = new Date(), sinceDays = null, limit = Infinity, batch = DEFAULT_BATCH, chunk = 2000, onProgress = null, progressEvery = 50000, onBatch = null,
  destinationDays: rebuildCensus = true,
} = {}) {
  await yieldToEventLoop();
  const started = Date.now();
  ensureSearchSchema(db);
  const rebuild = storedSearchVersion(db) !== SEARCH_VERSION;
  const step = Math.max(1, Math.floor(Number(chunk)) || 2000);
  let purged = 0;
  const topDoc = Number(db.prepare(`SELECT MAX(id) AS n FROM ${DOCS_TABLE}`).get().n || 0);
  const purge = db.prepare(`DELETE FROM ${DOCS_TABLE} WHERE id > ? AND id <= ?
    AND NOT EXISTS (SELECT 1 FROM sale_watch_candidates c WHERE c.domain = ${DOCS_TABLE}.domain)`);
  for (let low = 0; low < topDoc; low += step) {
    purged += purge.run(low, low + step).changes;
    await yieldToEventLoop();
  }
  const pass = await indexMissingSearchDocuments(db, { now, sinceDays, limit, batch, onProgress, progressEvery, onBatch });
  const staleLimit = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit) - pass.examined) : Infinity;
  const stale = rebuild
    ? await indexStaleSearchDocuments(db, { limit: staleLimit, batch, onProgress, progressEvery, onBatch })
    : { indexed: 0, failed: 0, examined: 0, exhausted: true, pages: 0 };
  const current = rebuild && sinceDays == null && pass.exhausted && stale.exhausted && stale.failed === 0;
  if (current) {
    db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES('search_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SEARCH_VERSION);
  }
  // Per-day destination census: rebuilt once per DESTINATION_DAY_VERSION,
  // one day per transaction; triggers keep it current afterwards.
  const census = require('./sale-watch-candidates');
  const destinationDays = !rebuildCensus || census.destinationDaysReady(db) ? null : await census.rebuildDestinationDays(db);
  return {
    version: SEARCH_VERSION,
    rebuilt: rebuild,
    inPlace: true,
    versionRecorded: current,
    indexed: pass.indexed,
    restamped: stale.indexed,
    failed: pass.failed + stale.failed,
    examined: pass.examined + stale.examined,
    exhausted: pass.exhausted && stale.exhausted,
    pages: pass.pages + stale.pages,
    purged,
    destinationDays,
    ms: Date.now() - started,
  };
}

const rebuilds = new WeakMap();

/**
 * Starts ensureSearchIndex as a single-flight background task on `db` and
 * returns immediately. Logs progress and duration; never throws into the
 * caller (a failure is logged and resolves to { error }).
 */
function startSearchIndexRebuild(db, { log = console, ...opts } = {}) {
  if (rebuilds.has(db)) return { background: true, started: false, running: true };
  const started = Date.now();
  let request;
  try {
    // Off the HTTP thread: the indexer worker owns the pass (one per process).
    request = require('./sale-watch-search-indexer').requestSearchIndexPass(db, { pass: 'rebuild', options: opts, log });
  } catch (error) {
    log.warn(`[SaleWatchSearch] index rebuild could not start: ${error.message}`);
    return { background: true, started: false, error: error.message };
  }
  const promise = request.promise
    .then(result => {
      if (result && result.error) log.warn(`[SaleWatchSearch] index rebuild failed after ${Date.now() - started}ms: ${result.error}`);
      return result;
    })
    .finally(() => { if (rebuilds.get(db) === promise) rebuilds.delete(db); });
  rebuilds.set(db, promise);
  return { background: true, started: true, running: true, queued: request.queued, worker: !request.inProcess };
}

/** The running background rebuild's promise for `db`, or null. */
function searchIndexRebuild(db) {
  return rebuilds.get(db) || null;
}

// ── reads (safe on a read-only handle: SELECT only) ────────────────────────

function searchIndexAvailable(db) {
  try {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('${DOCS_TABLE}', '${FTS_TABLE}')`).all().map(row => row.name);
    return names.includes(DOCS_TABLE) && names.includes(FTS_TABLE);
  } catch (_) {
    return false;
  }
}

// FTS is only a recall prefilter (prefix over the inflection stem, so
// compute -> "comput"* also finds computing); evaluateMatch then applies the
// whole-segment rule and drops computer/computers.
function ftsTerm(word) {
  if (word.length < 4) return `"${word}"`;
  const stem = /e$/.test(word) || /[^aeiou]y$/.test(word) ? word.slice(0, -1) : word;
  return `"${stem}"*`;
}

/** The FTS5 MATCH expressions q compiles to (exported for the ledger reader). */
function compileSearch(q) {
  const raw = String(q || '').trim().toLowerCase();
  const wanted = queryWords(raw);
  const families = themesForTerm(raw);
  return {
    q: raw,
    words: wanted,
    forms: queryForms(wanted),
    families,
    name: wanted.length ? wanted.map(word => `name : ${ftsTerm(word)}`).join(' AND ') : null,
    site: wanted.length ? wanted.map(word => `site : ${ftsTerm(word)}`).join(' AND ') : null,
    theme: families.length ? families.map(family => `theme : "${family}"`).join(' OR ') : null,
    any: [
      wanted.length ? `(${wanted.map(word => `{name site} : ${ftsTerm(word)}`).join(' AND ')})` : null,
      families.length ? `(${families.map(family => `theme : "${family}"`).join(' OR ')})` : null,
    ].filter(Boolean).join(' OR ') || null,
  };
}

/**
 * Map domain -> { matchedOn, matchedTerm | themeTermsJson, onTheme, kit } for
 * q from the persisted FTS index: one FTS recall query, then evaluateMatch
 * per row. Domain matches for unindexed rows are layered on by the caller.
 * Returns available:false when the index has not been created yet (the reader
 * then falls back to domain-only matching).
 */
function searchCandidates(db, q) {
  const compiled = compileSearch(q);
  const matches = new Map();
  if (!compiled.q || !searchIndexAvailable(db)) return { available: compiled.q ? searchIndexAvailable(db) : true, matches, families: compiled.families };
  if (!compiled.any) return { available: true, matches, families: compiled.families };
  const select = db.prepare(`SELECT d.domain AS domain, d.name AS name, d.site AS site, d.theme AS theme,
      d.theme_terms AS themeTerms, ${docsHaveKit(db) ? 'd.kit' : 'NULL'} AS kit
    FROM ${FTS_TABLE} s JOIN ${DOCS_TABLE} d ON d.id = s.rowid WHERE ${FTS_TABLE} MATCH ?`);
  for (const row of select.iterate(compiled.any)) {
    const match = evaluateMatch(row, compiled, row.domain);
    if (!match) continue;
    matches.set(row.domain, {
      matchedOn: match.matchedOn,
      ...(match.matchedOn === 'theme' ? { themeTermsJson: row.themeTerms } : { matchedTerm: compiled.q }),
      onTheme: match.onTheme,
      kit: Number(row.kit) === 1,
    });
  }
  return { available: true, matches, families: compiled.families };
}

// Readers may open a store whose documents predate the kit column; select
// NULL then (re-checked until the writer has added it).
const kitColumn = new WeakSet();
function docsHaveKit(db) {
  if (kitColumn.has(db)) return true;
  try {
    if (db.prepare(`PRAGMA table_info(${DOCS_TABLE})`).all().some(column => column.name === 'kit')) {
      kitColumn.add(db);
      return true;
    }
  } catch (_) { /* fall through */ }
  return false;
}

/** Resolves the theme term for a 'theme' match (only called for a page). */
function resolveMatchedTerm(match, families) {
  if (!match) return null;
  if (match.matchedOn !== 'theme') return match.matchedTerm || null;
  let themeTerms = {};
  try { themeTerms = JSON.parse(match.themeTermsJson || '{}') || {}; } catch (_) { themeTerms = {}; }
  const hit = (families || []).filter(family => Array.isArray(themeTerms[family]));
  return firstThemeTerm(themeTerms, hit.length ? hit : families || []);
}

module.exports = {
  SEARCH_VERSION,
  SHORT_TERM_MAX,
  DOCS_TABLE,
  FTS_TABLE,
  MATCH_RANK,
  buildSearchDocument,
  domainSubstringMatch,
  censusFacts,
  matchDocument,
  evaluateMatch,
  resultRank,
  compileSearch,
  ensureSearchSchema,
  writeSearchDocument,
  indexMissingSearchDocuments,
  indexAllMissingSearchDocuments,
  indexStaleSearchDocuments,
  storedSearchVersion,
  writeIndexerStatus,
  searchIndexerStatus,
  DEFAULT_BATCH,
  INDEXER_META_KEY,
  ensureSearchIndex,
  startSearchIndexRebuild,
  searchIndexRebuild,
  searchIndexAvailable,
  searchCandidates,
  resolveMatchedTerm,
};
