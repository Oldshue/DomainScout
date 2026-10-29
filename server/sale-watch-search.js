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
 * with that family matches. matchedOn is 'name' | 'site' | 'theme'; ranking is
 * name, then site, then theme.
 */

const { namingProfile, THEME_WORDS, themeMatches, themesForTerm } = require('./movement-report-semantics');
const { loadDictionary } = require('./domainlab');
const { nsSetKey, isExpiryDestination } = require('./nameserver-classes');

// v2: documents also carry the narrow census facts the candidate tape needs
// (departure day, destination key, expiry origin, site class, buyer use), so a
// window census never re-parses evidence_json for indexed rows.
// v3: report_day falls back to exit_observed_day (DEPARTURE_DATE_SQL), and the
// census is served from covering indexes over these narrow columns.
// v4: theme tags carry sub-themes (q=inference expands to AI inference/compute
// only, not every ai-tagged row), and site-derived theme tags come from the
// page title/description words only, never the long text sample.
const SEARCH_VERSION = 'sale-watch-search/v4';
const DOCS_TABLE = 'sale_watch_search_docs';
const FTS_TABLE = 'sale_watch_search';
const MAX_SITE_CHARS = 1200;
const MAX_SITE_WORDS = 200;
const MAX_TERM_LEN = 40;
// Query terms this short (ai, ml, gpu) match only whole tokens: a label
// segment or a standalone site word, never a substring of another word.
const SHORT_TERM_MAX = 3;
const MATCH_RANK = Object.freeze({ name: 0, site: 1, theme: 2 });

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
    if (text.startsWith(word) && knownWord(text.slice(word.length))) return [word, text.slice(word.length)];
    if (text.endsWith(word) && knownWord(text.slice(0, -word.length))) return [text.slice(0, -word.length), word];
  }
  return null;
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
    for (const word of split || [text]) if (/^[a-z0-9]+$/.test(word)) segments.push(word);
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
 * Pure: whether q matches the domain as a raw substring. Only terms longer
 * than SHORT_TERM_MAX letters qualify; a short term ("ai") must match a whole
 * label segment through the name terms instead (never prezzi/chair).
 */
function domainSubstringMatch(domain, q) {
  const raw = String(q || '').trim().toLowerCase();
  if (raw.replace(/[^a-z0-9]/g, '').length <= SHORT_TERM_MAX) return false;
  return String(domain || '').toLowerCase().includes(raw);
}

/**
 * Pure: the buyer-meaningful search document for one row. `evidence` is the
 * stored evidence object (or a ledger entry of the same shape).
 */
