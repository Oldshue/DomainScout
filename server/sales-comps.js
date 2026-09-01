'use strict';

/**
 * DNJournal end-user sales comps ingest (Stage 4 of the portfolio engine).
 *
 * Fetches DNJournal's current-year sale charts (archive index page plus the
 * current "domainsales.htm" page), parses each chart's HTML table for sale
 * rows, classifies rows by venue and side (enduser vs auction), and stores
 * end-user comps for later retrieval by name shape (tld / wordCount / theme).
 *
 * Pure/injectable in the style of server/nrd-importer.js: the caller passes
 * an already-open better-sqlite3 handle, network fetches are overridable via
 * opts.fetchText for deterministic tests, and the public orchestrators
 * (importYear, runCompsRefresh) never throw.
 *
 * Auction/wholesale venues (NameJet, SnapNames, DropCatch, GoDaddy auctions,
 * Dynadot, Namecheap marketplace, Porkbun, Park.io, generic "auction") are
 * excluded from the retail comp set by design — they represent investor
 * churn, not end-user demand. This module still records those rows with
 * side='auction' (compsForShape filters them out) so callers can audit
 * exclusions if needed.
 */

const fs = require('fs');
const path = require('path');

const SALES_COMPS_USER_AGENT = 'DomainScout/1.0';
const FETCH_TIMEOUT_MS = 20000;
const FETCH_SPACING_MS = 400;

const DOMAIN_CELL_RE = /^[a-z0-9][a-z0-9-]*\.[a-z]{2,}(\.[a-z]{2})?$/i;
const PRICE_CELL_RE = /^\$\s?[\d,]{3,}$/;
const RANK_CELL_RE = /^\d+\.$/;

const KNOWN_VENUES = [
  'Sedo', 'Atom.com', 'Afternic', 'DomainMarket', 'Nameshift', 'Spaceship',
  'NameJet', 'SnapNames', 'Dynadot', 'GoDaddy', 'Namecheap', 'Porkbun',
  'DropCatch', 'BuyDomains', 'HugeDomains', 'NamePros', 'Squadhelp', 'Brandpa',
];
const VENUE_MENTION_RE = new RegExp(
  `\\b(${KNOWN_VENUES.map(v => v.replace('.', '\\.')).join('|')})\\b`, 'i'
);
const AUCTION_VENUE_RE = /namejet|snapnames|dropcatch|godaddy|dynadot|namecheap|porkbun|park\.io|catched|auction/i;

// ---------------------------------------------------------------------------
// Dictionary loader — same fallback chain as server/nrd-importer.js's word
// segmentation: env override -> system dictionary -> vendored word list.
// Fails open (empty dictionary -> word_count null) rather than throwing, so
// a missing dictionary on any given host never breaks the ingest.
// ---------------------------------------------------------------------------

const DICT_ENV_VAR = 'DOMAINSCOUT_DICTIONARY_PATH';
const SYSTEM_DICT_PATHS = ['/usr/share/dict/words', '/usr/dict/words'];
const VENDORED_DICT_PATH = path.join(__dirname, '..', 'data', 'dictionary.txt');

let _dictionaryCache = null;

function loadDictionary() {
  if (_dictionaryCache) return _dictionaryCache;
  const candidates = [];
  if (process.env[DICT_ENV_VAR]) candidates.push(process.env[DICT_ENV_VAR]);
  candidates.push(...SYSTEM_DICT_PATHS, VENDORED_DICT_PATH);
  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const text = fs.readFileSync(candidate, 'utf8');
      const words = new Set();
      for (const line of text.split(/\r?\n/)) {
        const w = line.trim().toLowerCase();
        if (w.length >= 2 && /^[a-z]+$/.test(w)) words.add(w);
      }
      if (words.size) {
        _dictionaryCache = words;
        return _dictionaryCache;
      }
    } catch (_) {
      // try next candidate
    }
  }
  _dictionaryCache = new Set();
  return _dictionaryCache;
}

/**
 * Counts dictionary words in `label` when it fully segments into consecutive
 * dictionary words (min word length 2); returns null when no full
 * segmentation exists, or when no dictionary could be loaded.
 */
