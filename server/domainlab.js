'use strict';

/**
 * DomainLab — unified cross-zone trending-terms analysis.
 *
 * Folds the read-oriented capabilities zone-intelligence.js already exposes
 * (movement, per-token domains) together with the raw multi-TLD trend
 * capture tables zone-indexer.js maintains (zone_keyword_trends,
 * zone_keyword_tld_history, zone_daily_stats, name_summary, zone_names) into
 * one semantically-aware view: a term that ticks up in BOTH .app and .dev is
 * recognizable as "technical extensions co-moving", not two unrelated rows.
 *
 * Every query here either hits an existing zone_index.db index or one added
 * by ensureDomainLabIndexes() below (documented in DEPLOY-DOMAINLAB.md).
 * Nothing here scans zone_names (207M+ rows, 65GB db) — term/word lookups
 * against it are always exact base_name matches on its PRIMARY KEY / idx_zn_base.
 *
 * Signal-quality pass (this revision): raw zone_keyword_tld_history spread
 * is noisy — bulk-blast defensive/spam registrations (one actor registering
 * the same base name same-day across a dozen+ unrelated junk TLDs) and
 * digit/gibberish strings otherwise outrank organic cross-zone co-movement
 * like "actionmenu" in .app+.dev. classifyTermSignal() and the qualityScore
 * it feeds are a re-ranking/filtering layer only — raw spread, momentum and
 * zone lists are always still returned unmodified on every row so nothing
 * upstream that reads the old fields breaks.
 */

const fs = require('fs');
const path = require('path');
const { getKeywordTrendHistory } = require('./zone-indexer');

const MAX_TREND_ROWS = 200000; // mirrors CZDS_TREND_RETURN_LIMIT default in zone-indexer.js
const MIN_BASELINE_SAMPLE = 3;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ── Zone semantic groups ────────────────────────────────────────────────────
// Extend this map to teach DomainLab new cross-zone families. Any TLD not
// listed and not a bare 2-letter ccTLD falls into 'other'.
const ZONE_SEMANTIC_GROUPS = {
  technical: ['dev', 'app', 'io', 'sh', 'tech', 'ai', 'bot', 'codes', 'cloud'],
  commerce: ['shop', 'store', 'buy', 'market'],
  health: ['health', 'care', 'med', 'clinic'],
  finance: ['finance', 'money', 'capital', 'fund', 'loan'],
  media: ['tv', 'media', 'video', 'stream'],
  identity: ['me', 'name', 'id', 'bio'],
};

// The six curated groups DomainLab actively understands the semantics of.
// 'geo' (bare ccTLDs) and 'other' (everything else — including the junk
// gTLDs bulk-blast registrations favor) are deliberately NOT curated: a
// same-day spread that lands mostly in 'other' is the bulk-blast signature.
const CURATED_GROUPS = new Set(['technical', 'commerce', 'health', 'finance', 'media', 'identity']);

// Default market-research projection. The full accessible-zone corpus remains
// queryable with includeAllZones=1, but restricted/locality/brand zones do not
// crowd useful open-market extensions out of the first screen.
const GENERAL_MARKET_TLDS = new Set([
  'com', 'net', 'org', 'co', 'xyz', 'online', 'site', 'website', 'world',
  'global', 'one', 'space', 'life', 'today', 'news', 'blog', 'design',
  'studio', 'art', 'pro', 'group', 'company', 'business', 'agency',
  'digital', 'software', 'systems', 'network', 'solutions', 'services',
]);
const DOMAINLAB_ZONE_LEAD = [
  'dev', 'app', 'ai', 'bot', 'io', 'com', 'co', 'sh', 'tech', 'cloud', 'codes',
  'shop', 'store', 'net', 'org', 'xyz', 'online', 'site',
];
const DOMAINLAB_ZONE_RANK = new Map(DOMAINLAB_ZONE_LEAD.map((tld, index) => [tld, index]));

const TLD_TO_GROUP = new Map();
for (const [group, tlds] of Object.entries(ZONE_SEMANTIC_GROUPS)) {
  for (const tld of tlds) TLD_TO_GROUP.set(tld, group);
}

function cleanTld(value) {
  return String(value || '').toLowerCase().replace(/^\./, '');
}

function semanticGroupForTld(tld) {
  const clean = cleanTld(tld);
  if (TLD_TO_GROUP.has(clean)) return TLD_TO_GROUP.get(clean);
  if (/^[a-z]{2}$/.test(clean)) return 'geo';
  return 'other';
}

function isActionableZone(tld) {
  const clean = cleanTld(tld);
  return GENERAL_MARKET_TLDS.has(clean) || CURATED_GROUPS.has(semanticGroupForTld(clean));
}

function zoneRelevanceRank(tld) {
  const clean = cleanTld(tld);
  if (DOMAINLAB_ZONE_RANK.has(clean)) return DOMAINLAB_ZONE_RANK.get(clean);
  if (isActionableZone(clean)) return 1000;
  return 10000;
}

// ── Dictionary phrase segmentation ──────────────────────────────────────────
// Fallback chain: an explicit override, then the mac's system dictionary,
// then a vendored word list committed for hosts (e.g. Railway) that have
// neither. First path that exists on disk wins; loadDictionary() still
// degrades gracefully (empty Set, warn-and-continue) when none exist.
function resolveDictionaryPath() {
  const candidates = [
    process.env.DOMAINSCOUT_DICT_PATH,
    '/usr/share/dict/words',
    path.join(__dirname, 'assets/english-words.txt'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* keep checking remaining candidates */ }
  }
  return candidates[candidates.length - 1] || '/usr/share/dict/words';
}
const MAX_SEGMENT_LEN = 24;
let _dict = null;

