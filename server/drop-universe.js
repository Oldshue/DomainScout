'use strict';

const db = require('./db');

function normalizeTld(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/^\.+/, '');
  return clean ? `.${clean}` : '';
}

function normalizeTlds(values) {
  const source = Array.isArray(values) ? values : String(values || '').split(',');
  return [...new Set(source.map(normalizeTld).filter(Boolean))];
}

function utcDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid coverage date');
  return date.toISOString().slice(0, 10);
}

// "Last N days" is N calendar dates including today. The previous implementation
// subtracted N and included today, which silently returned N+1 dates.
function coverageDates(days, now = new Date()) {
  const count = Math.min(365, Math.max(1, parseInt(days, 10) || 30));
  const anchor = new Date(`${utcDate(now)}T00:00:00.000Z`);
  const dates = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    dates.push(new Date(anchor.getTime() - offset * 86400000).toISOString().slice(0, 10));
  }
  return dates;
}

function catalogTlds() {
  return db.prepare(`
    SELECT DISTINCT tld
    FROM drop_source_catalog
    WHERE enabled = 1
    ORDER BY tld
  `).all().map(row => row.tld);
}

function sourceRowsForTlds(tlds) {
  if (!tlds.length) return [];
  const placeholders = tlds.map(() => '?').join(',');
  return db.prepare(`
    SELECT tld, source, coverage_started_on
    FROM drop_source_catalog
    WHERE enabled = 1 AND tld IN (${placeholders})
    ORDER BY tld, source
  `).all(...tlds);
}

function coverageRows(tlds, dates) {
  if (!tlds.length || !dates.length) return [];
  const tldPlaceholders = tlds.map(() => '?').join(',');
  const datePlaceholders = dates.map(() => '?').join(',');
  return db.prepare(`
    SELECT tld, coverage_date, source, status, observed_count,
           available_count, unavailable_count, unknown_count, completed_at, error
    FROM drop_source_coverage
    WHERE tld IN (${tldPlaceholders})
      AND coverage_date IN (${datePlaceholders})
    ORDER BY coverage_date, tld, source
  `).all(...tlds, ...dates);
}