function countDictionaryWords(label) {
  const clean = String(label || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!clean) return null;
  const dict = loadDictionary();
  if (!dict.size) return null;

  const n = clean.length;
  const best = new Array(n + 1).fill(null);
  best[0] = 0;
  for (let end = 1; end <= n; end++) {
    for (let start = 0; start < end; start++) {
      if (best[start] === null) continue;
      const word = clean.slice(start, end);
      if (word.length < 2 || !dict.has(word)) continue;
      const candidate = best[start] + 1;
      if (best[end] === null || candidate < best[end]) best[end] = candidate;
    }
  }
  return best[n];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function ensureCompsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_comps (
      domain TEXT NOT NULL,
      price_usd INTEGER NOT NULL,
      venue TEXT,
      side TEXT,
      chart_date TEXT,
      tld TEXT,
      label TEXT,
      word_count INTEGER,
      PRIMARY KEY (domain, price_usd, chart_date)
    );
    CREATE TABLE IF NOT EXISTS sales_comps_pages (
      url TEXT PRIMARY KEY,
      fetched_at TEXT,
      rows INTEGER
    );
  `);
}

// ---------------------------------------------------------------------------
// Fetch + chart discovery
// ---------------------------------------------------------------------------

async function fetchTextDefault(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': SALES_COMPS_USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts every chart URL for `year` from an index page's HTML, matching
 * hrefs of the form `domainsales/${year}/MMDD.htm` regardless of how the
 * href is written on the page (`domainsales/2026/0121.htm`,
 * `../domainsales/2026/0121.htm`, or a fully-qualified absolute URL) and
 * normalising every match to the canonical absolute form
 * `https://www.dnjournal.com/archive/domainsales/${year}/MMDD.htm`. Used for
 * both the per-year archive index and the main archive index fallback, since
 * both pages link charts the same way.
 */
function extractChartUrls(html, year) {
  const urls = [];
  const hrefRe = /href=["']([^"']+)["']/gi;
  const dayRe = /domainsales\/(\d{4})\/(\d{4})\.htm/i;
  const seen = new Set();
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const dayMatch = dayRe.exec(m[1]);
    if (!dayMatch) continue;
    const [, hrefYear, mmdd] = dayMatch;
    if (hrefYear !== String(year)) continue;
    const abs = `https://www.dnjournal.com/archive/domainsales/${hrefYear}/${mmdd}.htm`;
    if (!seen.has(abs)) {
      seen.add(abs);
      urls.push(abs);
    }
  }
  return urls;
}

/**
 * Returns absolute chart URLs for `year`. Tries the per-year archive index
 * (`archive/domainsales-archive-${year}.htm`) first, as DNJournal publishes
 * one for every PAST year. When that fetch fails (non-200/throw) or yields
 * zero chart URLs — as happens for the CURRENT year, which has no per-year
 * index yet and instead lists its weekly charts on the main archive index
 * (`archive/domainsales-archive.htm`) — falls back to extracting chart URLs
 * from that main index instead. The discovered URLs are merged with, and
 * deduped against, the current chart page domainsales.htm (not year-scoped,
 * always appended last so today's not-yet-archived sales are captured).
 * Logs one line noting how many charts were found and which source
 * ('year-index' or 'archive-index') supplied them.
 */
async function listChartUrls(year, opts = {}) {
  const fetchTextFn = opts.fetchText || fetchTextDefault;
  const yearIndexUrl = `https://www.dnjournal.com/archive/domainsales-archive-${year}.htm`;
  const archiveIndexUrl = 'https://www.dnjournal.com/archive/domainsales-archive.htm';
  const current = 'https://www.dnjournal.com/domainsales.htm';

  let urls = [];
  let source = 'year-index';
  try {
    const html = await fetchTextFn(yearIndexUrl);
    urls = extractChartUrls(html, year);
  } catch (err) {
    console.warn(`[SalesComps] listChartUrls: index fetch failed for ${year} (${err.message})`);
  }

  if (!urls.length) {
    source = 'archive-index';
    try {
      const html = await fetchTextFn(archiveIndexUrl);
      urls = extractChartUrls(html, year);
    } catch (err) {
      console.warn(`[SalesComps] listChartUrls: archive index fetch failed for ${year} (${err.message})`);
    }
  }

  const merged = urls.filter(u => u !== current);
  merged.push(current);

  console.log(`[SalesComps] listChartUrls: ${merged.length} charts for ${year} via ${source}`);
  return merged;
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ',
};

function unescapeEntities(text) {
  return String(text).replace(/&(#?[a-z0-9]+);/gi, (whole, ent) => {
    const key = ent.toLowerCase();
    if (key in ENTITY_MAP) return ENTITY_MAP[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(code)) return String.fromCharCode(code);
    }
    return whole;
  });
}