function loadDictionary() {
  if (_dict) return _dict;
  _dict = new Set();
  const dictPath = resolveDictionaryPath();
  try {
    const raw = fs.readFileSync(dictPath, 'utf8');
    for (const line of raw.split('\n')) {
      const word = line.trim().toLowerCase();
      if (word.length >= 2 && /^[a-z]+$/.test(word)) _dict.add(word);
    }
    console.log(`[DomainLab] loaded ${_dict.size.toLocaleString()} dictionary words from ${dictPath}`);
  } catch (err) {
    console.warn(`[DomainLab] dictionary unavailable at ${dictPath} (${err.message}); word-mode segmentation degrades to whole tokens`);
  }
  return _dict;
}

// Longest-match, left-to-right, non-backtracking segmentation of one
// alphabetic chunk. Bounded by MAX_SEGMENT_LEN per attempt — safe for the
// short base names zone files actually contain (labels are <=63 chars).
function segmentAlphaChunk(chunk, dict) {
  const out = [];
  let i = 0;
  const n = chunk.length;
  while (i < n) {
    let matched = null;
    const maxLen = Math.min(MAX_SEGMENT_LEN, n - i);
    for (let len = maxLen; len >= 2; len--) {
      const candidate = chunk.slice(i, i + len);
      if (dict.has(candidate)) { matched = candidate; break; }
    }
    if (matched) { out.push(matched); i += matched.length; continue; }
    let j = i + 1;
    while (j < n) {
      let found = false;
      const maxLen2 = Math.min(MAX_SEGMENT_LEN, n - j);
      for (let len = maxLen2; len >= 2; len--) {
        if (dict.has(chunk.slice(j, j + len))) { found = true; break; }
      }
      if (found) break;
      j++;
    }
    out.push(chunk.slice(i, j));
    i = j;
  }
  return out;
}

// Splits a base name into dictionary words/phrases: hyphens split first
// (multi-word base names like "rally-talent" are already explicit), then each
// hyphen part is longest-match segmented against /usr/share/dict/words.
// Falls back to returning the whole alphabetic chunk when the dictionary is
// unavailable, so callers never silently lose a term.
function segmentBaseName(baseName) {
  const dict = loadDictionary();
  const clean = String(baseName || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!clean) return [];
  const words = [];
  for (const part of clean.split(/-+/).filter(Boolean)) {
    for (const alphaChunk of part.split(/[0-9]+/).filter(Boolean)) {
      if (!dict.size) { words.push(alphaChunk); continue; }
      words.push(...segmentAlphaChunk(alphaChunk, dict));
    }
  }
  return words.filter(w => w.length >= 2);
}

// ── Daily-view token segmentation (server/nrd-importer.js) ─────────────────
// Mirrors scripts/nrd-backfill.py segment() EXACTLY — this is deliberately
// NOT segmentBaseName: bigrams/trigrams are the daily-view word_count
// contract, and segmentBaseName's own (numeric-splitting) behavior must stay
// byte-identical for its existing callers.
function tokenizeDailyLabel(label, opts = {}) {
  const dict = opts.dict || loadDictionary();
  const clean = String(label || '').toLowerCase();
  const parts = clean.split('-').filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (!/^[a-z]+$/.test(part) || part.length < 2) continue;
    let i = 0;
    const n = part.length;
    while (i < n) {
      let best = null;
      const maxLen = Math.min(n, i + 20);
      for (let j = maxLen; j >= i + 3; j--) {
        const candidate = part.slice(i, j);
        if (dict.has(candidate)) { best = candidate; break; }
      }
      if (best) { out.push(best); i += best.length; }
      else { i += 1; }
    }
  }

  const toks = new Map();
  if (out.length) {
    for (const t of out) toks.set(t, 1);
    for (let i = 0; i < out.length - 1; i++) toks.set(`${out[i]} ${out[i + 1]}`, 2);
    if (out.length >= 3) {
      for (let i = 0; i < out.length - 2; i++) toks.set(`${out[i]} ${out[i + 1]} ${out[i + 2]}`, 3);
    }
  }
  const lbl = clean.replace(/-/g, '');
  if (lbl && !toks.has(lbl)) toks.set(lbl, Math.max(1, out.length || 1));
  return toks;
}

// ── Noise / signal-quality classification ───────────────────────────────────
// Small, literal-substring const lexicon — intentionally short. This is a
// trending-view quality gate, not a moderation system: it exists only to
// stop terms like the live 'pornobolt' bulk-blast from reading as an
// organic cross-zone trend.
const ADULT_GAMBLING_LEXICON = [
  'porn', 'xxx', 'sex', 'escort', 'casino', 'poker', 'bet', 'slots',
  'gambling', 'viagra', 'cialis', 'camgirl', 'nsfw',
];

// Live production observation this threshold is calibrated against:
// 'jljl88' spread same-day across 18 junk TLDs; 'pornobolt' across ~50.
// Organic multi-TLD interest (e.g. a brand securing .com/.io/.co/.app) does
// not typically reach a dozen zones in one day, and when it does, it is
// concentrated in curated groups, not scattered across unrelated gTLDs.
const BULK_BLAST_MIN_ZONES = 12;