function releasedEventCounts(tlds, dates) {
  if (!tlds.length || !dates.length) return new Map();
  const tldPlaceholders = tlds.map(() => '?').join(',');
  const datePlaceholders = dates.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT tld, SUBSTR(released_at, 1, 10) AS release_date, source, COUNT(*) AS n
    FROM drop_events
    WHERE tld IN (${tldPlaceholders})
      AND SUBSTR(released_at, 1, 10) IN (${datePlaceholders})
    GROUP BY tld, SUBSTR(released_at, 1, 10), source
  `).all(...tlds, ...dates);
  return new Map(rows.map(row => [`${row.tld}|${row.release_date}|${row.source}`, Number(row.n || 0)]));
}

function getExpiredUniverseCoverage({ days = 30, tlds, now = new Date() } = {}) {
  const requested = normalizeTlds(tlds);
  const selectedTlds = requested.length ? requested : catalogTlds();
  const dates = coverageDates(days, now);
  const sources = sourceRowsForTlds(selectedTlds);
  const sourcesByTld = new Map();
  for (const row of sources) {
    if (!sourcesByTld.has(row.tld)) sourcesByTld.set(row.tld, []);
    sourcesByTld.get(row.tld).push(row);
  }
  const rows = coverageRows(selectedTlds, dates);
  const eventCounts = releasedEventCounts(selectedTlds, dates);
  const completeKeys = new Set(rows.filter(row => {
    const observed = Number(row.observed_count || 0);
    const accounted = Number(row.available_count || 0) + Number(row.unavailable_count || 0);
    const key = `${row.tld}|${row.coverage_date}|${row.source}`;
    const persistedAvailable = eventCounts.get(key) || 0;
    return row.status === 'complete'
      && Number(row.unknown_count || 0) === 0
      && accounted === observed
      && persistedAvailable === Number(row.available_count || 0);
  }).map(row => `${row.tld}|${row.coverage_date}|${row.source}`));

  const missingSourceTlds = selectedTlds.filter(tld => !sourcesByTld.has(tld));
  const missingDays = [];
  for (const tld of selectedTlds) {
    const adapters = sourcesByTld.get(tld) || [];
    for (const date of dates) {
      const covered = adapters.some(source => {
        if (source.coverage_started_on && date < source.coverage_started_on) return false;
        return completeKeys.has(`${tld}|${date}|${source.source}`);
      });
      if (!covered) missingDays.push({ tld, date });
    }
  }

  let reason = null;
  if (!requested.length && selectedTlds.length === 0) {
    reason = 'No authoritative drop source is connected to DomainScout.';
  } else if (missingSourceTlds.length) {
    reason = `No authoritative drop source is connected for ${missingSourceTlds.join(', ')}.`;
  } else if (missingDays.length) {
    reason = `Authoritative daily drop coverage is missing for ${missingDays.length} requested TLD/day slice${missingDays.length === 1 ? '' : 's'}.`;
  }

  const totals = rows.reduce((acc, row) => {
    acc.observed += Number(row.observed_count || 0);
    acc.available += Number(row.available_count || 0);
    acc.unavailable += Number(row.unavailable_count || 0);
    acc.unknown += Number(row.unknown_count || 0);
    return acc;
  }, { observed: 0, available: 0, unavailable: 0, unknown: 0 });

  return {
    complete: selectedTlds.length > 0 && missingSourceTlds.length === 0 && missingDays.length === 0,
    failClosed: true,
    days: dates.length,
    windowStart: dates[0],
    windowEnd: dates[dates.length - 1],
    requestedTlds: requested,
    selectedTlds,
    missingSourceTlds,
    missingDayCount: missingDays.length,
    missingDays: missingDays.slice(0, 250),
    sourceCount: sources.length,
    sources: sources.slice(0, 250),
    receiptCount: rows.length,
    receipts: rows.slice(0, 250),
    totals,
    reason,
  };
}

function strictExpiredWhere(days = 30, prefix = '') {
  const count = Math.min(365, Math.max(1, parseInt(days, 10) || 30));
  const p = prefix ? `${prefix}.` : 'domains.';
  const cutoff = `date('now','-${count - 1} days')`;
  const tomorrow = `date('now','+1 day')`;
  return `(
    ${p}stream = 'just-dropped'
    AND ${p}registration_available = 1
    AND EXISTS (
      SELECT 1
      FROM drop_events drop_event
      WHERE drop_event.domain = ${p}domain
        AND drop_event.released_at IS NOT NULL
        AND SUBSTR(drop_event.released_at, 1, 10) >= ${cutoff}
        AND SUBSTR(drop_event.released_at, 1, 10) < ${tomorrow}
    )
  )`;
}

const upsertCatalog = db.prepare(`
  INSERT INTO drop_source_catalog (tld, source, source_kind, enabled, coverage_started_on, metadata_json, updated_at)
  VALUES (@tld, @source, @source_kind, @enabled, @coverage_started_on, @metadata_json, datetime('now'))
  ON CONFLICT(tld, source) DO UPDATE SET
    source_kind = excluded.source_kind,
    enabled = excluded.enabled,
    coverage_started_on = excluded.coverage_started_on,
    metadata_json = excluded.metadata_json,
    updated_at = datetime('now')
`);

function registerDropSource({ tld, source, sourceKind, enabled = true, coverageStartedOn = null, metadata = null }) {
  return upsertCatalog.run({
    tld: normalizeTld(tld),
    source: String(source || '').trim(),
    source_kind: String(sourceKind || 'deleted-domain-feed').trim(),
    enabled: enabled ? 1 : 0,
    coverage_started_on: coverageStartedOn ? utcDate(coverageStartedOn) : null,
    metadata_json: metadata == null ? null : JSON.stringify(metadata),
  });
}

const upsertCoverage = db.prepare(`
  INSERT INTO drop_source_coverage (
    tld, coverage_date, source, status, observed_count,
    available_count, unavailable_count, unknown_count, completed_at, error
  ) VALUES (
    @tld, @coverage_date, @source, @status, @observed_count,
    @available_count, @unavailable_count, @unknown_count, @completed_at, @error
  )
  ON CONFLICT(tld, coverage_date, source) DO UPDATE SET
    status = excluded.status,
    observed_count = excluded.observed_count,
    available_count = excluded.available_count,
    unavailable_count = excluded.unavailable_count,
    unknown_count = excluded.unknown_count,
    completed_at = excluded.completed_at,
    error = excluded.error
`);

function recordCoverageReceipt({
  tld, date, source, status = 'complete', observed = 0,
  available = 0, unavailable = 0, unknown = 0, completedAt = new Date().toISOString(), error = null,
}) {
  return upsertCoverage.run({
    tld: normalizeTld(tld),
    coverage_date: utcDate(date),
    source: String(source || '').trim(),
    status,
    observed_count: Number(observed || 0),
    available_count: Number(available || 0),
    unavailable_count: Number(unavailable || 0),
    unknown_count: Number(unknown || 0),
    completed_at: completedAt,
    error,
  });
}

const upsertDropEvent = db.prepare(`
  INSERT INTO drop_events (
    domain, base_name, tld, source, source_kind,
    source_event_at, prior_registered_evidence, released_at,
    availability_source, availability_checked_at, observed_at
  ) VALUES (
    @domain, @base_name, @tld, @source, @source_kind,
    @source_event_at, @prior_registered_evidence, @released_at,
    @availability_source, @availability_checked_at, @observed_at
  )
  ON CONFLICT(domain, source, source_event_at) DO UPDATE SET
    prior_registered_evidence = excluded.prior_registered_evidence,
    released_at = COALESCE(drop_events.released_at, excluded.released_at),
    availability_source = COALESCE(excluded.availability_source, drop_events.availability_source),
    availability_checked_at = COALESCE(excluded.availability_checked_at, drop_events.availability_checked_at),
    observed_at = excluded.observed_at
`);

function recordDropEvent({
  domain, tld, source, sourceKind = 'deleted-domain-feed', sourceEventAt,
  priorRegisteredEvidence, releasedAt, availabilitySource = null,
  availabilityCheckedAt = null, observedAt = new Date().toISOString(),
}) {
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  const normalizedTld = normalizeTld(tld || normalizedDomain.slice(normalizedDomain.lastIndexOf('.')));
  const baseName = normalizedDomain.endsWith(normalizedTld)
    ? normalizedDomain.slice(0, -normalizedTld.length)
    : normalizedDomain.slice(0, normalizedDomain.lastIndexOf('.'));
  if (!normalizedDomain || !baseName || !normalizedTld || !source || !sourceEventAt) {
    throw new Error('domain, tld, source, and sourceEventAt are required');
  }
  return upsertDropEvent.run({
    domain: normalizedDomain,
    base_name: baseName,
    tld: normalizedTld,
    source: String(source),
    source_kind: String(sourceKind),
    source_event_at: new Date(sourceEventAt).toISOString(),
    prior_registered_evidence: String(priorRegisteredEvidence || sourceKind),
    released_at: releasedAt ? new Date(releasedAt).toISOString() : null,
    availability_source: availabilitySource,
    availability_checked_at: availabilityCheckedAt,
    observed_at: observedAt,
  });
}

function hasDropEvent(domain) {
  return Boolean(db.prepare(`
    SELECT 1 FROM drop_events
    WHERE domain = ? AND prior_registered_evidence IS NOT NULL
    LIMIT 1
  `).get(String(domain || '').trim().toLowerCase()));
}

module.exports = {
  coverageDates,
  getExpiredUniverseCoverage,
  hasDropEvent,
  normalizeTld,
  normalizeTlds,
  recordCoverageReceipt,
  recordDropEvent,
  registerDropSource,
  strictExpiredWhere,
};