function cellText(html) {
  const noTags = String(html).replace(/<[^>]*>/g, ' ');
  const unescaped = unescapeEntities(noTags);
  return unescaped.replace(/\s+/g, ' ').trim();
}

/**
 * Parses one DNJournal chart page into sale-row objects. Iterates <tr>
 * blocks; each row's cells are the stripped/unescaped/collapsed text of its
 * <td> elements (empty cells dropped). A sale row is one containing a
 * domain-shaped cell and a price-shaped cell. venue is the cell immediately
 * after the price when that cell is neither a rank ("12.") nor itself a
 * domain/price; otherwise venue falls back to the most recently seen short
 * (<400 chars) non-sale row mentioning a known venue name (a running
 * section header). side is 'auction' when venue matches the auction venue
 * pattern, else 'enduser'. word_count is computed on the label (portion of
 * the domain before the first dot) via the same dictionary segmentation as
 * countDictionaryWords/server/nrd-importer.js; null when unsegmentable.
 */
function parseChartHtml(html, chartDate) {
  const rows = [];
  if (!html) return rows;
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let sectionVenue = null;
  let trMatch;
  while ((trMatch = trRe.exec(html)) !== null) {
    const trHtml = trMatch[1];
    const cells = [];
    let tdMatch;
    tdRe.lastIndex = 0;
    while ((tdMatch = tdRe.exec(trHtml)) !== null) {
      const text = cellText(tdMatch[1]);
      if (text) cells.push(text);
    }
    if (!cells.length) continue;

    const domainIdx = cells.findIndex(c => DOMAIN_CELL_RE.test(c));
    const priceIdx = cells.findIndex(c => PRICE_CELL_RE.test(c));

    if (domainIdx === -1 || priceIdx === -1) {
      const rowText = cells.join(' ');
      if (rowText.length < 400) {
        const vm = rowText.match(VENUE_MENTION_RE);
        if (vm) sectionVenue = vm[1];
      }
      continue;
    }

    const domain = cells[domainIdx].toLowerCase();
    const priceDigits = cells[priceIdx].replace(/[^\d]/g, '');
    const price = parseInt(priceDigits, 10);
    if (!Number.isFinite(price)) continue;

    let venue = null;
    const afterPrice = cells[priceIdx + 1];
    if (
      afterPrice &&
      !RANK_CELL_RE.test(afterPrice) &&
      !DOMAIN_CELL_RE.test(afterPrice) &&
      !PRICE_CELL_RE.test(afterPrice)
    ) {
      venue = afterPrice;
    } else {
      venue = sectionVenue;
    }

    const side = venue && AUCTION_VENUE_RE.test(venue) ? 'auction' : 'enduser';
    const dotIdx = domain.indexOf('.');
    const label = dotIdx > -1 ? domain.slice(0, dotIdx) : domain;
    const tld = dotIdx > -1 ? domain.slice(dotIdx + 1) : null;
    let wordCount = null;
    try { wordCount = countDictionaryWords(label); } catch (_) { wordCount = null; }

    rows.push({
      domain,
      price_usd: price,
      venue: venue || null,
      side,
      chart_date: chartDate,
      tld,
      label,
      word_count: wordCount,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Import orchestration
// ---------------------------------------------------------------------------

function chartDateFromUrl(url) {
  const m = url.match(/(\d{4})\/(\d{4})\.htm$/);
  if (!m) return new Date().toISOString().slice(0, 10);
  const [, yr, mmdd] = m;
  return `${yr}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`;
}

/**
 * Imports one year of DNJournal charts into a caller-owned better-sqlite3
 * handle. Skips chart URLs already recorded in sales_comps_pages unless
 * opts.force is set. 400ms spacing between fetches. Never throws — logs a
 * single [SalesComps] summary line and returns { pages, rows, endUser,
 * auction }.
 */
async function importYear(db, year, opts = {}) {
  const fetchTextFn = opts.fetchText || fetchTextDefault;
  const sleepFn = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const force = !!opts.force;
  let pages = 0;
  let totalRows = 0;
  let endUser = 0;
  let auction = 0;
  try {
    ensureCompsSchema(db);
    const urls = await listChartUrls(year, { fetchText: fetchTextFn });
    const seenStmt = db.prepare('SELECT 1 FROM sales_comps_pages WHERE url = ?');
    const insertRow = db.prepare(`
      INSERT OR IGNORE INTO sales_comps
        (domain, price_usd, venue, side, chart_date, tld, label, word_count)
      VALUES (@domain, @price_usd, @venue, @side, @chart_date, @tld, @label, @word_count)
    `);
    const recordPage = db.prepare(`
      INSERT INTO sales_comps_pages (url, fetched_at, rows) VALUES (?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET fetched_at = excluded.fetched_at, rows = excluded.rows
    `);

    for (const url of urls) {
      if (!force && seenStmt.get(url)) continue;
      try {
        const html = await fetchTextFn(url);
        const chartDate = chartDateFromUrl(url);
        const rows = parseChartHtml(html, chartDate);
        const txn = db.transaction(() => {
          for (const row of rows) insertRow.run(row);
          recordPage.run(url, new Date().toISOString(), rows.length);
        });
        txn();
        pages += 1;
        totalRows += rows.length;
        for (const row of rows) {
          if (row.side === 'enduser') endUser += 1;
          else if (row.side === 'auction') auction += 1;
        }
      } catch (err) {
        console.warn(`[SalesComps] importYear: ${url} failed (${err.message})`);
      }
      await sleepFn(FETCH_SPACING_MS);
    }

    console.log(`[SalesComps] year ${year}: ${pages} pages, ${totalRows} rows (${endUser} end-user, ${auction} auction)`);
    return { pages, rows: totalRows, endUser, auction };
  } catch (err) {
    console.warn(`[SalesComps] importYear failed for ${year}: ${err.message}`);
    return { pages, rows: totalRows, endUser, auction, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Comps lookup
// ---------------------------------------------------------------------------

/**
 * Returns end-user comps (side='enduser') matching the given name shape:
 * tld, exact word_count (when provided), an optional theme regex applied to
 * the label, an optional sinceDate floor on chart_date, and a price band
 * [minPrice, maxPrice]. Never throws — returns an empty comp set on error.
 */
function compsForShape(db, opts = {}) {
  const {
    tld = 'com',
    wordCount,
    theme,
    sinceDate,
    minPrice = 500,
    maxPrice = 50000,
  } = opts || {};
  try {
    ensureCompsSchema(db);
    const clauses = ["side = 'enduser'", 'tld = ?', 'price_usd >= ?', 'price_usd <= ?'];
    const params = [tld, minPrice, maxPrice];
    if (wordCount !== undefined && wordCount !== null) {
      clauses.push('word_count = ?');
      params.push(wordCount);
    }
    if (sinceDate) {
      clauses.push('chart_date >= ?');
      params.push(sinceDate);
    }

    const sql = `SELECT domain, price_usd, venue, chart_date, label FROM sales_comps WHERE ${clauses.join(' AND ')}`;
    let rows = db.prepare(sql).all(...params);

    if (theme) {
      let re = null;
      try { re = new RegExp(theme, 'i'); } catch (_) { re = null; }
      if (re) rows = rows.filter(r => re.test(r.label || ''));
    }

    const prices = rows.map(r => r.price_usd).sort((a, b) => a - b);
    const n = prices.length;
    const percentile = (p) => {
      if (!n) return null;
      const idx = (n - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return prices[lo];
      return prices[lo] + (prices[hi] - prices[lo]) * (idx - lo);
    };

    const examples = rows
      .slice()
      .sort((a, b) => b.price_usd - a.price_usd)
      .slice(0, 8)
      .map(r => ({ domain: r.domain, price: r.price_usd, chartDate: r.chart_date, venue: r.venue }));

    return {
      n,
      median: percentile(0.5),
      p25: percentile(0.25),
      p75: percentile(0.75),
      examples,
    };
  } catch (err) {
    console.warn(`[SalesComps] compsForShape failed: ${err.message}`);
    return { n: 0, median: null, p25: null, p75: null, examples: [] };
  }
}

/**
 * Never-throw orchestrator for the daily cron and startup catch-up: imports
 * only the current calendar year (prior years are static and already
 * imported; they are not re-fetched by this path). Stage 5 wires this into
 * a scheduler and feeds compsForShape output into the acquisition board.
 */
async function runCompsRefresh(db, opts = {}) {
  try {
    ensureCompsSchema(db);
    const year = opts.year || new Date().getUTCFullYear();
    const result = await importYear(db, year, opts);
    return { year, ...result };
  } catch (err) {
    console.warn(`[SalesComps] runCompsRefresh failed: ${err.message}`);
    return { year: opts.year || new Date().getUTCFullYear(), error: err.message };
  }
}

module.exports = {
  ensureCompsSchema,
  listChartUrls,
  parseChartHtml,
  importYear,
  compsForShape,
  runCompsRefresh,
  countDictionaryWords,
  loadDictionary,
};