function digitsRatio(term) {
  const text = String(term || '');
  if (!text.length) return 0;
  const digits = (text.match(/[0-9]/g) || []).length;
  return digits / text.length;
}

function hasRepeatedCharRun(text, runLen) {
  const re = new RegExp(`(.)\\1{${runLen - 1},}`);
  return re.test(text);
}

// Heuristic, not linguistic ground truth: a token under 3 chars, one with a
// 3+ repeat of a single character (rm666, aaaaa), or one with 3+ letters and
// zero vowels (jljl, xzqrp) reads as keyboard-mash/gibberish rather than a
// coined brand name.
function isGibberishTerm(term) {
  const text = String(term || '').toLowerCase();
  if (text.length < 3) return true;
  if (hasRepeatedCharRun(text, 3)) return true;
  const alpha = text.replace(/[^a-z]/g, '');
  if (alpha.length >= 3 && !/[aeiou]/.test(alpha)) return true;
  return false;
}

/**
 * Classifies one term's signal quality.
 *
 * @param {string} term - the base name / word being scored.
 * @param {string[]} zones - the full same-window TLD spread for this term
 *   (bare, no leading dot). Only used for the bulk-blast heuristic — a term
 *   is never penalized for spread alone, only for spread that skews heavily
 *   toward zones outside the six curated semantic groups.
 * @returns {{signal:'quality'|'mixed'|'noise', reasons:string[], digitsRatio:number, gibberish:boolean, bulkBlast:boolean, lexiconHit:string|null}}
 */
function classifyTermSignal(term, zones = []) {
  const reasons = [];
  const cleanZones = (zones || []).map(cleanTld).filter(Boolean);
  const dRatio = digitsRatio(term);
  const gibberish = isGibberishTerm(term);
  const lowerTerm = String(term || '').toLowerCase();
  const lexiconHit = ADULT_GAMBLING_LEXICON.find(w => lowerTerm.includes(w)) || null;

  const totalZones = cleanZones.length;
  const curatedZoneCount = cleanZones.filter(z => CURATED_GROUPS.has(semanticGroupForTld(z))).length;
  const otherZoneCount = totalZones - curatedZoneCount;
  const bulkBlast = totalZones >= BULK_BLAST_MIN_ZONES && otherZoneCount > totalZones / 2;

  if (dRatio >= 0.3) reasons.push(`digits ratio ${dRatio.toFixed(2)} >= 0.30`);
  if (gibberish) reasons.push('gibberish: length<3, repeated-char run, or no vowels');
  if (lexiconHit) reasons.push(`adult/gambling lexicon match: "${lexiconHit}"`);
  if (bulkBlast) reasons.push(`bulk-blast: same-day spread ${totalZones} zones, ${otherZoneCount} outside curated groups (majority)`);

  let signal = 'quality';
  if (bulkBlast || lexiconHit || dRatio >= 0.5 || (gibberish && dRatio > 0)) {
    signal = 'noise';
  } else if (dRatio >= 0.3 || gibberish) {
    signal = 'mixed';
  }

  return {
    signal,
    reasons,
    digitsRatio: Number(dRatio.toFixed(2)),
    gibberish,
    bulkBlast,
    lexiconHit,
  };
}

// ── Quality score ────────────────────────────────────────────────────────
// weightedSpread: curated-group zones (technical/commerce/health/finance/
// media/identity) count 3x toward spread vs 'geo'/'other' junk zones — a
// term in 6 curated zones outranks one scattered across 18 junk zones.
function weightedSpread(zones = []) {
  let total = 0;
  for (const z of zones) {
    total += CURATED_GROUPS.has(semanticGroupForTld(z)) ? 3 : 1;
  }
  return total;
}

// Real dictionary words (via the existing segmentBaseName helper) or clean
// pronounceable coinages score higher than digit/gibberish strings.
function termQualityMultiplier(term) {
  const dict = loadDictionary();
  if (!dict.size) {
    // Dictionary unavailable on this host: degrade to the gibberish heuristic
    // alone rather than silently flattening every term to the same score.
    return isGibberishTerm(term) ? 0.4 : 0.9;
  }
  const words = segmentBaseName(term);
  if (!words.length) return 0.4;
  const dictHits = words.filter(w => dict.has(w)).length;
  const coverageRatio = dictHits / words.length;
  if (coverageRatio === 1) return 1.5; // every segment is a real dictionary word
  if (coverageRatio >= 0.5) return 1.1; // partial real-word coverage
  if (!isGibberishTerm(term)) return 0.9; // clean pronounceable coinage
  return 0.4; // digit/gibberish string
}

function computeQualityScore(term, zones, momentum) {
  const spreadW = weightedSpread(zones);
  const momentumFactor = momentum == null ? 1 : Math.max(0.1, momentum);
  const qualityMult = termQualityMultiplier(term);
  return Number((spreadW * momentumFactor * qualityMult).toFixed(3));
}

// ── Zone-list elision ───────────────────────────────────────────────────────
// '.app, .dev, .io + 9 more' instead of enumerating a 50-zone spread inline —
// used by /insights statements and available to the frontend for the
// trending-table zone chips.
function elideZones(zones = [], max = 6) {
  const clean = (zones || []).map(z => cleanTld(z)).filter(Boolean);
  if (clean.length <= max) return clean.map(z => `.${z}`).join(', ');
  const shown = clean.slice(0, max).map(z => `.${z}`).join(', ');
  return `${shown} + ${clean.length - max} more`;
}

