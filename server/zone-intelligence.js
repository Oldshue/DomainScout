'use strict';

const { computeDomainQuality } = require('./domain-quality');

const MAX_RANGE_DAYS = 31;
const MAX_SOURCE_ROWS = 50000;
const FAVORITE_EXPORT_FIELDS = ['domain', 'mode', 'score', 'source', 'freshness'];

function isoDate(value, fallback = '') {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function addDays(date, delta) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
}

function boundedRange(fromValue, toValue, today = new Date().toISOString().slice(0, 10)) {
  let to = isoDate(toValue, today);
  let from = isoDate(fromValue, addDays(to, -6));
  if (from > to) [from, to] = [to, from];
  const span = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (span > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
  return { from, to, days: Math.min(span, MAX_RANGE_DAYS) };
}

function baseName(row) {
  if (row && row.base_name) return String(row.base_name).toLowerCase();
  return String(row?.domain || '').toLowerCase().split('.')[0];
}

function tokenizeBase(value) {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!clean) return [];
  return [...new Set(clean.split(/-+/).flatMap(part => part.match(/[a-z]{2,}/g) || []).filter(Boolean))];
}

function dateSeries(from, to) {
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function aggregateTokenMovement(events, range, priorEvents = []) {
  const dates = dateSeries(range.from, range.to);
  function aggregate(rows, includeHistory) {
    const tokens = new Map();
    for (const event of rows || []) {
      const tokensForEvent = event.token ? [String(event.token).toLowerCase()] : tokenizeBase(baseName(event));
      const additions = Math.max(0, Number(event.additions ?? (event.kind === 'drop' ? 0 : 1)) || 0);
      const drops = Math.max(0, Number(event.drops ?? (event.kind === 'drop' ? 1 : 0)) || 0);
      for (const token of tokensForEvent) {
        if (!tokens.has(token)) tokens.set(token, { token, additions: 0, drops: 0, domains: new Set(), sources: new Set(), history: Object.fromEntries(dates.map(date => [date, 0])) });
        const item = tokens.get(token);
        item.additions += additions;
        item.drops += drops;
        if (event.domain) item.domains.add(String(event.domain));
        if (event.source) item.sources.add(String(event.source));
        if (includeHistory && Object.hasOwn(item.history, event.event_date)) item.history[event.event_date] += additions - drops;
      }
    }
    return tokens;
  }
  const current = aggregate(events, true);
  const prior = aggregate(priorEvents, false);
  const priorRank = new Map([...prior.values()]
    .sort((a, b) => (b.additions - b.drops) - (a.additions - a.drops) || b.additions - a.additions || a.token.localeCompare(b.token))
    .map((item, index) => [item.token, index + 1]));
  const ranked = [...current.values()]
    .sort((a, b) => (b.additions - b.drops) - (a.additions - a.drops) || b.additions - a.additions || a.token.localeCompare(b.token));
  return ranked.map((item, index) => {
    const rank = index + 1;
    const previousRank = priorRank.get(item.token) || null;
    return {
      token: item.token, additions: item.additions, drops: item.drops, net: item.additions - item.drops,
      rank, previousRank, rankChange: previousRank == null ? null : previousRank - rank,
      domainCount: item.domains.size, sources: [...item.sources].sort(),
      sparkline: dates.map(date => item.history[date]), dates,
    };
  });
}

function inferredWordCount(base) {
  const clean = String(base || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(clean)) return { count: null, supported: false };
  if (clean.includes('-')) return { count: clean.split(/-+/).filter(Boolean).length, supported: true };
  return { count: 1, supported: true };
}

function filterDroppingDomains(rows, filters = {}) {
  const keyword = String(filters.keyword || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const mode = ['starts', 'ends', 'contains'].includes(filters.keywordMode) ? filters.keywordMode : 'contains';
  const minLength = Number(filters.minLength) || 0;
  const maxLength = Number(filters.maxLength) || Infinity;
  const wordCount = Number(filters.wordCount) || 0;
  const requestedTld = String(filters.tld || '').trim().toLowerCase();
  const tld = requestedTld ? (requestedTld.startsWith('.') ? requestedTld : `.${requestedTld}`) : '';
  return (rows || []).filter(row => {
    const base = baseName(row);
    const length = Number(row.length) || base.length;
    if (length < minLength || length > maxLength) return false;
    if (filters.noHyphens && base.includes('-')) return false;
    if (filters.noNumbers && /\d/.test(base)) return false;
    if (tld && String(row.tld || '').toLowerCase() !== tld) return false;
    if (keyword && ((mode === 'starts' && !base.startsWith(keyword)) || (mode === 'ends' && !base.endsWith(keyword)) || (mode === 'contains' && !base.includes(keyword)))) return false;
    if (wordCount) {
      const observed = inferredWordCount(base);
      if (!observed.supported || observed.count !== wordCount) return false;
    }
    return true;
  });
}

function rankGem(row) {
  const quality = Number.isFinite(Number(row.quality_score))
    ? { quality_score: Number(row.quality_score), quality_reasons: row.quality_reasons || '' }
    : computeDomainQuality(row);
  const evidence = [];
  let observedBonus = 0;
  const tldsTaken = Number(row.tlds_taken);
  if (Number.isFinite(tldsTaken) && tldsTaken > 0) { observedBonus += Math.min(60, Math.round(Math.log2(tldsTaken + 1) * 12)); evidence.push(`${tldsTaken} sibling TLDs observed taken`); }
  else evidence.push('sibling demand evidence missing');
  const age = Number(row.age_years);
  if (Number.isFinite(age) && age > 0) { observedBonus += Math.min(30, age * 2); evidence.push(`${age} years observed age`); }
  else evidence.push('age evidence missing');
  const wayback = Number(row.wayback_snapshots);
  if (Number.isFinite(wayback) && wayback > 0) { observedBonus += Math.min(30, Math.round(Math.log10(wayback + 1) * 15)); evidence.push(`${wayback} archived snapshots`); }
  else evidence.push('archive evidence missing');
  return {
    ...row, qualityScore: quality.quality_score, qualityReasons: quality.quality_reasons,
    observedMarketBonus: observedBonus, gemScore: quality.quality_score + observedBonus, evidence,
    formula: 'gemScore = existing qualityScore + sibling bonus (0..60) + age bonus (0..30) + archive bonus (0..30)',
  };
}

function rankGems(rows) {
  return (rows || []).map(rankGem).sort((a, b) => b.gemScore - a.gemScore || String(a.domain).localeCompare(String(b.domain)));
}

function classifyAvailabilityGap(row, nowMs = Date.now(), maxAgeMs = 48 * 3600000) {
  const availabilityMs = Date.parse(row.com_availability_checked_at || '');
  const siblingMs = Date.parse(row.com_checked_at || '');
  const availabilityFresh = Number.isFinite(availabilityMs) && nowMs - availabilityMs <= maxAgeMs;
  const siblingFresh = Number.isFinite(siblingMs) && nowMs - siblingMs <= maxAgeMs;
  const registrationAvailable = row.com_registration_available === 1 || row.com_registration_available === '1';
  const registrationUnavailable = row.com_registration_available === 0 || row.com_registration_available === '0';
  let comState = 'unknown';
  if (availabilityFresh && registrationAvailable) comState = 'confirmed-available';
  else if ((availabilityFresh && registrationUnavailable) || (siblingFresh && row.com_status === 'taken')) comState = 'taken';
  return {
    ...row, comState,
    coverage: {
      target: '.com',
      complete: availabilityFresh && (registrationAvailable || registrationUnavailable),
      availabilityCheckedAt: row.com_availability_checked_at || null,
      availabilitySource: row.com_availability_source || null,
      siblingStatus: siblingFresh ? row.com_status || null : null,
      siblingCheckedAt: row.com_checked_at || null,
      siblingSource: row.com_source || null,
    },
    gap: comState === 'confirmed-available',
    reason: comState === 'confirmed-available'
      ? 'fresh decisive .com registration-availability evidence'
      : comState === 'taken'
        ? 'fresh .com unavailable or registered evidence'
        : 'unknown: no fresh decisive .com registration-availability evidence',
  };
}

function parseLimit(value, fallback = 250) {
  return Math.min(1000, Math.max(1, parseInt(value || fallback, 10) || fallback));
}

function safeAll(database, sql, params) {
  try { return { rows: database.prepare(sql).all(params), error: null }; }
  catch (error) { return { rows: [], error: error.message }; }
}

function eventRangeParams(from, to) {
  return {
    fromAt: `${from}T00:00:00.000Z`,
    toAt: `${addDays(to, 1)}T00:00:00.000Z`,
  };
}

function movementEvents(database, from, to) {
  const additions = safeAll(database, `SELECT keyword AS token, trend_date AS event_date, tld_count AS additions, 0 AS drops, 'zone-keyword-daily-diff' AS source FROM zi.zone_keyword_trends WHERE trend_date BETWEEN @from AND @to ORDER BY trend_date DESC, tld_count DESC LIMIT ${MAX_SOURCE_ROWS}`, { from, to });
  const drops = safeAll(database, `SELECT domain, base_name, tld, substr(source_event_at, 1, 10) AS event_date, 'drop' AS kind, source FROM drop_events WHERE source_event_at >= @fromAt AND source_event_at < @toAt ORDER BY source_event_at DESC LIMIT ${MAX_SOURCE_ROWS}`, eventRangeParams(from, to));
  return { events: [...additions.rows, ...drops.rows], errors: [additions.error, drops.error].filter(Boolean), capped: additions.rows.length === MAX_SOURCE_ROWS || drops.rows.length === MAX_SOURCE_ROWS };
}

function tokenDomainRows(database, token, from, to, limit) {
  const zone = safeAll(database, `SELECT @token || tld AS domain, @token AS base_name, tld, NULL AS event_date, 'current-zone-name' AS kind, 'current zone index' AS source FROM zi.zone_names WHERE base_name=@token ORDER BY tld LIMIT @limit`, { token, limit });
  const drops = safeAll(database, `SELECT domain, base_name, tld, substr(source_event_at, 1, 10) AS event_date, 'drop' AS kind, source FROM drop_events WHERE base_name=@token AND source_event_at >= @fromAt AND source_event_at < @toAt ORDER BY source_event_at DESC LIMIT @limit`, { token, limit, ...eventRangeParams(from, to) });
  const unique = new Map();
  for (const row of [...zone.rows, ...drops.rows]) if (!unique.has(row.domain)) unique.set(row.domain, row);
  return { rows: [...unique.values()].slice(0, limit), errors: [zone.error, drops.error].filter(Boolean) };
}

function dropRows(database, from, to) {
  return safeAll(database, `SELECT e.domain, e.base_name, e.tld, e.source, e.source_kind, e.source_event_at AS drop_date, e.registration_available, e.availability_source, e.availability_checked_at, d.length, d.has_numbers, d.has_hyphens, d.quality_score, d.quality_reasons, d.tlds_taken, d.age_years, d.wayback_snapshots, d.auction_url FROM drop_events e LEFT JOIN domains d ON d.id = (SELECT id FROM domains WHERE domain=e.domain ORDER BY discovered_at DESC LIMIT 1) WHERE e.source_event_at >= @fromAt AND e.source_event_at < @toAt ORDER BY e.source_event_at DESC LIMIT ${MAX_SOURCE_ROWS}`, eventRangeParams(from, to));
}

function evaluateDropCoverage(catalogRows, coverageRows, range) {
  const expected = [];
  for (const source of catalogRows || []) {
    for (const date of dateSeries(range.from, range.to)) {
      if (!source.coverage_started_on || source.coverage_started_on <= date) expected.push(`${source.tld}|${source.source}|${date}`);
    }
  }
  const statuses = new Map((coverageRows || []).map(row => [`${row.tld}|${row.source}|${row.coverage_date}`, row.status]));
  const missing = expected.filter(key => !statuses.has(key));
  const incomplete = expected.filter(key => statuses.has(key) && statuses.get(key) !== 'complete');
  return {
    complete: expected.length > 0 && !missing.length && !incomplete.length,
    expectedReceipts: expected.length,
    observedReceipts: expected.length - missing.length,
    missingReceipts: missing.length,
    incompleteReceipts: incomplete.length,
    reason: expected.length === 0 ? 'No enabled drop source catalog coverage applies to this range.'
      : missing.length || incomplete.length ? 'Drop source coverage receipts are missing, partial, or failed.' : null,
  };
}

function dropCoverage(database, range) {
  const catalog = safeAll(database, 'SELECT tld, source, coverage_started_on FROM drop_source_catalog WHERE enabled=1', {});
  const receipts = safeAll(database, 'SELECT tld, source, coverage_date, status FROM drop_source_coverage WHERE coverage_date BETWEEN @from AND @to', range);
  const coverage = evaluateDropCoverage(catalog.rows, receipts.rows, range);
  if (catalog.error || receipts.error) {
    coverage.complete = false;
    coverage.reason = [coverage.reason, catalog.error, receipts.error].filter(Boolean).join(' · ');
  }
  return coverage;
}

function evidence(source, from, to, rows, errors = [], capped = false, coverage = null) {
  const timestamps = rows.map(row => row.drop_date || row.event_date || row.availability_checked_at).filter(Boolean).sort();
  const explicitCoverage = coverage || { complete: false, reason: 'This source has no explicit completeness receipt for the selected range.' };
  return { source, range: { from, to }, freshestObservedAt: timestamps.at(-1) || null, rowCount: rows.length, complete: !errors.length && !capped && explicitCoverage.complete, capped, errors, coverage: explicitCoverage };
}

function registerZoneIntelligenceRoutes(app, { db }) {
  app.get('/api/zone-intelligence', (req, res) => {
    const range = boundedRange(req.query.from, req.query.to);
    const mode = String(req.query.mode || 'movement');
    const limit = parseLimit(req.query.limit);
    if (mode === 'movement') {
      const prior = { from: addDays(range.from, -range.days), to: addDays(range.from, -1) };
      const currentRows = movementEvents(db, range.from, range.to);
      const priorRows = movementEvents(db, prior.from, prior.to);
      return res.json({ mode, range, rows: aggregateTokenMovement(currentRows.events, range, priorRows.events).slice(0, limit), evidence: evidence('persisted zone keyword daily-diff + drop archive', range.from, range.to, currentRows.events, currentRows.errors, currentRows.capped), priorRange: prior });
    }
    if (mode === 'token-domains') {
      const token = String(req.query.token || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!token) return res.status(400).json({ error: 'token required' });
      const found = tokenDomainRows(db, token, range.from, range.to, limit);
      return res.json({ mode, token, range, rows: found.rows, evidence: evidence('current zone index + drop archive', range.from, range.to, found.rows, found.errors) });
    }
    const found = dropRows(db, range.from, range.to);
    if (mode === 'drops') {
      const rows = filterDroppingDomains(found.rows, req.query).slice(0, limit);
      return res.json({ mode, range, rows, filterEvidence: { wordCount: 'literal labels only: one unhyphenated label or exact hyphen-separated parts; no dictionary inference' }, evidence: evidence('DomainScout drop_events archive', range.from, range.to, found.rows, [found.error].filter(Boolean), found.rows.length === MAX_SOURCE_ROWS, dropCoverage(db, range)) });
    }
    if (mode === 'gems') {
      const rows = rankGems(filterDroppingDomains(found.rows, req.query)).slice(0, limit);
      return res.json({ mode, range, rows, evidence: evidence('existing DomainScout quality + observed sibling/age/archive fields', range.from, range.to, found.rows, [found.error].filter(Boolean), found.rows.length === MAX_SOURCE_ROWS, dropCoverage(db, range)) });
    }
    if (mode === 'gaps') {
      const gaps = safeAll(db, `SELECT e.domain, e.base_name, e.tld, e.source, e.source_event_at AS drop_date, d.quality_score, d.tlds_taken, s.status AS com_status, s.source AS com_source, s.checked_at AS com_checked_at, c.registration_available AS com_registration_available, c.availability_source AS com_availability_source, c.availability_checked_at AS com_availability_checked_at FROM drop_events e LEFT JOIN domains d ON d.id=(SELECT id FROM domains WHERE domain=e.domain ORDER BY discovered_at DESC LIMIT 1) LEFT JOIN sibling_tld_status s ON s.base_name=e.base_name AND s.tld='.com' LEFT JOIN domains c ON c.id=(SELECT id FROM domains WHERE domain=e.base_name || '.com' AND registration_available IS NOT NULL ORDER BY availability_checked_at DESC LIMIT 1) WHERE e.source_event_at >= @fromAt AND e.source_event_at < @toAt ORDER BY d.quality_score DESC, e.source_event_at DESC LIMIT ${MAX_SOURCE_ROWS}`, eventRangeParams(range.from, range.to));
      const classified = gaps.rows.map(row => classifyAvailabilityGap(row));
      const onlyConfirmed = /^(1|true|yes)$/.test(String(req.query.onlyConfirmed || ''));
      const rows = classified.filter(row => !onlyConfirmed || row.gap).slice(0, limit);
      return res.json({ mode, range, rows, counts: { confirmedAvailable: classified.filter(row => row.comState === 'confirmed-available').length, taken: classified.filter(row => row.comState === 'taken').length, unknown: classified.filter(row => row.comState === 'unknown').length }, evidence: evidence('receipted DomainScout drop archive + explicit .com availability evidence', range.from, range.to, gaps.rows, [gaps.error].filter(Boolean), gaps.rows.length === MAX_SOURCE_ROWS, dropCoverage(db, range)) });
    }
    return res.status(400).json({ error: 'mode must be movement, token-domains, drops, gems, or gaps' });
  });
}

module.exports = { MAX_RANGE_DAYS, FAVORITE_EXPORT_FIELDS, aggregateTokenMovement, boundedRange, classifyAvailabilityGap, evaluateDropCoverage, eventRangeParams, filterDroppingDomains, inferredWordCount, rankGem, rankGems, registerZoneIntelligenceRoutes, tokenizeBase };
