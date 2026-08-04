'use strict';

const db = require('./db');
const {
  normalizeTld,
  normalizeTlds,
  recordCoverageReceipt,
  recordDropEvent,
  recordDropSourceStatus,
  registerDropSource,
} = require('./drop-universe');
const { refreshExpiredAvailability } = require('./expired-availability');

const WHOISFREAKS_SOURCE = 'WhoisFreaks Dropped Feed';
const WHOISFREAKS_BASE_URL = 'https://files.whoisfreaks.com';
const WHOISFREAKS_STATUS_URL = `${WHOISFREAKS_BASE_URL}/v3.4/status`;

const upsertCandidate = db.prepare(`
  INSERT INTO domains (
    domain, base_name, tld, stream, source, status,
    registration_available, length, has_numbers, has_hyphens,
    drop_date, discovered_at
  ) VALUES (
    @domain, @base_name, @tld, 'just-dropped', @source, 'active',
    NULL, @length, @has_numbers, @has_hyphens,
    @drop_date, @discovered_at
  )
  ON CONFLICT(domain, stream) DO UPDATE SET
    source = CASE
      WHEN domains.source = 'Availability Confirmation' THEN domains.source
      ELSE excluded.source
    END,
    status = 'active',
    registration_available = NULL,
    availability_checked_at = NULL,
    availability_source = NULL,
    availability_error = NULL,
    drop_date = excluded.drop_date,
    discovered_at = excluded.discovered_at
`);

function normalizeDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!domain || domain.length > 253 || !domain.includes('.')) return null;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(domain)) return null;
  if (domain.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return null;
  return domain;
}

function stringValues(value) {
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  const direct = value.domain || value.domain_name || value.name || value.fqdn;
  return direct ? [String(direct)] : [];
}

function parseDroppedPayload(payload) {
  if (Buffer.isBuffer(payload)) payload = payload.toString('utf8');
  if (Array.isArray(payload)) return [...new Set(payload.flatMap(stringValues).map(normalizeDomain).filter(Boolean))];
  if (payload && typeof payload === 'object') {
    const collection = payload.domains || payload.data || payload.results || payload.items || payload.records;
    return parseDroppedPayload(Array.isArray(collection) ? collection : [payload]);
  }

  const text = String(payload || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) return parseDroppedPayload(JSON.parse(text));

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const values = [];
  for (let index = 0; index < lines.length; index++) {
    const cells = lines[index].split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
    const header = cells.map(cell => cell.toLowerCase());
    if (index === 0 && header.some(cell => ['domain', 'domain_name', 'name', 'fqdn'].includes(cell))) continue;
    const candidate = cells.find(cell => normalizeDomain(cell));
    if (candidate) values.push(candidate);
  }
  return [...new Set(values.map(normalizeDomain).filter(Boolean))];
}

function tldForDomain(domain, requestedTlds = []) {
  const matching = normalizeTlds(requestedTlds)
    .filter(tld => domain.endsWith(tld))
    .sort((a, b) => b.length - a.length)[0];
  return matching || normalizeTld(domain.slice(domain.lastIndexOf('.')));
}

function buildWhoisFreaksUrl({ apiKey, date, tlds, baseUrl = WHOISFREAKS_BASE_URL }) {
  if (!apiKey) throw new Error('WHOISFREAKS_API_KEY is required');
  const url = new URL('/v3.1/domains/dropped', baseUrl);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('date', date);
  const selected = normalizeTlds(tlds).map(tld => tld.slice(1));
  if (selected.length) url.searchParams.set('tlds', selected.join(','));
  return url;
}

async function fetchWhoisFreaksDroppedDay({ apiKey, date, tlds, fetchImpl = fetch, baseUrl } = {}) {
  const url = buildWhoisFreaksUrl({ apiKey, date, tlds, baseUrl });
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`WhoisFreaks dropped feed returned HTTP ${response.status} for ${date}`);
  return parseDroppedPayload(await response.text());
}

async function fetchWhoisFreaksStatus({ fetchImpl = fetch, statusUrl = WHOISFREAKS_STATUS_URL } = {}) {
  const response = await fetchImpl(statusUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`WhoisFreaks status returned HTTP ${response.status}`);
  const payload = JSON.parse(await response.text());
  const dropped = payload?.dropped || {};
  const lastUpdate = String(dropped.last_update || '');
  const availableFrom = String(dropped.available_from || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastUpdate) || !/^\d{4}-\d{2}-\d{2}$/.test(availableFrom)) {
    throw new Error('WhoisFreaks status did not advertise a valid dropped-feed window');
  }
  const status = { lastUpdate, availableFrom, checkedAt: new Date().toISOString() };
  recordDropSourceStatus({
    source: WHOISFREAKS_SOURCE,
    provider: 'whoisfreaks',
    ...status,
  });
  return status;
}