// ── Date helpers ─────────────────────────────────────────────────────────────
function isoDate(value, fallback) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}
function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function truthyFlag(value) {
  return value === '1' || value === 1 || value === true || value === 'true';
}

// ── One-time index migration (documented in DEPLOY-DOMAINLAB.md) ───────────
let _indexesEnsured = false;
function ensureDomainLabIndexes(db) {
  if (_indexesEnsured) return;
  try {
    // zone_daily_stats already has PK(tld, stat_date) — good for one TLD's
    // series, bad for "all TLDs on date X" scans the zone-health endpoint and
    // the data-through-date check need. zone_daily_stats is small (~1 row per
    // TLD per day since 2026-05-11, ~100K rows), so this index build is cheap
    // — nothing like the 65GB zone_names table.
    db.exec(`CREATE INDEX IF NOT EXISTS zi.idx_zone_daily_stats_date ON zone_daily_stats(stat_date, tld)`);
    _indexesEnsured = true;
  } catch (err) {
    // Do not latch on failure: at boot this can run before zi is attached, and
    // latching then would skip the migration for the whole process lifetime.
    console.warn('[DomainLab] index migration skipped:', err.message);
  }
}

// ── Core trend aggregation (shared by /trending and /insights) ─────────────
function fetchTrendRows(db, from, to) {
  const rows = db.prepare(`
    SELECT keyword, trend_date, tld_count, tlds_json
    FROM zi.zone_keyword_tld_history
    WHERE trend_date BETWEEN @from AND @to
    ORDER BY trend_date DESC, tld_count DESC
    LIMIT ${MAX_TREND_ROWS}
  `).all({ from, to });
  return { rows, capped: rows.length === MAX_TREND_ROWS };
}

function parseTlds(tldsJson) {
  try {
    const parsed = JSON.parse(tldsJson);
    return Array.isArray(parsed) ? parsed.map(t => String(t).toLowerCase().replace(/^\./, '')) : [];
  } catch (_) { return []; }
}

// ── Column sort (sortBy/sortDir) ────────────────────────────────────────────
// Strictly additive: only engages when params.sortBy names a recognized
// column. Sorting is applied to the FULL filtered array before the existing
// .slice(0, limit) in computeTrending, so a header click always yields the
// global top-N for that column rather than a client-side reshuffle of an
// already-paged set. When sortBy is absent or unrecognized, behavior
// (including legacy sort=spread) is byte-identical to before this feature.
const SORTABLE_TRENDING_COLUMNS = new Set([
  'term', 'signal', 'spread', 'momentum', 'qualityScore',
  'windowRegistrations', 'baselineRegistrations',
]);
// signal ranks quality > mixed > noise so a desc sort shows quality first.
const SIGNAL_QUALITY_RANK = { noise: 0, mixed: 1, quality: 2 };

function resolveTrendingColumnSort(params) {
  const sortBy = String(params.sortBy || '');
  if (!SORTABLE_TRENDING_COLUMNS.has(sortBy)) return null;
  const requestedDir = String(params.sortDir || '').toLowerCase();
  const defaultDir = sortBy === 'term' ? 'asc' : 'desc';
  const sortDir = requestedDir === 'asc' || requestedDir === 'desc' ? requestedDir : defaultDir;
  return { sortBy, sortDir };
}

// Comparator for one recognized column. momentum:null always sorts LAST in
// both directions. Ties fall through to tieBreaker (the existing qualitySort
// comparator), keeping ordering deterministic and consistent with the
// default ranking.
function compareTrendingColumn(a, b, sortBy, sortDir, tieBreaker) {
  let primary;
  if (sortBy === 'momentum') {
    const aNull = a.momentum == null;
    const bNull = b.momentum == null;
    if (aNull !== bNull) return aNull ? 1 : -1;
    if (aNull && bNull) return tieBreaker(a, b);
    const cmp = a.momentum - b.momentum;
    primary = sortDir === 'asc' ? cmp : -cmp;
  } else if (sortBy === 'term') {
    const cmp = a.term.localeCompare(b.term);
    primary = sortDir === 'asc' ? cmp : -cmp;
  } else if (sortBy === 'signal') {
    const ar = SIGNAL_QUALITY_RANK[a.signal] ?? -1;
    const br = SIGNAL_QUALITY_RANK[b.signal] ?? -1;
    const cmp = ar - br;
    primary = sortDir === 'asc' ? cmp : -cmp;
  } else {
    // spread, qualityScore, windowRegistrations, baselineRegistrations.
    const cmp = a[sortBy] - b[sortBy];
    primary = sortDir === 'asc' ? cmp : -cmp;
  }
  return primary !== 0 ? primary : tieBreaker(a, b);
}

