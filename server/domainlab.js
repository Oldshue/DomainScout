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
 */

const fs = require('fs');
const { getKeywordTrendHistory } = require('./zone-indexer');

const MAX_TREND_ROWS = 200000; // mirrors CZDS_TREND_RETURN_LIMIT default in zone-indexer.js
const MIN_BASELINE_SAMPLE = 3;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ── Zone semantic groups ────────────────────────────────────────────────────
// Extend this map to teach DomainLab new cross-zone families. Any TLD not
// listed and not a bare 2-letter ccTLD falls into 'other'.
const ZONE_SEMANTIC_GROUPS = {
  technical: ['dev', 'app', 'io', 'sh', 'tech', 'ai', 'codes', 'cloud'],
  commerce: ['shop', 'store', 'buy', 'market'],
  health: ['health', 'care', 'med', 'clinic'],
  finance: ['finance', 'money', 'capital', 'fund', 'loan'],
  media: ['tv', 'media', 'video', 'stream'],
  identity: ['me', 'name', 'id', 'bio'],
};

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

// ── Dictionary phrase segmentation ──────────────────────────────────────────
const DICT_PATH = '/usr/share/dict/words';
const MAX_SEGMENT_LEN = 24;
let _dict = null;

function loadDictionary() {
  if (_dict) return _dict;
  _dict = new Set();
  try {
    const raw = fs.readFileSync(DICT_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const word = line.trim().toLowerCase();
      if (word.length >= 2 && /^[a-z]+$/.test(word)) _dict.add(word);
    }
    console.log(`[DomainLab] loaded ${_dict.size.toLocaleString()} dictionary words from ${DICT_PATH}`);
  } catch (err) {
    console.warn(`[DomainLab] dictionary unavailable at ${DICT_PATH} (${err.message}); word-mode segmentation degrades to whole tokens`);
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
  } catch (err) {
    console.warn('[DomainLab] index migration skipped:', err.message);
  }
  _indexesEnsured = true;
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

/**
 * Aggregates zone_keyword_tld_history rows into per-term (or per-word, when
 * mode='words') cross-zone summaries with momentum.
 *
 * Momentum formula (also returned in the response so it's never hidden):
 *   windowRate    = windowOccurrences / windowDays
 *   guardedBaselineOcc = baselineOccurrences < 3 ? baselineOccurrences + 1 : baselineOccurrences
 *                   (small-sample guard: a single sparse baseline day should
 *                   not produce an unbounded momentum ratio)
 *   baselineRate  = guardedBaselineOcc / baselineDays
 *   momentum      = windowRate / baselineRate (null when both rates are 0 —
 *                   no signal either way, not "no growth")
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
      const tlds = parseTlds(row.tlds_json);
      const keys = mode === 'words' ? [...new Set(segmentBaseName(row.keyword))] : [row.keyword];
      for (const key of keys) {
        if (!key) continue;
        if (!agg.has(key)) agg.set(key, { occurrences: 0, zoneDayCounts: new Map(), sourceTerms: new Set() });
        const entry = agg.get(key);
        entry.occurrences += 1;
        entry.sourceTerms.add(row.keyword);
        for (const tld of tlds) entry.zoneDayCounts.set(tld, (entry.zoneDayCounts.get(tld) || 0) + 1);
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

    results.push({
      term: key,
      mode,
      sourceTerms: mode === 'words' ? [...entry.sourceTerms].sort() : undefined,
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
    });
  }

  results.sort((a, b) => {
    if (Boolean(a.coMovingGroup) !== Boolean(b.coMovingGroup)) return a.coMovingGroup ? -1 : 1;
    const am = a.momentum == null ? -1 : a.momentum;
    const bm = b.momentum == null ? -1 : b.momentum;
    if (bm !== am) return bm - am;
    if (b.spread !== a.spread) return b.spread - a.spread;
    return a.term.localeCompare(b.term);
  });

  return {
    anchor,
    window: { from: windowFrom, to: windowTo, days: windowDays },
    baseline: { from: baselineFrom, to: baselineTo, days: baselineDays },
    rows: results.slice(0, limit),
    total: results.length,
    capped: windowFetch.capped || baselineFetch.capped,
    momentumFormula: 'momentum = (windowOccurrences/windowDays) / (guardedBaselineOccurrences/baselineDays); guardedBaselineOccurrences = baselineOccurrences<3 ? baselineOccurrences+1 : baselineOccurrences (small-sample guard)',
  };
}

// ── Route registration ──────────────────────────────────────────────────────
function registerDomainLabRoutes(app, { db }) {
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
        indexed: indexed.get(tld) || null,
        series,
      })).sort((a, b) => a.tld.localeCompare(b.tld));

      res.json({ ok: true, dataThrough: latest, window: { from, to: latest, days }, zones, indexedTldCount: indexed.size });
    } catch (err) {
      console.error('[DomainLab] /zones error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/domainlab/insights', (req, res) => {
    try {
      const trend = computeTrending(db, { ...req.query, limit: 500 });
      const candidates = trend.rows.filter(row => row.coMovingGroup || (row.momentum != null && row.momentum >= 2));
      const insights = candidates.map(row => {
        const baselinePerWeek = Number(((row.baselineRegistrations / trend.baseline.days) * 7).toFixed(1));
        const momentumText = row.momentum == null ? 'no comparable baseline yet' : `${row.momentum}x baseline rate`;
        const statement = row.coMovingGroup
          ? `"${row.term}" rose in ${row.coMovingGroup.zones.map(z => `.${z}`).join(' and ')} (${row.coMovingGroup.group} extensions): ${row.windowRegistrations} same-day multi-TLD registrations this window vs baseline ${baselinePerWeek}/wk (${momentumText}).`
          : `"${row.term}" is trending across ${row.spread} zones (${row.zones.map(z => `.${z}`).join(', ')}): ${row.windowRegistrations} same-day multi-TLD registrations this window vs baseline ${baselinePerWeek}/wk (${momentumText}).`;
        return {
          term: row.term,
          statement,
          strength: (row.momentum || 0) * row.spread + (row.coMovingGroup ? 5 : 0),
          coMovingGroup: row.coMovingGroup,
          windowRegistrations: row.windowRegistrations,
          baselineRegistrations: row.baselineRegistrations,
          baselinePerWeek,
          momentum: row.momentum,
          zones: row.zones,
        };
      }).sort((a, b) => b.strength - a.strength)
        .slice(0, clampInt(req.query.limit, 25, 1, 100));

      res.json({ ok: true, anchor: trend.anchor, window: trend.window, baseline: trend.baseline, insights, momentumFormula: trend.momentumFormula });
    } catch (err) {
      console.error('[DomainLab] /insights error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  ZONE_SEMANTIC_GROUPS,
  semanticGroupForTld,
  segmentBaseName,
  computeTrending,
  ensureDomainLabIndexes,
  registerDomainLabRoutes,
};