function ingestDroppedEvents({ date, domains, requestedTlds, source = WHOISFREAKS_SOURCE }) {
  const selectedTlds = normalizeTlds(requestedTlds);
  const normalized = [...new Set((domains || []).map(normalizeDomain).filter(Boolean))]
    .map(domain => ({ domain, tld: tldForDomain(domain, selectedTlds) }))
    .filter(row => !selectedTlds.length || selectedTlds.includes(row.tld));
  const coveredTlds = selectedTlds.length
    ? selectedTlds
    : [...new Set(normalized.map(row => row.tld))];
  if (!coveredTlds.length) throw new Error('At least one requested TLD is required for an empty dropped feed day');

  for (const tld of coveredTlds) {
    registerDropSource({
      tld,
      source,
      sourceKind: 'deleted-domain-feed',
      coverageStartedOn: date,
      metadata: { provider: 'whoisfreaks', feed: 'dropped', contract: 'complete-daily-file' },
    });
  }

  const eventAt = `${date}T12:00:00.000Z`;
  const observedAt = new Date().toISOString();
  db.transaction(rows => {
    for (const row of rows) {
      const baseName = row.domain.slice(0, -row.tld.length);
      recordDropEvent({
        domain: row.domain,
        tld: row.tld,
        source,
        sourceKind: 'deleted-domain-feed',
        sourceEventAt: eventAt,
        releasedAt: eventAt,
        priorRegisteredEvidence: `${source} daily dropped file ${date}`,
        observedAt,
      });
      upsertCandidate.run({
        domain: row.domain,
        base_name: baseName,
        tld: row.tld,
        source,
        length: baseName.length,
        has_numbers: /[0-9]/.test(baseName) ? 1 : 0,
        has_hyphens: baseName.includes('-') ? 1 : 0,
        drop_date: date,
        discovered_at: observedAt,
      });
    }
  })(normalized);

  return { domains: normalized.map(row => row.domain), coveredTlds };
}

function coverageCounts({ date, tld, source }) {
  return db.prepare(`
    SELECT COUNT(*) AS observed,
           SUM(CASE WHEN registration_available = 1 THEN 1 ELSE 0 END) AS available,
           SUM(CASE WHEN registration_available = 0 THEN 1 ELSE 0 END) AS unavailable,
           SUM(CASE WHEN registration_available IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM drop_events
    WHERE source = ? AND tld = ? AND SUBSTR(source_event_at, 1, 10) = ?
  `).get(source, tld, date);
}

function coverageCompleteForDay({ date, tlds, source = WHOISFREAKS_SOURCE }) {
  const receipt = db.prepare(`
    SELECT status, observed_count, unknown_count
    FROM drop_source_coverage
    WHERE tld = ? AND coverage_date = ? AND source = ?
  `);
  return normalizeTlds(tlds).every(tld => {
    const row = receipt.get(tld, date, source);
    if (!row || row.status !== 'complete' || Number(row.unknown_count || 0) !== 0) return false;
    const events = coverageCounts({ date, tld, source });
    const observed = Number(events.observed || 0);
    return observed === Number(row.observed_count || 0)
      && Number(events.unknown || 0) === 0
      && Number(events.available || 0) + Number(events.unavailable || 0) === observed;
  });
}

function finalizeCoverage({ date, tlds, source = WHOISFREAKS_SOURCE, error = null }) {
  const receipts = [];
  for (const tld of normalizeTlds(tlds)) {
    const row = coverageCounts({ date, tld, source });
    const counts = {
      observed: Number(row.observed || 0),
      available: Number(row.available || 0),
      unavailable: Number(row.unavailable || 0),
      unknown: Number(row.unknown || 0),
    };
    const status = error ? 'failed' : counts.unknown === 0 ? 'complete' : 'partial';
    recordCoverageReceipt({ tld, date, source, status, ...counts, error });
    receipts.push({ tld, date, source, status, ...counts });
  }
  return receipts;
}

async function syncWhoisFreaksDroppedDay({
  apiKey = process.env.WHOISFREAKS_API_KEY,
  date,
  tlds,
  fetchImpl = fetch,
  baseUrl,
  availabilityVerifier = refreshExpiredAvailability,
  availabilityOptions = {},
} = {}) {
  const requestedTlds = normalizeTlds(tlds);
  if (!date) throw new Error('date is required');
  if (!requestedTlds.length) throw new Error('At least one TLD is required so completeness is bounded');

  const domains = await fetchWhoisFreaksDroppedDay({ apiKey, date, tlds: requestedTlds, fetchImpl, baseUrl });
  const ingested = ingestDroppedEvents({ date, domains, requestedTlds, source: WHOISFREAKS_SOURCE });
  try {
    const availability = await availabilityVerifier({ domains: ingested.domains, ...availabilityOptions });
    const receipts = finalizeCoverage({ date, tlds: ingested.coveredTlds, source: WHOISFREAKS_SOURCE });
    return { date, fetched: domains.length, ingested: ingested.domains.length, availability, receipts };
  } catch (err) {
    finalizeCoverage({ date, tlds: ingested.coveredTlds, source: WHOISFREAKS_SOURCE, error: err.message });
    throw err;
  }
}

module.exports = {
  WHOISFREAKS_BASE_URL,
  WHOISFREAKS_SOURCE,
  WHOISFREAKS_STATUS_URL,
  buildWhoisFreaksUrl,
  coverageCompleteForDay,
  fetchWhoisFreaksDroppedDay,
  fetchWhoisFreaksStatus,
  finalizeCoverage,
  ingestDroppedEvents,
  normalizeDomain,
  parseDroppedPayload,
  syncWhoisFreaksDroppedDay,
  tldForDomain,
};