/**
 * Aggregates zone_keyword_tld_history rows into per-term (or per-word, when
 * mode='words') cross-zone summaries with momentum, a noise/signal
 * classification, and a re-ranking qualityScore.
 *
 * Momentum formula (also returned in the response so it's never hidden):
 *   windowRate    = windowOccurrences / windowDays
 *   guardedBaselineOcc = baselineOccurrences < 3 ? baselineOccurrences + 1 : baselineOccurrences
 *                   (small-sample guard: a single sparse baseline day should
 *                   not produce an unbounded momentum ratio)
 *   baselineRate  = guardedBaselineOcc / baselineDays
 *   momentum      = windowRate / baselineRate (null when both rates are 0 —
 *                   no signal either way, not "no growth")
 *
 * qualityScore formula:
 *   qualityScore = weightedSpread(curated zones count 3x 'other'/'geo' zones)
 *                  * max(0.1, momentum ?? 1)
 *                  * termQualityMultiplier(dictionary-word coverage via
 *                    segmentBaseName, or the gibberish heuristic as a
 *                    pronounceable-coinage proxy)
 *
 * Default behavior (raw behavior fully preserved behind params):
 *   - noise-classified rows are excluded from `rows` unless includeNoise=1.
 *   - default sort is qualityScore desc; sort=spread restores the original
 *     coMovingGroup/momentum/spread ordering over the (still noise-included
 *     when includeNoise=1, still noise-excluded otherwise) row set.
 *
 * Column-sort params (strictly additive; only apply when sortBy names a
 * recognized column — otherwise behavior, including legacy sort=spread, is
 * byte-identical to the above):
 *   sortBy  - one of term/signal/spread/momentum/qualityScore/
 *             windowRegistrations/baselineRegistrations.
 *   sortDir - asc|desc. Defaults to asc for sortBy=term, desc otherwise.
 *             Invalid values fall back to the default. Sorting happens on the
 *             FULL filtered array before the limit slice. Echoed back as
 *             sortBy/sortDir (or null when not applied) in the response.
 */
function computeTrending(db, params = {}) {
  ensureDomainLabIndexes(db);
  const windowDays = clampInt(params.window, 7, 1, 90);
  const baselineDays = clampInt(params.baseline, 28, 1, 180);
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const minZones = clampInt(params.minZones, 0, 0, 50);
  const mode = params.mode === 'words' ? 'words' : 'terms';
  const q = String(params.q || '').trim().toLowerCase();
  const requestedZones = new Set(String(params.zones || '').split(',').map(z => cleanTld(z)).filter(Boolean));
  const requestedGroup = String(params.group || '').trim().toLowerCase();
  const includeNoise = truthyFlag(params.includeNoise);
  const includeAllZones = truthyFlag(params.includeAllZones);
  const sortMode = params.sort === 'spread' ? 'spread' : 'qualityScore';
  const columnSort = resolveTrendingColumnSort(params);

  const anchor = isoDate(
    db.prepare(`SELECT trend_date FROM zi.zone_keyword_tld_history ORDER BY trend_date DESC LIMIT 1`).get()?.trend_date,
    new Date().toISOString().slice(0, 10)
  );
  const windowTo = anchor;
  const windowFrom = addDays(windowTo, -(windowDays - 1));
  const baselineTo = addDays(windowFrom, -1);
  const baselineFrom = addDays(windowFrom, -baselineDays);

  const windowFetch = fetchTrendRows(db, windowFrom, windowTo);
  const baselineFetch = fetchTrendRows(db, baselineFrom, baselineTo);

  function buildAggregate(rows) {
    const agg = new Map();
    for (const row of rows) {
      const observedTlds = parseTlds(row.tlds_json);
      const tlds = includeAllZones ? observedTlds : observedTlds.filter(isActionableZone);
      if (!tlds.length) continue;
      const keys = mode === 'words' ? [...new Set(segmentBaseName(row.keyword))] : [row.keyword];
      for (const key of keys) {
        if (!key) continue;
        if (!agg.has(key)) agg.set(key, {
          occurrences: 0,
          zoneDayCounts: new Map(),
          sourceTerms: new Set(),
          sourceTermZones: new Map(),
        });
        const entry = agg.get(key);
        entry.occurrences += 1;
        entry.sourceTerms.add(row.keyword);
        if (!entry.sourceTermZones.has(row.keyword)) entry.sourceTermZones.set(row.keyword, new Set());
        for (const tld of tlds) {
          entry.zoneDayCounts.set(tld, (entry.zoneDayCounts.get(tld) || 0) + 1);
          entry.sourceTermZones.get(row.keyword).add(tld);
        }
      }
    }
    return agg;
  }

  const windowAgg = buildAggregate(windowFetch.rows);
  const baselineAgg = buildAggregate(baselineFetch.rows);

  const results = [];
  for (const [key, entry] of windowAgg.entries()) {
    const zones = [...entry.zoneDayCounts.keys()].sort();
    if (!zones.length) continue;
    if (q && !key.includes(q)) continue;
    if (requestedZones.size && !zones.some(z => requestedZones.has(z))) continue;

    const groupsHit = new Map(); // group -> zones[]
    for (const zone of zones) {
      const group = semanticGroupForTld(zone);
      if (!groupsHit.has(group)) groupsHit.set(group, []);
      groupsHit.get(group).push(zone);
    }
    if (requestedGroup && !groupsHit.has(requestedGroup)) continue;
    if (zones.length < minZones) continue;

    const baselineEntry = baselineAgg.get(key);
    const baselineOccurrences = baselineEntry ? baselineEntry.occurrences : 0;
    const windowRate = entry.occurrences / windowDays;
    const guardedBaselineOcc = baselineOccurrences < MIN_BASELINE_SAMPLE ? baselineOccurrences + 1 : baselineOccurrences;
    const baselineRate = guardedBaselineOcc / baselineDays;
    const momentum = baselineRate > 0 ? Number((windowRate / baselineRate).toFixed(2)) : (windowRate > 0 ? null : 0);

    const coMovingGroup = [...groupsHit.entries()].find(([, zoneList]) => zoneList.length >= 2) || null;

    const classification = classifyTermSignal(key, zones);
    const qualityScore = computeQualityScore(key, zones, momentum);
    const sourceDomains = [...entry.sourceTermZones.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([sourceTerm, sourceZones]) => [...sourceZones]
        .sort()
        .map(zone => `${sourceTerm}.${zone}`));

    results.push({
      term: key,
      mode,
      sourceTerms: mode === 'words' ? [...entry.sourceTerms].sort() : undefined,
      sourceDomains: sourceDomains.slice(0, 500),
      sourceDomainCount: sourceDomains.length,
      spread: zones.length,
      zones,
      semanticGroups: [...groupsHit.keys()].sort(),
      groupZones: Object.fromEntries([...groupsHit.entries()]),
      windowRegistrations: entry.occurrences,
      windowByZone: Object.fromEntries(entry.zoneDayCounts),
      baselineRegistrations: baselineOccurrences,
      lowBaselineConfidence: baselineOccurrences < MIN_BASELINE_SAMPLE,
      momentum,
      coMovingGroup: coMovingGroup ? { group: coMovingGroup[0], zones: coMovingGroup[1] } : null,
      worthWatching: Boolean(coMovingGroup) && (momentum == null || momentum >= 1.5) && entry.occurrences >= 2,
      signal: classification.signal,
      signalReasons: classification.reasons,
      qualityScore,
    });
  }

  function legacySort(a, b) {
    if (Boolean(a.coMovingGroup) !== Boolean(b.coMovingGroup)) return a.coMovingGroup ? -1 : 1;
    const am = a.momentum == null ? -1 : a.momentum;
    const bm = b.momentum == null ? -1 : b.momentum;
    if (bm !== am) return bm - am;
    if (b.spread !== a.spread) return b.spread - a.spread;
    return a.term.localeCompare(b.term);
  }
  function qualitySort(a, b) {
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    return legacySort(a, b);
  }

  const filtered = includeNoise ? results : results.filter(r => r.signal !== 'noise');
  if (columnSort) {
    filtered.sort((a, b) => compareTrendingColumn(a, b, columnSort.sortBy, columnSort.sortDir, qualitySort));
  } else {
    filtered.sort(sortMode === 'spread' ? legacySort : qualitySort);
  }

  return {
    anchor,
    window: { from: windowFrom, to: windowTo, days: windowDays },
    baseline: { from: baselineFrom, to: baselineTo, days: baselineDays },
    rows: filtered.slice(0, limit),
    total: filtered.length,
    capped: windowFetch.capped || baselineFetch.capped,
    momentumFormula: 'momentum = (windowOccurrences/windowDays) / (guardedBaselineOccurrences/baselineDays); guardedBaselineOccurrences = baselineOccurrences<3 ? baselineOccurrences+1 : baselineOccurrences (small-sample guard)',
    qualityScoreFormula: 'qualityScore = weightedSpread(curated-group zones count 3x other/geo zones) * max(0.1, momentum ?? 1) * termQualityMultiplier(dictionary-word coverage or pronounceable-coinage heuristic)',
    includeNoise,
    includeAllZones,
    sort: sortMode,
    sortBy: columnSort ? columnSort.sortBy : null,
    sortDir: columnSort ? columnSort.sortDir : null,
  };
}