function buildSearchDocument(domain, evidence) {
  const { terms, segments } = nameTerms(domain);
  const siteWords = unique(words(siteText(evidence))).slice(0, MAX_SITE_WORDS);
  const headlineWords = unique(words(siteHeadline(evidence))).slice(0, MAX_SITE_WORDS);
  const byId = new Map();
  for (const match of [...themeMatches(withJoins(segments.length ? segments : terms)), ...themeMatches(withJoins(headlineWords))]) {
    byId.set(match.id, unique([...(byId.get(match.id) || []), ...match.terms]));
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
  return { name, site, theme, themeTerms, searchText };
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

// Prefix-match only words long enough to be specific ("infer" -> inference);
// short words ("ai") must match a whole word, never aid/air/aim.
function termMatches(term, word) {
  return word.length >= 4 ? term.startsWith(word) : term === word;
}

function firstThemeTerm(themeTerms, families) {
  for (const family of families) {
    const terms = themeTerms && themeTerms[family];
    if (Array.isArray(terms) && terms.length) return terms[0];
  }
  return families[0] || null;
}

/**
 * Pure: why (if at all) a search document matches q. Used for in-memory
 * ledger rows; the SQL path (searchCandidates) applies the same rules.
 */
function matchDocument(doc, q, domain = '') {
  const raw = String(q || '').trim().toLowerCase();
  if (!raw) return null;
  const wanted = queryWords(raw);
  const nameList = String(doc.name || '').split(' ').filter(Boolean);
  const siteList = String(doc.site || '').split(' ').filter(Boolean);
  const all = (list) => wanted.length > 0 && wanted.every(word => list.some(term => termMatches(term, word)));
  if (domainSubstringMatch(domain, raw) || all(nameList)) return { matchedOn: 'name', matchedTerm: raw };
  if (all(siteList)) return { matchedOn: 'site', matchedTerm: raw };
  const families = themesForTerm(raw);
  const tagged = new Set(String(doc.theme || '').split(' ').filter(Boolean));
  const hit = families.filter(family => tagged.has(family));
  if (hit.length) return { matchedOn: 'theme', matchedTerm: firstThemeTerm(doc.themeTerms, hit), theme: hit[0] };
  return null;
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
    CREATE TABLE IF NOT EXISTS ${DOCS_TABLE} (
      id INTEGER PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      name TEXT, site TEXT, theme TEXT, theme_terms TEXT,
      report_day TEXT, destination_key TEXT, expiry_origin INTEGER, site_class TEXT, buyer_use INTEGER
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
  for (const [name, type] of [['report_day', 'TEXT'], ['destination_key', 'TEXT'], ['expiry_origin', 'INTEGER'], ['site_class', 'TEXT'], ['buyer_use', 'INTEGER']]) {
    if (!docColumns.includes(name)) db.exec(`ALTER TABLE ${DOCS_TABLE} ADD COLUMN ${name} ${type}`);
  }
  // Covering indexes for the window census: the docs side by departure day,
  // the candidate side by domain, partial on indexed rows, so the census
  // never reads the evidence_json overflow pages.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sale_watch_search_docs_census
      ON ${DOCS_TABLE} (report_day, domain, destination_key, expiry_origin, site_class, buyer_use);
    CREATE INDEX IF NOT EXISTS idx_sale_watch_candidates_census
      ON sale_watch_candidates (domain, state, outcome, probe_count)
      WHERE evidence_json IS NOT NULL AND search_text IS NOT NULL;
  `);
}

const writeStatements = new WeakMap();
function statementsFor(db) {
  let statements = writeStatements.get(db);
  if (!statements) {
    statements = {
      setText: db.prepare('UPDATE sale_watch_candidates SET search_text = ? WHERE domain = ?'),
      upsertDoc: db.prepare(`INSERT INTO ${DOCS_TABLE} (domain, name, site, theme, theme_terms, report_day, destination_key, expiry_origin, site_class, buyer_use)
        VALUES (@domain, @name, @site, @theme, @themeTerms,
          COALESCE(NULLIF(@reportDay, ''), (SELECT exit_observed_day FROM sale_watch_candidates WHERE domain = @domain), ''),
          @destinationKey, @expiryOrigin, @siteClass, @buyerUse)
        ON CONFLICT(domain) DO UPDATE SET name = excluded.name, site = excluded.site, theme = excluded.theme, theme_terms = excluded.theme_terms,
          report_day = excluded.report_day, destination_key = excluded.destination_key, expiry_origin = excluded.expiry_origin,
          site_class = excluded.site_class, buyer_use = excluded.buyer_use`),
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
    statements.upsertDoc.run({ domain, name: doc.name, site: doc.site, theme: doc.theme, themeTerms: JSON.stringify(doc.themeTerms), ...facts });
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
 * first. Writes `batch`-row transactions and awaits setImmediate between
 * them. `limit` caps the rows examined by this call (default: no cap);
 * `sinceDays: null` removes the day cutoff (rows with no exit day are then
 * indexed last). A keyset cursor over (exit_observed_day, rowid) means a row
 * whose write fails is skipped rather than retried forever, and no call ever
 * materializes more than one page. Writable handle only.
 */
async function indexMissingSearchDocuments(db, {
  now = new Date(), sinceDays = null, limit = Infinity, batch = 1000, onProgress = null, progressEvery = 50000,
} = {}) {
  const started = Date.now();
  const today = new Date(now || Date.now()).toISOString().slice(0, 10);
  const cutoff = sinceDays === null || sinceDays === undefined ? '' : dayMinus(today, sinceDays);
  const max = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Math.floor(Number(limit)) : Infinity;
  const size = Math.max(1, Math.floor(Number(batch)) || 1000);
  const dated = db.prepare(`
    SELECT rowid AS rid, domain, evidence_json, exit_observed_day AS day FROM sale_watch_candidates
    WHERE search_text IS NULL AND evidence_json IS NOT NULL
      AND exit_observed_day IS NOT NULL AND exit_observed_day >= @cutoff
      AND (exit_observed_day, rowid) < (@day, @rid)
    ORDER BY exit_observed_day DESC, rowid DESC LIMIT @take`);
  const undated = cutoff === '' ? db.prepare(`
    SELECT rowid AS rid, domain, evidence_json FROM sale_watch_candidates
    WHERE search_text IS NULL AND evidence_json IS NOT NULL AND exit_observed_day IS NULL AND rowid > @rid
    ORDER BY rowid LIMIT @take`) : null;
  const write = db.transaction(chunk => {
    let ok = 0;
    for (const row of chunk) if (writeSearchDocument(db, row.domain, row.evidence_json)) ok += 1;
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
 * Boot path, cooperative: when SEARCH_VERSION changes (or on first run) every
 * row's search_text is cleared and the window is re-indexed, and orphan
 * documents for deleted candidates are purged; otherwise only missing rows in
 * the window are indexed. Clear and purge walk rowid ranges of `chunk` rows
 * and yield between them. Nothing runs in the caller's tick. Writable handle
 * only; prefer startSearchIndexRebuild, which runs this in the background.
 */
async function ensureSearchIndex(db, { now = new Date(), sinceDays = 30, batch = 1000, chunk = 5000, onProgress = null } = {}) {
  await yieldToEventLoop();
  const started = Date.now();
  ensureSearchSchema(db);
  const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get('search_version');
  const rebuild = !row || row.value !== SEARCH_VERSION;
  const step = Math.max(1, Math.floor(Number(chunk)) || 5000);
  let cleared = 0;
  if (rebuild) {
    const top = Number(db.prepare('SELECT MAX(rowid) AS n FROM sale_watch_candidates').get().n || 0);
    const clear = db.prepare('UPDATE sale_watch_candidates SET search_text = NULL WHERE rowid > ? AND rowid <= ? AND search_text IS NOT NULL');
    for (let low = 0; low < top; low += step) {
      cleared += clear.run(low, low + step).changes;
      await yieldToEventLoop();
    }
  }
  let purged = 0;
  const topDoc = Number(db.prepare(`SELECT MAX(id) AS n FROM ${DOCS_TABLE}`).get().n || 0);
  const purge = db.prepare(`DELETE FROM ${DOCS_TABLE} WHERE id > ? AND id <= ?
    AND NOT EXISTS (SELECT 1 FROM sale_watch_candidates c WHERE c.domain = ${DOCS_TABLE}.domain)`);
  for (let low = 0; low < topDoc; low += step) {
    purged += purge.run(low, low + step).changes;
    await yieldToEventLoop();
  }
  const pass = await indexMissingSearchDocuments(db, { now, sinceDays, batch, onProgress });
  if (rebuild && pass.exhausted) {
    db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES('search_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SEARCH_VERSION);
  }
  return { version: SEARCH_VERSION, rebuilt: rebuild, cleared, indexed: pass.indexed, failed: pass.failed, purged, ms: Date.now() - started };
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
  let promise;
  try {
    promise = ensureSearchIndex(db, {
      ...opts,
      onProgress: progress => log.log(`[SaleWatchSearch] index rebuild progress: ${progress.indexed} indexed, ${progress.examined} examined, ${progress.ms}ms`),
    })
      .then(result => {
        log.log(`[SaleWatchSearch] index rebuild done in ${Date.now() - started}ms: ${JSON.stringify(result)}`);
        return result;
      })
      .catch(error => {
        log.warn(`[SaleWatchSearch] index rebuild failed after ${Date.now() - started}ms: ${error.message}`);
        return { error: error.message };
      })
      .finally(() => { if (rebuilds.get(db) === promise) rebuilds.delete(db); });
  } catch (error) {
    log.warn(`[SaleWatchSearch] index rebuild could not start: ${error.message}`);
    return { background: true, started: false, error: error.message };
  }
  rebuilds.set(db, promise);
  return { background: true, started: true, running: true };
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

function ftsTerm(word) {
  return word.length >= 4 ? `"${word}"*` : `"${word}"`;
}

/** The FTS5 MATCH expressions q compiles to (exported for the ledger reader). */
function compileSearch(q) {
  const raw = String(q || '').trim().toLowerCase();
  const wanted = queryWords(raw);
  const families = themesForTerm(raw);
  return {
    q: raw,
    words: wanted,
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
 * Map domain -> { matchedOn, matchedTerm | themeTermsJson } for q from the
 * persisted FTS index. Domain-substring matches are layered on by the caller
 * (they need no index). Returns available:false when the index has not been
 * created yet (the reader then falls back to domain-only matching).
 */
function searchCandidates(db, q) {
  const compiled = compileSearch(q);
  const matches = new Map();
  if (!compiled.q || !searchIndexAvailable(db)) return { available: compiled.q ? searchIndexAvailable(db) : true, matches, families: compiled.families };
  const select = db.prepare(`SELECT d.domain AS domain, d.theme_terms AS themeTerms
    FROM ${FTS_TABLE} s JOIN ${DOCS_TABLE} d ON d.id = s.rowid WHERE ${FTS_TABLE} MATCH ?`);
  const run = expression => (expression ? select.all(expression) : []);
  for (const row of run(compiled.name)) matches.set(row.domain, { matchedOn: 'name', matchedTerm: compiled.q });
  for (const row of run(compiled.site)) if (!matches.has(row.domain)) matches.set(row.domain, { matchedOn: 'site', matchedTerm: compiled.q });
  for (const row of run(compiled.theme)) {
    if (!matches.has(row.domain)) matches.set(row.domain, { matchedOn: 'theme', themeTermsJson: row.themeTerms });
  }
  return { available: true, matches, families: compiled.families };
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
  compileSearch,
  ensureSearchSchema,
  writeSearchDocument,
  indexMissingSearchDocuments,
  indexAllMissingSearchDocuments,
  ensureSearchIndex,
  startSearchIndexRebuild,
  searchIndexRebuild,
  searchIndexAvailable,
  searchCandidates,
  resolveMatchedTerm,
};
