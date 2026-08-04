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

function sourceStatusRows(sources) {
  const selected = [...new Set((sources || []).map(row => String(row.source || row).trim()).filter(Boolean))];
  if (!selected.length) return [];
  const placeholders = selected.map(() => '?').join(',');
  return db.prepare(`
    SELECT source, provider, last_update, available_from, checked_at, status, error
    FROM drop_source_status
    WHERE source IN (${placeholders})
    ORDER BY source
  `).all(...selected);
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

function eventCoverageCounts(tlds, dates) {
  if (!tlds.length || !dates.length) return new Map();
  const tldPlaceholders = tlds.map(() => '?').join(',');
  const datePlaceholders = dates.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT tld, SUBSTR(source_event_at, 1, 10) AS coverage_date, source,
           COUNT(*) AS observed_count,
           SUM(CASE WHEN registration_available = 1 THEN 1 ELSE 0 END) AS available_count,
           SUM(CASE WHEN registration_available = 0 THEN 1 ELSE 0 END) AS unavailable_count,
           SUM(CASE WHEN registration_available IS NULL THEN 1 ELSE 0 END) AS unknown_count
    FROM drop_events
    WHERE tld IN (${tldPlaceholders})
      AND SUBSTR(source_event_at, 1, 10) IN (${datePlaceholders})
    GROUP BY tld, SUBSTR(source_event_at, 1, 10), source
  `).all(...tlds, ...dates);
  return new Map(rows.map(row => [`${row.tld}|${row.coverage_date}|${row.source}`, {
    observed: Number(row.observed_count || 0),
    available: Number(row.available_count || 0),
    unavailable: Number(row.unavailable_count || 0),
    unknown: Number(row.unknown_count || 0),
  }]));
}

function getExpiredUniverseCoverage({ days = 30, tlds, now = new Date(), maxStatusAgeHours } = {}) {
  const requested = normalizeTlds(tlds);
  const selectedTlds = requested.length ? requested : catalogTlds();
  const sources = sourceRowsForTlds(selectedTlds);
  const sourcesByTld = new Map();
  for (const row of sources) {
    if (!sourcesByTld.has(row.tld)) sourcesByTld.set(row.tld, []);
    sourcesByTld.get(row.tld).push(row);
  }
  const statuses = sourceStatusRows(sources);
  const statusBySource = new Map(statuses.map(row => [row.source, row]));
  const statusMaxAgeHours = Math.min(168, Math.max(
    1,
    Number(maxStatusAgeHours ?? process.env.DOMAINSCOUT_DROP_FEED_STATUS_MAX_AGE_HOURS ?? 36) || 36
  ));
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const usableStatus = row => {
    if (!row || row.status !== 'ok' || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.last_update || ''))) return false;
    const checkedMs = new Date(row.checked_at).getTime();
    return Number.isFinite(checkedMs) && Number.isFinite(nowMs) && (nowMs - checkedMs) <= statusMaxAgeHours * 3_600_000;
  };
  const latestByTld = new Map();
  for (const tld of selectedTlds) {
    const latest = (sourcesByTld.get(tld) || [])
      .map(source => statusBySource.get(source.source))
      .filter(usableStatus)
      .map(status => status.last_update)
      .sort()
      .at(-1);
    if (latest) latestByTld.set(tld, latest);
  }
  const windowEnd = selectedTlds.length > 0 && latestByTld.size === selectedTlds.length
    ? [...latestByTld.values()].sort()[0]
    : utcDate(now);
  const dates = coverageDates(days, new Date(`${windowEnd}T00:00:00.000Z`));
  const rows = coverageRows(selectedTlds, dates);
  const eventCounts = eventCoverageCounts(selectedTlds, dates);
  const completeKeys = new Set(rows.filter(row => {
    const observed = Number(row.observed_count || 0);
    const accounted = Number(row.available_count || 0) + Number(row.unavailable_count || 0);
    const key = `${row.tld}|${row.coverage_date}|${row.source}`;
    const persisted = eventCounts.get(key) || { observed: 0, available: 0, unavailable: 0, unknown: 0 };
    return row.status === 'complete'
      && Number(row.unknown_count || 0) === 0
      && accounted === observed
      && persisted.observed === observed
      // Availability can legitimately flip after the receipt was written when
      // somebody registers a dropped name. What must remain invariant is that
      // every observed event is still decisively accounted for (never unknown).
      && persisted.available + persisted.unavailable === persisted.observed
      && persisted.unknown === 0;
  }).map(row => `${row.tld}|${row.coverage_date}|${row.source}`));

  const missingSourceTlds = selectedTlds.filter(tld => !sourcesByTld.has(tld));
  const staleStatusTlds = selectedTlds.filter(tld => !latestByTld.has(tld));
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
  } else if (staleStatusTlds.length) {
    reason = `Authoritative drop-feed freshness is missing or stale for ${staleStatusTlds.join(', ')}.`;
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
    complete: selectedTlds.length > 0 && missingSourceTlds.length === 0 && staleStatusTlds.length === 0 && missingDays.length === 0,
    failClosed: true,
    days: dates.length,
    windowStart: dates[0],
    windowEnd,
    requestedTlds: requested,
    selectedTlds,
    missingSourceTlds,
    staleStatusTlds,
    missingDayCount: missingDays.length,
    missingDays: missingDays.slice(0, 250),
    sourceCount: sources.length,
    sources: sources.slice(0, 250),
    sourceStatuses: statuses.slice(0, 250),
    statusMaxAgeHours,
    receiptCount: rows.length,
    receipts: rows.slice(0, 250),
    totals,
    reason,
  };
}

function strictExpiredWhere(window = 30, prefix = '') {
  const p = prefix ? `${prefix}.` : 'domains.';
  const explicit = window && typeof window === 'object' && window.windowStart && window.windowEnd;
  const count = Math.min(365, Math.max(1, parseInt(window, 10) || 30));
  const cutoff = explicit ? `'${utcDate(window.windowStart)}'` : `date('now','-${count - 1} days')`;
  const through = explicit ? `'${utcDate(window.windowEnd)}'` : `date('now')`;
  return `(
    ${p}stream = 'just-dropped'
    AND ${p}registration_available = 1
    AND EXISTS (
      SELECT 1
      FROM drop_events drop_event
      WHERE drop_event.domain = ${p}domain
        AND drop_event.released_at IS NOT NULL
        AND drop_event.registration_available = 1
        AND SUBSTR(drop_event.source_event_at, 1, 10) >= ${cutoff}
        AND SUBSTR(drop_event.source_event_at, 1, 10) <= ${through}
    )
  )`;
}

const upsertCatalog = db.prepare(`
  INSERT INTO drop_source_catalog (tld, source, source_kind, enabled, coverage_started_on, metadata_json, updated_at)
  VALUES (@tld, @source, @source_kind, @enabled, @coverage_started_on, @metadata_json, datetime('now'))
  ON CONFLICT(tld, source) DO UPDATE SET
    source_kind = excluded.source_kind,
    enabled = excluded.enabled,
    coverage_started_on = CASE
      WHEN drop_source_catalog.coverage_started_on IS NULL THEN excluded.coverage_started_on
      WHEN excluded.coverage_started_on IS NULL THEN drop_source_catalog.coverage_started_on
      WHEN excluded.coverage_started_on < drop_source_catalog.coverage_started_on THEN excluded.coverage_started_on
      ELSE drop_source_catalog.coverage_started_on
    END,
    metadata_json = excluded.metadata_json,
    updated_at = datetime('now')
`);

const upsertSourceStatus = db.prepare(`
  INSERT INTO drop_source_status (
    source, provider, last_update, available_from, checked_at, status, error
  ) VALUES (
    @source, @provider, @last_update, @available_from, @checked_at, @status, @error
  )
  ON CONFLICT(source) DO UPDATE SET
    provider = excluded.provider,
    last_update = excluded.last_update,
    available_from = excluded.available_from,
    checked_at = excluded.checked_at,
    status = excluded.status,
    error = excluded.error
`);

function recordDropSourceStatus({
  source, provider, lastUpdate = null, availableFrom = null,
  checkedAt = new Date().toISOString(), status = 'ok', error = null,
}) {
  if (!source || !provider) throw new Error('source and provider are required');
  return upsertSourceStatus.run({
    source: String(source).trim(),
    provider: String(provider).trim(),
    last_update: lastUpdate ? utcDate(lastUpdate) : null,
    available_from: availableFrom ? utcDate(availableFrom) : null,
    checked_at: new Date(checkedAt).toISOString(),
    status: String(status || 'ok'),
    error,
  });
}

function getDropSourceStatus(source) {
  return db.prepare(`
    SELECT source, provider, last_update, available_from, checked_at, status, error
    FROM drop_source_status WHERE source = ?
  `).get(String(source || '').trim()) || null;
}

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
    registration_available, availability_source, availability_checked_at, observed_at
  ) VALUES (
    @domain, @base_name, @tld, @source, @source_kind,
    @source_event_at, @prior_registered_evidence, @released_at,
    @registration_available, @availability_source, @availability_checked_at, @observed_at
  )
  ON CONFLICT(domain, source, source_event_at) DO UPDATE SET
    prior_registered_evidence = excluded.prior_registered_evidence,
    released_at = COALESCE(drop_events.released_at, excluded.released_at),
    registration_available = COALESCE(excluded.registration_available, drop_events.registration_available),
    availability_source = COALESCE(excluded.availability_source, drop_events.availability_source),
    availability_checked_at = COALESCE(excluded.availability_checked_at, drop_events.availability_checked_at),
    observed_at = excluded.observed_at
`);

function recordDropEvent({
  domain, tld, source, sourceKind = 'deleted-domain-feed', sourceEventAt,
  priorRegisteredEvidence, releasedAt, registrationAvailable = null, availabilitySource = null,
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
    registration_available: registrationAvailable == null ? null : Number(Boolean(registrationAvailable)),
    availability_source: availabilitySource,
    availability_checked_at: availabilityCheckedAt,
    observed_at: observedAt,
  });
}

const updateDropAvailability = db.prepare(`
  UPDATE drop_events SET
    released_at = COALESCE(released_at, source_event_at),
    registration_available = @registration_available,
    availability_source = @availability_source,
    availability_checked_at = @availability_checked_at,
    observed_at = @availability_checked_at
  WHERE domain = @domain
    AND source_event_at = (
      SELECT MAX(candidate.source_event_at)
      FROM drop_events candidate
      WHERE candidate.domain = @domain
        AND candidate.prior_registered_evidence IS NOT NULL
    )
`);

function recordDropAvailability({
  domain, registrationAvailable, availabilitySource = null,
  availabilityCheckedAt = new Date().toISOString(),
}) {
  return updateDropAvailability.run({
    domain: String(domain || '').trim().toLowerCase(),
    registration_available: registrationAvailable == null ? null : Number(Boolean(registrationAvailable)),
    availability_source: availabilitySource,
    availability_checked_at: availabilityCheckedAt,
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
  getDropSourceStatus,
  hasDropEvent,
  normalizeTld,
  normalizeTlds,
  recordCoverageReceipt,
  recordDropAvailability,
  recordDropEvent,
  recordDropSourceStatus,
  registerDropSource,
  strictExpiredWhere,
};