// ── Route registration ──────────────────────────────────────────────────────
// ── Daily token capture views (DomainLab v3a) ────────────────────────
// Reads zone_daily_tokens / zone_daily_new_names (populated by
// server/zone-indexer.js recordZoneDailyTokens(), called from scrapers/czds.js
// after each CZDS diff). Only-index-backed queries: zone_daily_tokens is keyed
// (tld, report_date, token) WITHOUT ROWID with extra indexes on
// (report_date, tld, reg_count DESC) and (token); zone_daily_new_names is keyed
// (tld, report_date, base_name) WITHOUT ROWID with an index on (report_date, tld).
// The distinct-dates scan walks the (report_date, tld, reg_count) index across
// every row for every date (~2.4M rows for 30 days) — ~1s idle and 5s+ under
// background writer load, per request. The date list only changes when an
// import lands (nightly), so serve it from a short TTL cache.
let _dailyDatesCache = null; // { ts, dates }
const DAILY_DATES_TTL_MS = 5 * 60_000;
function getDailyDates(db) {
  if (_dailyDatesCache && Date.now() - _dailyDatesCache.ts < DAILY_DATES_TTL_MS) {
    return _dailyDatesCache.dates;
  }
  // Recursive max-seek loop: one index seek per distinct date instead of a
  // DISTINCT walk over every row (~5s on 2.4M rows; ~1ms this way).
  const dates = db.prepare(`
    WITH RECURSIVE d(x) AS (
      SELECT MAX(report_date) FROM zi.zone_daily_tokens
      UNION ALL
      SELECT (SELECT MAX(report_date) FROM zi.zone_daily_tokens WHERE report_date < x)
      FROM d WHERE x IS NOT NULL
    )
    SELECT x AS report_date FROM d WHERE x IS NOT NULL ORDER BY x DESC LIMIT 60
  `).all().map(r => r.report_date);
  // An empty list is not cached so a first import shows up immediately.
  if (dates.length) _dailyDatesCache = { ts: Date.now(), dates };
  return dates;
}

function computeDailyTokens(db, params = {}) {
  ensureDomainLabIndexes(db);
  const availableDates = getDailyDates(db);

  if (!availableDates.length) {
    return { dataThrough: null, dates: [], date: null, zone: null, zones: [], tokens: [], totalTokens: 0, limit: 0, offset: 0 };
  }

  const date = isoDate(params.date, availableDates[0]);
  const zone = params.zone ? cleanTld(params.zone) : '';
  const q = String(params.q || '').trim().toLowerCase();
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(params.offset, 0, 0, 1000000);
  const includeAllZones = truthyFlag(params.includeAllZones);
  const wordSet = new Set(
    String(params.words || '')
      .split(',')
      .map(w => parseInt(w, 10))
      .filter(n => [1, 2, 3].includes(n))
  );

  const zoneRows = db.prepare(`
    SELECT tld, COUNT(DISTINCT token) AS tokenCount, SUM(reg_count) AS regCount
    FROM zi.zone_daily_tokens
    WHERE report_date = ?
    GROUP BY tld
    ORDER BY regCount DESC, tld ASC
  `).all(date);

  const whereParts = ['report_date = @date'];
  const sqlParams = { date };
  if (zone) { whereParts.push('tld = @zone'); sqlParams.zone = zone; }
  if (wordSet.size) {
    const placeholders = [...wordSet].map((w, i) => { sqlParams[`w${i}`] = w; return `@w${i}`; }).join(',');
    whereParts.push(`word_count IN (${placeholders})`);
  }
  if (q) { whereParts.push('token LIKE @q'); sqlParams.q = `%${q}%`; }
  const whereSql = whereParts.join(' AND ');

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT token FROM zi.zone_daily_tokens WHERE ${whereSql} GROUP BY token
    )
  `).get(sqlParams);

  const tokenRows = db.prepare(`
    SELECT token, MAX(word_count) AS wordCount, SUM(reg_count) AS count
    FROM zi.zone_daily_tokens
    WHERE ${whereSql}
    GROUP BY token
    ORDER BY count DESC, token ASC
    LIMIT @limit OFFSET @offset
  `).all({ ...sqlParams, limit, offset });

  return {
    dataThrough: availableDates[0],
    dates: availableDates,
    date,
    zone: zone ? `.${zone}` : null,
    zones: zoneRows
      .filter(r => includeAllZones || isActionableZone(r.tld))
      .sort((a, b) => zoneRelevanceRank(a.tld) - zoneRelevanceRank(b.tld) || b.regCount - a.regCount || a.tld.localeCompare(b.tld))
      .map(r => ({ tld: `.${r.tld}`, tokenCount: r.tokenCount, regCount: r.regCount, actionable: isActionableZone(r.tld) })),
    includeAllZones,
    tokens: tokenRows.map(r => ({ token: r.token, wordCount: r.wordCount, count: r.count })),
    totalTokens: totalRow?.n || 0,
    limit,
    offset,
  };
}

// Reads zone_daily_new_names filtered by (report_date, tld) — index-backed —
// then matches token containment against the base_name plus its dictionary
// segmentation. This per-(tld,date) row set is bounded (one day's new names
// for one zone), so the substring/segmentation pass is a cheap in-memory
// filter over an already index-narrowed set, not a table scan.
function computeDailyDomains(db, params = {}) {
  ensureDomainLabIndexes(db);
  const date = isoDate(params.date, null);
  const zone = params.zone ? cleanTld(params.zone) : '';
  const token = String(params.token || '').trim().toLowerCase();
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(params.offset, 0, 0, 1000000);

  if (!date || !zone || !token) {
    return { date: date || null, zone: zone ? `.${zone}` : null, token, names: [], total: 0, limit, offset };
  }

  const rows = db.prepare(`
    SELECT base_name FROM zi.zone_daily_new_names
    WHERE report_date = ? AND tld = ?
    ORDER BY base_name ASC
  `).all(date, zone);

  const matches = rows
    .map(r => r.base_name)
    .filter(baseName => {
      if (baseName.includes(token)) return true;
      let words = [];
      try { words = segmentBaseName(baseName) || []; } catch (_) { words = []; }
      return words.includes(token);
    });

  const total = matches.length;
  const page = matches.slice(offset, offset + limit);

  return {
    date,
    zone: `.${zone}`,
    token,
    names: page.map(baseName => `${baseName}.${zone}`),
    total,
    limit,
    offset,
  };
}


function ensureZoneIndexAttached(database) {
  try {
    database.prepare('SELECT 1 FROM zi.zone_indexed_tlds LIMIT 1').get();
    return true;
  } catch {
    try {
      const zoneDbPath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data'), 'zone_index.db');
      database.exec(`ATTACH DATABASE '${zoneDbPath}' AS zi`);
      return true;
    } catch (err) {
      if (String(err.message || '').includes('already')) return true;
      return false;
    }
  }
}

function registerDomainLabRoutes(app, { db }) {
  try { db.pragma('busy_timeout = 5000'); } catch (e) { /* keep default */ }
  app.use('/api/domainlab', (req, res, next) => { if (!ensureZoneIndexAttached(db)) return res.status(503).json({ ok: false, error: 'zone index unavailable' }); next(); });
  ensureDomainLabIndexes(db);

  app.get('/api/domainlab/trending', (req, res) => {
    try {
      const result = computeTrending(db, req.query);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[DomainLab] /trending error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/domainlab/term/:term', (req, res) => {
    try {
      const term = String(req.params.term || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80);
      if (!term) return res.status(400).json({ ok: false, error: 'term required' });
      const history = getKeywordTrendHistory(term);
      const liveDomains = db.prepare(`SELECT tld FROM zi.zone_names WHERE base_name = ? ORDER BY tld LIMIT 200`)
        .all(term).map(r => `${term}${r.tld}`);
      const summary = db.prepare(`SELECT tld_count, tld_list, updated_at FROM zi.name_summary WHERE base_name = ?`).get(term) || null;
      res.json({
        ok: true,
        term,
        history: history.dates,
        currentZones: history.currentTlds,
        exampleLiveDomains: liveDomains,
        crossTldOwnership: summary,
        words: segmentBaseName(term),
      });
    } catch (err) {
      console.error('[DomainLab] /term error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/domainlab/zones', (req, res) => {
    try {
      ensureDomainLabIndexes(db);
      const days = clampInt(req.query.window, 28, 1, 90);
      const latest = db.prepare(`SELECT stat_date FROM zi.zone_daily_stats ORDER BY stat_date DESC LIMIT 1`).get()?.stat_date
        || new Date().toISOString().slice(0, 10);
      const from = addDays(latest, -(days - 1));
      const rows = db.prepare(`
        SELECT tld, stat_date, total_count, new_count, dropped_count, had_previous
        FROM zi.zone_daily_stats
        WHERE stat_date BETWEEN ? AND ?
        ORDER BY tld, stat_date
      `).all(from, latest);
      const indexed = new Map(db.prepare(`SELECT tld, file_date, record_count FROM zi.zone_indexed_tlds`).all().map(r => [r.tld, r]));

      const byTld = new Map();
      for (const row of rows) {
        if (!byTld.has(row.tld)) byTld.set(row.tld, []);
        byTld.get(row.tld).push({ date: row.stat_date, total: row.total_count, added: row.new_count, dropped: row.dropped_count, hadPrevious: !!row.had_previous });
      }
      const zones = [...byTld.entries()].map(([tld, series]) => ({
        tld,
        semanticGroup: semanticGroupForTld(tld),
        actionable: isActionableZone(tld),
        indexed: indexed.get(tld) || null,
        series,
      })).sort((a, b) => zoneRelevanceRank(a.tld) - zoneRelevanceRank(b.tld) || a.tld.localeCompare(b.tld));

      res.json({ ok: true, dataThrough: latest, window: { from, to: latest, days }, zones, indexedTldCount: indexed.size });
    } catch (err) {
      console.error('[DomainLab] /zones error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/domainlab/insights', (req, res) => {
    try {
      // Pull the full noise-included population internally so /insights can
      // apply its own quality/mixed filter (never noise) rather than double
      // filtering through /trending's default — keeps this endpoint's
      // behavior self-documenting.
      const trend = computeTrending(db, { ...req.query, limit: 500, includeNoise: '1' });
      const candidates = trend.rows.filter(row => row.signal !== 'noise' && (row.coMovingGroup || (row.momentum != null && row.momentum >= 2)));
      const insights = candidates.map(row => {
        const baselinePerWeek = Number(((row.baselineRegistrations / trend.baseline.days) * 7).toFixed(1));
        const momentumText = row.momentum == null ? 'no comparable baseline yet' : `${row.momentum}x baseline rate`;
        let statement = row.coMovingGroup
          ? `"${row.term}" rose in ${elideZones(row.coMovingGroup.zones)} (${row.coMovingGroup.group} extensions): ${row.windowRegistrations} same-day multi-TLD registrations this window vs baseline ${baselinePerWeek}/wk (${momentumText}).`
          : `"${row.term}" is trending across ${row.spread} zones (${elideZones(row.zones)}): ${row.windowRegistrations} same-day multi-TLD registrations this window vs baseline ${baselinePerWeek}/wk (${momentumText}).`;
        if (statement.length > 240) statement = `${statement.slice(0, 237)}...`;
        return {
          term: row.term,
          statement,
          signal: row.signal,
          qualityScore: row.qualityScore,
          strength: row.qualityScore + (row.coMovingGroup ? 5 : 0),
          coMovingGroup: row.coMovingGroup,
          windowRegistrations: row.windowRegistrations,
          baselineRegistrations: row.baselineRegistrations,
          baselinePerWeek,
          momentum: row.momentum,
          zones: row.zones,
        };
      }).sort((a, b) => b.strength - a.strength)
        .slice(0, clampInt(req.query.limit, 25, 1, 100));

      res.json({ ok: true, anchor: trend.anchor, window: trend.window, baseline: trend.baseline, insights, momentumFormula: trend.momentumFormula, qualityScoreFormula: trend.qualityScoreFormula });
    } catch (err) {
      console.error('[DomainLab] /insights error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/domainlab/daily', (req, res) => {
    try {
      const result = computeDailyTokens(db, req.query);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[DomainLab] /daily error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/domainlab/daily/domains', (req, res) => {
    try {
      const result = computeDailyDomains(db, req.query);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[DomainLab] /daily/domains error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  ZONE_SEMANTIC_GROUPS,
  CURATED_GROUPS,
  semanticGroupForTld,
  isActionableZone,
  zoneRelevanceRank,
  segmentBaseName,
  tokenizeDailyLabel,
  classifyTermSignal,
  computeQualityScore,
  weightedSpread,
  termQualityMultiplier,
  elideZones,
  computeTrending,
  computeDailyTokens,
  computeDailyDomains,
  ensureDomainLabIndexes,
  registerDomainLabRoutes,
};
