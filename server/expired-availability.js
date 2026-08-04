const db = require('./db');
const { checkRegistrationAvailability, getRegistrarAvailabilityConfig } = require('../enrichment');
const { computeDomainQuality } = require('./domain-quality');

const EXCLUDED_STREAMS = [
  'godaddy-auction',
  'godaddy-closeout',
  'godaddy-premium',
  'namecheap-auction',
  'marketplace',
];
const COOLDOWN_CACHE_KEY = 'expired-availability-tld-cooldowns';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function withTimeout(promise, timeoutMs, message) {
  let timeout = null;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function refreshModifier(hours, fallback = 24) {
  return `-${positiveInt(hours, fallback, 0, 24 * 365)} hours`;
}

function defaultPriorityTlds() {
  return normalizeTlds(
    process.env.DOMAINSCOUT_EXPIRED_PRIORITY_TLDS ||
    '.com,.ai,.sh,.io,.bot,.net,.org,.dev,.app,.co,.xyz'
  );
}

function registrarBlockedTlds() {
  const config = getRegistrarAvailabilityConfig();
  if (config.configured) return [];
  return normalizeTlds(config.registrarRequiredAvailableTlds || []);
}

function withoutTlds(tlds, excludedTlds) {
  const excluded = new Set(normalizeTlds(excludedTlds));
  return normalizeTlds(tlds).filter(tld => !excluded.has(tld));
}

function intersectTlds(tlds, allowedTlds) {
  const allowed = new Set(normalizeTlds(allowedTlds));
  return normalizeTlds(tlds).filter(tld => allowed.has(tld));
}

function normalizeTlds(tlds) {
  if (!tlds) return [];
  const list = Array.isArray(tlds) ? tlds : String(tlds).split(',');
  return [...new Set(
    list
      .map(tld => String(tld || '').trim().toLowerCase())
      .filter(Boolean)
      .map(tld => tld.startsWith('.') ? tld : `.${tld}`)
  )];
}

function tldFromDomain(domain) {
  const value = String(domain || '').toLowerCase();
  const match = value.match(/(\.[^.]+)$/);
  return match ? match[1] : '';
}

const readCache = db.prepare('SELECT value_json, updated_at FROM app_cache WHERE key = ?');
const writeCache = db.prepare(`
  INSERT INTO app_cache (key, value_json, updated_at)
  VALUES (@key, @value_json, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at
`);

function defaultCooldownMs() {
  return positiveInt(
    process.env.DOMAINSCOUT_EXPIRED_RDAP_RATE_LIMIT_COOLDOWN_MS,
    45 * 60_000,
    60_000,
    24 * 3_600_000
  );
}

function readCooldownState() {
  const row = readCache.get(COOLDOWN_CACHE_KEY);
  if (!row?.value_json) return {};
  try {
    const parsed = JSON.parse(row.value_json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeCooldownState(state) {
  writeCache.run({
    key: COOLDOWN_CACHE_KEY,
    value_json: JSON.stringify(state || {}),
  });
}

function getAvailabilityCooldowns(options = {}) {
  const now = Date.now();
  const state = readCooldownState();
  const active = {};
  let changed = false;
  for (const [rawTld, entry] of Object.entries(state)) {
    const tld = normalizeTlds([rawTld])[0];
    const untilMs = Date.parse(entry?.until || '');
    if (!tld || !Number.isFinite(untilMs) || untilMs <= now) {
      changed = true;
      continue;
    }
    active[tld] = {
      tld,
      until: new Date(untilMs).toISOString(),
      remainingMs: untilMs - now,
      reason: entry.reason || 'RDAP rate limited',
      updatedAt: entry.updatedAt || null,
    };
  }
  if (changed && !options.readOnly) writeCooldownState(active);
  return active;
}

function cooldownTlds(options = {}) {
  if (options.ignoreCooldowns || process.env.DOMAINSCOUT_EXPIRED_IGNORE_COOLDOWNS === '1') return [];
  return Object.keys(getAvailabilityCooldowns());
}

function recordAvailabilityCooldown(tld, context = {}) {
  const normalized = normalizeTlds([tld])[0];
  if (!normalized) return null;
  const state = getAvailabilityCooldowns();
  const now = Date.now();
  const durationMs = positiveInt(
    context.retryAfterMs || context.cooldownMs,
    defaultCooldownMs(),
    60_000,
    24 * 3_600_000
  );
  const untilMs = Math.max(
    Date.parse(state[normalized]?.until || '') || 0,
    now + durationMs
  );
  const entry = {
    tld: normalized,
    until: new Date(untilMs).toISOString(),
    remainingMs: untilMs - now,
    reason: context.reason || 'RDAP rate limited',
    updatedAt: new Date(now).toISOString(),
  };
  state[normalized] = entry;
  writeCooldownState(state);
  return entry;
}

function clearAvailabilityCooldown(tld) {
  const normalized = normalizeTlds([tld])[0];
  if (!normalized) return false;
  const state = getAvailabilityCooldowns();
  if (!state[normalized]) return false;
  delete state[normalized];
  writeCooldownState(state);
  return true;
}

function candidateQuery(tlds) {
  const excluded = EXCLUDED_STREAMS.map(stream => `'${stream}'`).join(',');
  const tldFilter = tlds.length
    ? `AND tld IN (${tlds.map((_, i) => `@tld${i}`).join(',')})`
    : '';

  return `
    WITH candidates AS (
      SELECT
        domain,
        MIN(tld) AS tld,
        MAX(COALESCE(tlds_taken, 0)) AS tlds_taken,
        MAX(COALESCE(age_years, 0)) AS age_years,
        MAX(COALESCE(wayback_snapshots, 0)) AS wayback_snapshots,
        MAX(COALESCE(has_numbers, 0)) AS has_numbers,
        MAX(COALESCE(has_hyphens, 0)) AS has_hyphens,
        MIN(CASE
          WHEN length IS NULL OR length <= 0 THEN LENGTH(SUBSTR(domain, 1, INSTR(domain, '.') - 1))
          ELSE length
        END) AS length,
        MAX(discovered_at) AS latest_seen_at,
        MAX(CASE WHEN registration_available = 1 THEN 1 ELSE 0 END) AS was_available,
        MIN(CASE
          WHEN stream = 'just-dropped' THEN 0
          WHEN drop_date IS NOT NULL AND date(drop_date) <= date('now') THEN 1
          WHEN expiry_date IS NOT NULL AND datetime(expiry_date) <= datetime('now') THEN 2
          WHEN stream = 'pending-delete' AND auction_end IS NOT NULL AND datetime(auction_end) <= datetime('now') THEN 2
          WHEN dns_available = 1 THEN 3
          WHEN registration_available = 1 THEN 4
          ELSE 5
        END) AS due_bucket
      FROM domains
      WHERE stream NOT IN (${excluded})
        ${tldFilter}
        AND (
          stream = 'just-dropped'
          OR (drop_date IS NOT NULL AND date(drop_date) <= date('now'))
          OR (expiry_date IS NOT NULL AND datetime(expiry_date) <= datetime('now'))
          OR (stream = 'pending-delete' AND auction_end IS NOT NULL AND datetime(auction_end) <= datetime('now'))
          OR dns_available = 1
          OR registration_available = 1
        )
        AND (
          availability_checked_at IS NULL
          OR (
            registration_available IS NULL
            AND availability_error IS NOT NULL
            AND availability_error != ''
            AND datetime(availability_checked_at) <= datetime('now', @errorRefresh)
          )
          OR (
            registration_available IS NULL
            AND (availability_error IS NULL OR availability_error = '')
            AND datetime(availability_checked_at) <= datetime('now', @unknownRefresh)
          )
          OR (registration_available = 0 AND datetime(availability_checked_at) <= datetime('now', @unavailableRefresh))
          OR (registration_available = 1 AND datetime(availability_checked_at) <= datetime('now', @availableRefresh))
        )
      GROUP BY domain
    )
    SELECT domain, tld, tlds_taken, age_years, wayback_snapshots, has_numbers, has_hyphens, length, latest_seen_at, was_available, due_bucket
    FROM candidates
    ORDER BY
      due_bucket ASC,
      was_available DESC,
      has_numbers ASC,
      has_hyphens ASC,
      CASE WHEN length BETWEEN 3 AND 12 THEN 0 ELSE 1 END ASC,
      tlds_taken DESC,
      length ASC,
      latest_seen_at DESC
    LIMIT @limit
  `;
}

function backlogEstimateQuery(tlds) {
  const excluded = EXCLUDED_STREAMS.map(stream => `'${stream}'`).join(',');
  const tldFilter = tlds.length
    ? `AND tld IN (${tlds.map((_, i) => `@tld${i}`).join(',')})`
    : '';

  return `
    WITH candidates AS (
      SELECT
        domain,
        MIN(tld) AS tld,
        MIN(CASE
          WHEN stream = 'just-dropped' THEN 0
          WHEN drop_date IS NOT NULL AND date(drop_date) <= date('now') THEN 1
          WHEN expiry_date IS NOT NULL AND datetime(expiry_date) <= datetime('now') THEN 2
          WHEN stream = 'pending-delete' AND auction_end IS NOT NULL AND datetime(auction_end) <= datetime('now') THEN 2
          WHEN dns_available = 1 THEN 3
          WHEN registration_available = 1 THEN 4
          ELSE 5
        END) AS due_bucket
      FROM domains
      WHERE stream NOT IN (${excluded})
        ${tldFilter}
        AND (
          stream = 'just-dropped'
          OR (drop_date IS NOT NULL AND date(drop_date) <= date('now'))
          OR (expiry_date IS NOT NULL AND datetime(expiry_date) <= datetime('now'))
          OR (stream = 'pending-delete' AND auction_end IS NOT NULL AND datetime(auction_end) <= datetime('now'))
          OR dns_available = 1
          OR registration_available = 1
        )
        AND ${availabilityDueSql()}
      GROUP BY domain
    )
    SELECT tld, due_bucket, COUNT(*) AS n
    FROM candidates
    GROUP BY tld, due_bucket
    ORDER BY n DESC
  `;
}

function candidateParams(options = {}, limit) {
  const params = {
    limit,
    errorRefresh: refreshModifier(options.errorRefreshHours ?? process.env.DOMAINSCOUT_EXPIRED_ERROR_REFRESH_HOURS ?? 6, 6),
    unknownRefresh: refreshModifier(options.unknownRefreshHours ?? process.env.DOMAINSCOUT_EXPIRED_UNKNOWN_REFRESH_HOURS ?? 12, 12),
    unavailableRefresh: refreshModifier(options.unavailableRefreshHours ?? process.env.DOMAINSCOUT_EXPIRED_UNAVAILABLE_REFRESH_HOURS ?? 12, 12),
    availableRefresh: refreshModifier(options.availableRefreshHours ?? process.env.DOMAINSCOUT_EXPIRED_AVAILABLE_REFRESH_HOURS ?? 6, 6),
  };
  return params;
}

function availabilityDueSql() {
  return `(
    availability_checked_at IS NULL
    OR (
      registration_available IS NULL
      AND availability_error IS NOT NULL
      AND availability_error != ''
      AND datetime(availability_checked_at) <= datetime('now', @errorRefresh)
    )
    OR (
      registration_available IS NULL
      AND (availability_error IS NULL OR availability_error = '')
      AND datetime(availability_checked_at) <= datetime('now', @unknownRefresh)
    )
    OR (registration_available = 0 AND datetime(availability_checked_at) <= datetime('now', @unavailableRefresh))
    OR (registration_available = 1 AND datetime(availability_checked_at) <= datetime('now', @availableRefresh))
  )`;
}

function candidateProjectionSql(bucket) {
  return `
    domain,
    tld,
    COALESCE(tlds_taken, 0) AS tlds_taken,
    COALESCE(age_years, 0) AS age_years,
    COALESCE(wayback_snapshots, 0) AS wayback_snapshots,
    COALESCE(has_numbers, 0) AS has_numbers,
    COALESCE(has_hyphens, 0) AS has_hyphens,
    CASE
      WHEN length IS NULL OR length <= 0 THEN LENGTH(SUBSTR(domain, 1, INSTR(domain, '.') - 1))
      ELSE length
    END AS length,
    discovered_at AS latest_seen_at,
    CASE WHEN registration_available = 1 THEN 1 ELSE 0 END AS was_available,
    ${bucket} AS due_bucket
  `;
}

function mergeCandidateRows(rows) {
  const byDomain = new Map();
  for (const row of rows) {
    if (!row.domain) continue;
    const existing = byDomain.get(row.domain);
    if (!existing) {
      byDomain.set(row.domain, row);
      continue;
    }
    existing.tld = existing.tld || row.tld;
    existing.tlds_taken = Math.max(existing.tlds_taken || 0, row.tlds_taken || 0);
    existing.age_years = Math.max(existing.age_years || 0, row.age_years || 0);
    existing.wayback_snapshots = Math.max(existing.wayback_snapshots || 0, row.wayback_snapshots || 0);
    existing.has_numbers = Math.max(existing.has_numbers || 0, row.has_numbers || 0);
    existing.has_hyphens = Math.max(existing.has_hyphens || 0, row.has_hyphens || 0);
    existing.length = Math.min(existing.length || 63, row.length || 63);
    existing.latest_seen_at = String(row.latest_seen_at || '') > String(existing.latest_seen_at || '')
      ? row.latest_seen_at
      : existing.latest_seen_at;
    existing.was_available = Math.max(existing.was_available || 0, row.was_available || 0);
    existing.due_bucket = Math.min(existing.due_bucket ?? 5, row.due_bucket ?? 5);
  }

  return [...byDomain.values()].sort((a, b) => {
    if ((a.due_bucket ?? 5) !== (b.due_bucket ?? 5)) return (a.due_bucket ?? 5) - (b.due_bucket ?? 5);
    if ((a.was_available || 0) !== (b.was_available || 0)) return (b.was_available || 0) - (a.was_available || 0);
    if ((a.has_numbers || 0) !== (b.has_numbers || 0)) return (a.has_numbers || 0) - (b.has_numbers || 0);
    if ((a.has_hyphens || 0) !== (b.has_hyphens || 0)) return (a.has_hyphens || 0) - (b.has_hyphens || 0);
    const aLengthBand = (a.length || 63) >= 3 && (a.length || 63) <= 12 ? 0 : 1;
    const bLengthBand = (b.length || 63) >= 3 && (b.length || 63) <= 12 ? 0 : 1;
    if (aLengthBand !== bLengthBand) return aLengthBand - bLengthBand;
    if ((a.tlds_taken || 0) !== (b.tlds_taken || 0)) return (b.tlds_taken || 0) - (a.tlds_taken || 0);
    if ((a.length || 63) !== (b.length || 63)) return (a.length || 63) - (b.length || 63);
    return String(b.latest_seen_at || '').localeCompare(String(a.latest_seen_at || ''));
  });
}

function querySegment(where, bucket, orderBy, params, limit) {
  const segmentLimit = Math.min(5000, Math.max(limit * 4, 200));
  return db.prepare(`
    SELECT ${candidateProjectionSql(bucket)}
    FROM domains
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT @segmentLimit
  `).all({ ...params, segmentLimit });
}

function queryFastSingleTldCandidates(tld, options, limit) {
  const params = candidateParams(options, limit);
  params.tld = tld;
  const excluded = EXCLUDED_STREAMS.map(stream => `'${stream}'`).join(',');
  const due = availabilityDueSql();
  const rows = [];

  rows.push(...querySegment(
    `stream = 'just-dropped' AND tld = @tld AND ${due}`,
    0,
    'has_numbers ASC, has_hyphens ASC, CASE WHEN length BETWEEN 3 AND 12 THEN 0 ELSE 1 END ASC, tlds_taken DESC, length ASC, discovered_at DESC, domain ASC',
    params,
    limit
  ));
  rows.push(...querySegment(
    `stream NOT IN (${excluded}) AND stream != 'just-dropped' AND tld = @tld AND drop_date IS NOT NULL AND date(drop_date) <= date('now') AND ${due}`,
    1,
    'has_numbers ASC, has_hyphens ASC, CASE WHEN length BETWEEN 3 AND 12 THEN 0 ELSE 1 END ASC, tlds_taken DESC, length ASC, discovered_at DESC, domain ASC',
    params,
    limit
  ));
  rows.push(...querySegment(
    `stream = 'pending-delete' AND tld = @tld AND expiry_date IS NOT NULL AND datetime(expiry_date) <= datetime('now') AND ${due}`,
    2,
    'has_numbers ASC, has_hyphens ASC, CASE WHEN length BETWEEN 3 AND 12 THEN 0 ELSE 1 END ASC, tlds_taken DESC, length ASC, discovered_at DESC, domain ASC',
    params,
    limit
  ));
  rows.push(...querySegment(
    `stream = 'discovered' AND tld = @tld AND expiry_date IS NOT NULL AND datetime(expiry_date) <= datetime('now') AND ${due}`,
    2,
    'has_numbers ASC, has_hyphens ASC, CASE WHEN length BETWEEN 3 AND 12 THEN 0 ELSE 1 END ASC, tlds_taken DESC, length ASC, discovered_at DESC, domain ASC',
    params,
    limit
  ));
  rows.push(...querySegment(
    `stream = 'pending-delete' AND tld = @tld AND auction_end IS NOT NULL AND datetime(auction_end) <= datetime('now') AND ${due}`,
    2,
    'has_numbers ASC, has_hyphens ASC, CASE WHEN length BETWEEN 3 AND 12 THEN 0 ELSE 1 END ASC, tlds_taken DESC, length ASC, discovered_at DESC, domain ASC',
    params,
    limit
  ));
  rows.push(...querySegment(
    `stream NOT IN (${excluded}) AND tld = @tld AND dns_available = 1 AND ${due}`,
    3,
    'has_numbers ASC, has_hyphens ASC, CASE WHEN length BETWEEN 3 AND 12 THEN 0 ELSE 1 END ASC, tlds_taken DESC, length ASC, discovered_at DESC, domain ASC',
    params,
    limit
  ));
  rows.push(...querySegment(
    `stream NOT IN (${excluded}) AND tld = @tld AND registration_available = 1 AND ${due}`,
    4,
    'has_numbers ASC, has_hyphens ASC, CASE WHEN length BETWEEN 3 AND 12 THEN 0 ELSE 1 END ASC, tlds_taken DESC, length ASC, discovered_at DESC, domain ASC',
    params,
    limit
  ));

  return mergeCandidateRows(rows).slice(0, limit);
}

function queryCandidates(tlds, options, limit) {
  if (process.env.DOMAINSCOUT_EXPIRED_FAST_CANDIDATES !== '0' && tlds.length === 1) {
    return queryFastSingleTldCandidates(tlds[0], options, limit);
  }
  const params = candidateParams(options, limit);
  tlds.forEach((tld, i) => { params[`tld${i}`] = tld; });
  return db.prepare(candidateQuery(tlds)).all(params);
}

function resolveAvailabilityTlds(options = {}) {
  const explicitTlds = normalizeTlds(options.tlds || process.env.DOMAINSCOUT_EXPIRED_AVAILABILITY_TLDS);
  const globalBlockedTlds = registrarBlockedTlds();
  const globalCooledTlds = cooldownTlds(options);
  const blockedTlds = explicitTlds.length
    ? intersectTlds(globalBlockedTlds, explicitTlds)
    : globalBlockedTlds;
  const cooledTlds = explicitTlds.length
    ? intersectTlds(globalCooledTlds, explicitTlds)
    : globalCooledTlds;
  const unavailableTlds = [...blockedTlds, ...cooledTlds];
  const tlds = explicitTlds.length
    ? withoutTlds(explicitTlds, options.includeCooldowns ? blockedTlds : unavailableTlds)
    : withoutTlds(
      normalizeTlds(options.priorityTlds || defaultPriorityTlds()),
      options.includeBlocked ? cooledTlds : unavailableTlds
    );
  return { explicitTlds, blockedTlds, cooledTlds, tlds };
}

function getAvailabilityBacklogSignature(options = {}) {
  const { blockedTlds, cooledTlds, tlds } = resolveAvailabilityTlds(options);
  const params = candidateParams(options, 1);
  const cooldowns = getAvailabilityCooldowns();
  return JSON.stringify({
    tlds,
    blockedTlds,
    cooledTlds,
    cooldowns: Object.fromEntries(
      cooledTlds.map(tld => [tld, cooldowns[tld]?.until || null])
    ),
    errorRefresh: params.errorRefresh,
    unknownRefresh: params.unknownRefresh,
    unavailableRefresh: params.unavailableRefresh,
    availableRefresh: params.availableRefresh,
  });
}

function summarizeBacklogRows(rows) {
  const byTld = {};
  const byBucket = {};
  let total = 0;
  for (const row of rows) {
    const tld = String(row.tld || 'unknown');
    const bucket = String(row.due_bucket ?? 'unknown');
    const n = Number(row.n || 0);
    byTld[tld] = (byTld[tld] || 0) + n;
    byBucket[bucket] = (byBucket[bucket] || 0) + n;
    total += n;
  }
  return { total, byTld, byBucket };
}

function estimateBacklogForTlds(tlds, params) {
  if (!tlds.length) return { total: 0, byTld: {}, byBucket: {} };
  if (process.env.DOMAINSCOUT_EXPIRED_BACKLOG_ESTIMATE_MODE !== 'grouped') {
    return estimateBacklogForTldsSegmented(tlds, params);
  }
  return summarizeBacklogRows(db.prepare(backlogEstimateQuery(tlds)).all(
    tlds.reduce((acc, tld, i) => {
      acc[`tld${i}`] = tld;
      return acc;
    }, { ...params })
  ));
}

function backlogEstimateSegmentedQuery() {
  const excluded = EXCLUDED_STREAMS.map(stream => `'${stream}'`).join(',');
  const due = availabilityDueSql();
  return `
    WITH raw AS (
      SELECT domain, tld, 0 AS due_bucket
      FROM domains
      WHERE stream = 'just-dropped'
        AND tld = @tld
        AND ${due}

      UNION ALL
      SELECT domain, tld, 1 AS due_bucket
      FROM domains
      WHERE stream NOT IN (${excluded})
        AND stream != 'just-dropped'
        AND tld = @tld
        AND drop_date IS NOT NULL
        AND date(drop_date) <= date('now')
        AND ${due}

      UNION ALL
      SELECT domain, tld, 2 AS due_bucket
      FROM domains
      WHERE stream NOT IN (${excluded})
        AND stream != 'just-dropped'
        AND tld = @tld
        AND expiry_date IS NOT NULL
        AND datetime(expiry_date) <= datetime('now')
        AND ${due}

      UNION ALL
      SELECT domain, tld, 2 AS due_bucket
      FROM domains
      WHERE stream = 'pending-delete'
        AND tld = @tld
        AND auction_end IS NOT NULL
        AND datetime(auction_end) <= datetime('now')
        AND ${due}

      UNION ALL
      SELECT domain, tld, 3 AS due_bucket
      FROM domains
      WHERE stream NOT IN (${excluded})
        AND tld = @tld
        AND dns_available = 1
        AND ${due}

      UNION ALL
      SELECT domain, tld, 4 AS due_bucket
      FROM domains
      WHERE stream NOT IN (${excluded})
        AND tld = @tld
        AND registration_available = 1
        AND ${due}
    ),
    candidates AS (
      SELECT domain, MIN(tld) AS tld, MIN(due_bucket) AS due_bucket
      FROM raw
      GROUP BY domain
    )
    SELECT tld, due_bucket, COUNT(*) AS n
    FROM candidates
    GROUP BY tld, due_bucket
  `;
}

const segmentedBacklogEstimate = db.prepare(backlogEstimateSegmentedQuery());

function estimateBacklogForTldsSegmented(tlds, params) {
  const rows = [];
  for (const tld of tlds) {
    rows.push(...segmentedBacklogEstimate.all({ ...params, tld }));
  }
  return summarizeBacklogRows(rows);
}

function estimateAvailabilityBacklog(options = {}) {
  const started = Date.now();
  const { blockedTlds, cooledTlds, tlds } = resolveAvailabilityTlds(options);
  const params = candidateParams(options, 1);
  const eligible = estimateBacklogForTlds(tlds, params);
  const paused = estimateBacklogForTlds(cooledTlds, params);
  const blocked = estimateBacklogForTlds(blockedTlds, params);
  const allCooldowns = getAvailabilityCooldowns();
  const cooldowns = Object.fromEntries(
    cooledTlds
      .filter(tld => allCooldowns[tld])
      .map(tld => [tld, allCooldowns[tld]])
  );
  return {
    total: eligible.total,
    byTld: eligible.byTld,
    byBucket: eligible.byBucket,
    pausedTotal: paused.total,
    pausedByTld: paused.byTld,
    pausedByBucket: paused.byBucket,
    blockedTotal: blocked.total,
    blockedByTld: blocked.byTld,
    blockedByBucket: blocked.byBucket,
    cooldowns,
    tlds,
    blockedTlds,
    cooledTlds,
    signature: getAvailabilityBacklogSignature(options),
    elapsedMs: Date.now() - started,
  };
}

function roundRobinCandidateRows(rowsByTld, limit, seen = new Set(), selected = []) {
  const maxRows = rowsByTld.reduce((max, rows) => Math.max(max, rows.length), 0);

  for (let i = 0; i < maxRows && selected.length < limit; i++) {
    for (const rows of rowsByTld) {
      const row = rows[i];
      if (!row) continue;
      if (seen.has(row.domain)) continue;
      seen.add(row.domain);
      selected.push(row);
      if (selected.length >= limit) return selected;
    }
  }

  return selected;
}

function selectAvailabilityCandidates(options = {}) {
  const limit = positiveInt(
    options.limit || process.env.DOMAINSCOUT_EXPIRED_AVAILABILITY_LIMIT,
    300,
    1,
    5000
  );
  const { explicitTlds, blockedTlds, cooledTlds, tlds } = resolveAvailabilityTlds(options);
  if (explicitTlds.length) {
    if (tlds.length === 0) return [];
    return queryCandidates(tlds, options, limit);
  }

  const unavailableTlds = [...blockedTlds, ...cooledTlds];
  const priorityTlds = tlds;
  if (priorityTlds.length === 0) return [];
  const fairEnabled = options.fair !== false && process.env.DOMAINSCOUT_EXPIRED_FAIR_PRIORITY !== '0' && priorityTlds.length > 0;
  if (!fairEnabled) return queryCandidates(priorityTlds, options, limit);

  const perTldLimit = positiveInt(
    options.perTldLimit || process.env.DOMAINSCOUT_EXPIRED_PRIORITY_PER_TLD_LIMIT,
    Math.max(20, Math.floor(limit / Math.max(1, priorityTlds.length))),
    1,
    limit
  );
  const rowsByTld = priorityTlds.map(tld =>
    queryCandidates([tld], options, Math.min(perTldLimit, limit))
  );
  const selected = roundRobinCandidateRows(rowsByTld, limit);
  if (selected.length >= limit) return selected.slice(0, limit);
  const seen = new Set(selected.map(row => row.domain));

  if (selected.length < limit) {
    const expandedRowsByTld = priorityTlds.map(tld =>
      queryCandidates([tld], options, limit)
    );
    roundRobinCandidateRows(expandedRowsByTld, limit, seen, selected);
    if (selected.length >= limit) return selected.slice(0, limit);
  }

  if (selected.length < limit && unavailableTlds.length === 0) {
    const rows = queryCandidates([], options, limit);
    for (const row of rows) {
      if (seen.has(row.domain)) continue;
      seen.add(row.domain);
      selected.push(row);
      if (selected.length >= limit) break;
    }
  }

  return selected.slice(0, limit);
}

function hydrateExplicitCandidates(domains) {
  const unique = [...new Set(
    domains
      .map(domain => String(domain || '').trim().toLowerCase())
      .filter(Boolean)
  )];
  if (unique.length === 0) return [];

  const rowsByDomain = new Map();
  for (let i = 0; i < unique.length; i += 900) {
    const batch = unique.slice(i, i + 900);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT
        domain,
        MIN(tld) AS tld,
        MAX(COALESCE(tlds_taken, 0)) AS tlds_taken,
        MAX(COALESCE(age_years, 0)) AS age_years,
        MAX(COALESCE(wayback_snapshots, 0)) AS wayback_snapshots,
        MAX(COALESCE(has_numbers, 0)) AS has_numbers,
        MAX(COALESCE(has_hyphens, 0)) AS has_hyphens,
        MIN(CASE
          WHEN length IS NULL OR length <= 0 THEN LENGTH(SUBSTR(domain, 1, INSTR(domain, '.') - 1))
          ELSE length
        END) AS length,
        MAX(discovered_at) AS latest_seen_at
      FROM domains
      WHERE domain IN (${placeholders})
      GROUP BY domain
    `).all(...batch);
    for (const row of rows) rowsByDomain.set(row.domain, row);
  }

  return unique.map(domain => {
    if (rowsByDomain.has(domain)) return rowsByDomain.get(domain);
    const dot = domain.lastIndexOf('.');
    return {
      domain,
      tld: dot >= 0 ? domain.slice(dot) : '',
      tlds_taken: 0,
      age_years: 0,
      wayback_snapshots: 0,
      has_numbers: /[0-9]/.test(domain) ? 1 : 0,
      has_hyphens: domain.includes('-') ? 1 : 0,
      length: dot > 0 ? dot : domain.length,
      latest_seen_at: null,
    };
  });
}

const updateAvailability = db.prepare(`
  UPDATE domains SET
    dns_available = COALESCE(@dns_available, dns_available),
    registration_available = CASE
      WHEN @registration_available IS NOT NULL THEN @registration_available
      WHEN @availability_error = 'RDAP rate limited' THEN registration_available
      ELSE NULL
    END,
    first_available_at = CASE
      WHEN @registration_available = 1 THEN COALESCE(first_available_at, @availability_checked_at)
      WHEN @registration_available = 0 THEN NULL
      WHEN @availability_error = 'RDAP rate limited' THEN first_available_at
      ELSE NULL
    END,
    availability_checked_at = @availability_checked_at,
    availability_source = @availability_source,
    availability_error = @availability_error,
    registry_expiry = CASE
      WHEN @registry_expiry IS NOT NULL THEN @registry_expiry
      WHEN @availability_error = 'RDAP rate limited' THEN registry_expiry
      ELSE registry_expiry
    END,
    quality_score = CASE
      WHEN @registration_available IS NOT NULL THEN @quality_score
      WHEN @availability_error = 'RDAP rate limited' THEN quality_score
      ELSE NULL
    END,
    quality_reasons = CASE
      WHEN @registration_available IS NOT NULL THEN @quality_reasons
      WHEN @availability_error = 'RDAP rate limited' THEN quality_reasons
      ELSE NULL
    END
  WHERE domain = @domain
`);

// Availability by itself is not proof that a name expired: random never-registered
// strings are available too. Only project a Dropped row after a cataloged source has
// supplied prior-registration/drop evidence in drop_events. source_event_at is the
// provider's actual drop day; availability_checked_at is only the later confirmation
// time. Keeping those separate prevents a historical backfill from pretending every
// old drop happened today.
const recordDropAvailability = db.prepare(`
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

const projectConfirmedDrop = db.prepare(`
  INSERT INTO domains (
    domain, base_name, tld, stream, source, status,
    age_years, wayback_snapshots, wayback_first, wayback_last,
    length, has_numbers, has_hyphens, drop_date, expiry_date, discovered_at,
    tlds_taken, tlds_checked_at, bid_count,
    dns_available, registration_available, first_available_at,
    availability_checked_at, availability_source, availability_error,
    registry_expiry, quality_score, quality_reasons
  )
  SELECT
    source_row.domain, source_row.base_name, source_row.tld,
    'just-dropped', 'Availability Confirmation', 'active',
    source_row.age_years, source_row.wayback_snapshots,
    source_row.wayback_first, source_row.wayback_last,
    source_row.length, source_row.has_numbers, source_row.has_hyphens,
    SUBSTR(drop_event.source_event_at, 1, 10),
    source_row.expiry_date,
    COALESCE(source_row.first_available_at, @availability_checked_at),
    source_row.tlds_taken, source_row.tlds_checked_at, source_row.bid_count,
    @dns_available, 1, COALESCE(source_row.first_available_at, @availability_checked_at),
    @availability_checked_at, @availability_source, NULL,
    @registry_expiry, source_row.quality_score, source_row.quality_reasons
  FROM domains source_row
  JOIN drop_events drop_event
    ON drop_event.domain = source_row.domain
   AND drop_event.released_at IS NOT NULL
   AND drop_event.registration_available = 1
  WHERE source_row.domain = @domain
  ORDER BY CASE source_row.stream
    WHEN 'just-dropped' THEN 0
    WHEN 'pending-delete' THEN 1
    WHEN 'discovered' THEN 2
    ELSE 9
  END, drop_event.source_event_at DESC, source_row.id
  LIMIT 1
  ON CONFLICT(domain, stream) DO UPDATE SET
    status = 'active',
    dns_available = COALESCE(excluded.dns_available, domains.dns_available),
    registration_available = 1,
    first_available_at = COALESCE(domains.first_available_at, excluded.first_available_at),
    availability_checked_at = excluded.availability_checked_at,
    availability_source = excluded.availability_source,
    availability_error = NULL,
    registry_expiry = COALESCE(excluded.registry_expiry, domains.registry_expiry),
    drop_date = excluded.drop_date,
    quality_score = excluded.quality_score,
    quality_reasons = excluded.quality_reasons
`);

function projectConfirmedDrops(items) {
  const confirmed = (items || []).filter(item => item && item.registration_available === 1);
  if (!confirmed.length) return 0;
  let changes = 0;
  db.transaction(rows => {
    for (const item of rows) {
      if (recordDropAvailability.run(item).changes === 0) continue;
      changes += projectConfirmedDrop.run(item).changes;
    }
  })(confirmed);
  return changes;
}

const logRun = db.prepare(`
  INSERT INTO scrape_log (stream, domains_found, domains_new, error)
  VALUES (@stream, @domains_found, @domains_new, @error)
`);

const updateRun = db.prepare(`
  UPDATE scrape_log
  SET domains_found = @domains_found,
      domains_new = @domains_new,
      error = @error
  WHERE id = @id
`);

function summarizeResults(results) {
  return {
    checked: results.length,
    available: results.filter(r => r.registration_available === 1).length,
    unavailable: results.filter(r => r.registration_available === 0).length,
    unknown: results.filter(r => r.registration_available == null).length,
  };
}

function rateLimitedTlds(results) {
  const tlds = new Set();
  for (const result of results) {
    if (result.registration_available != null) continue;
    if (result.availability_error !== 'RDAP rate limited') continue;
    const tld = tldFromDomain(result.domain);
    if (tld) tlds.add(tld);
  }
  return tlds;
}

function updateProgress(runId, summary, error = null) {
  updateRun.run({
    id: runId,
    domains_found: summary.checked,
    domains_new: summary.available,
    error,
  });
}

async function refreshExpiredAvailability(options = {}) {
  const candidates = Array.isArray(options.domains)
    ? hydrateExplicitCandidates(options.domains)
    : selectAvailabilityCandidates(options);

  const hasRateLimitedRegistry = candidates.some(row =>
    ['.org', '.app', '.dev', '.ai', '.io', '.sh'].includes(String(row.tld || '').toLowerCase())
  );
  const defaultConcurrency = hasRateLimitedRegistry ? 2 : 5;
  const defaultDelayMs = hasRateLimitedRegistry ? 1000 : 300;
  const concurrency = positiveInt(
    options.concurrency ?? process.env.DOMAINSCOUT_EXPIRED_AVAILABILITY_CONCURRENCY,
    defaultConcurrency,
    1,
    25
  );
  const delayMs = positiveInt(
    options.delayMs ?? process.env.DOMAINSCOUT_EXPIRED_AVAILABILITY_DELAY_MS,
    defaultDelayMs,
    0,
    10_000
  );
  const perDomainTimeoutMs = positiveInt(
    options.perDomainTimeoutMs ?? process.env.DOMAINSCOUT_EXPIRED_AVAILABILITY_DOMAIN_TIMEOUT_MS,
    15_000,
    1_000,
    60_000
  );

  if (candidates.length === 0) {
    console.log('[ExpiredAvailability] No due candidates to check');
    logRun.run({
      stream: 'expired-availability',
      domains_found: 0,
      domains_new: 0,
      error: null,
    });
    return { candidates: 0, checked: 0, available: 0, unavailable: 0, unknown: 0 };
  }

  console.log(
    `[ExpiredAvailability] Checking ${candidates.length} due dropped/expired candidates ` +
    `(concurrency ${concurrency}, delay ${delayMs}ms)...`
  );

  const results = [];
  const runInfo = logRun.run({
    stream: 'expired-availability',
    domains_found: 0,
    domains_new: 0,
    error: null,
  });
  const runId = Number(runInfo.lastInsertRowid);
  const rateLimitStopThreshold = positiveInt(
    options.rateLimitStopThreshold ?? process.env.DOMAINSCOUT_EXPIRED_RDAP_RATE_LIMIT_STOP_THRESHOLD,
    10,
    1,
    1000
  );
  const rateLimitStreakByTld = new Map();
  const pausedTlds = new Set();
  const pausedTldMessages = [];
  let cooldownSeen = false;

  let cursor = 0;
  while (cursor < candidates.length) {
    const batch = [];
    while (cursor < candidates.length && batch.length < concurrency) {
      const row = candidates[cursor++];
      const tld = String(row.tld || tldFromDomain(row.domain) || '').toLowerCase();
      if (pausedTlds.has(tld)) continue;
      batch.push(row);
    }
    if (batch.length === 0) break;

    const checkedAt = new Date().toISOString();
    const batchResults = await Promise.all(batch.map(async (row) => {
      let result;
      try {
        result = await withTimeout(
          checkRegistrationAvailability(row.domain),
          perDomainTimeoutMs,
          'availability timeout'
        );
      } catch (err) {
        result = {
          dns_available: null,
          registration_available: null,
          availability_source: 'rdap+dns',
          availability_error: err?.message || 'availability timeout',
        };
      }
      return {
        domain: row.domain,
        dns_available: result.dns_available,
        registration_available: result.registration_available,
        registry_expiry: result.registry_expiry_date || null,
        availability_checked_at: checkedAt,
        availability_source: result.availability_source || 'rdap+dns',
        availability_error: result.availability_error || null,
        availability_retry_after_ms: result.availability_retry_after_ms || null,
        ...computeDomainQuality({
          ...row,
          dns_available: result.dns_available,
          registration_available: result.registration_available,
          availability_source: result.availability_source || 'rdap+dns',
        }),
      };
    }));
    results.push(...batchResults);

    db.transaction((items) => {
      for (const item of items) {
        updateAvailability.run(item);
        const evidenceChanges = recordDropAvailability.run(item).changes;
        if (item.registration_available === 1 && evidenceChanges > 0) {
          projectConfirmedDrop.run(item);
        }
      }
    })(batchResults.map(({ availability_retry_after_ms, ...item }) => item));

    const summary = summarizeResults(results);
    updateProgress(runId, summary);

    const limitedTlds = rateLimitedTlds(batchResults);
    if (limitedTlds.size > 0) cooldownSeen = true;
    for (const row of batchResults) {
      const tld = tldFromDomain(row.domain);
      if (!tld) continue;
      if (row.registration_available == null && row.availability_error === 'RDAP rate limited') {
        rateLimitStreakByTld.set(tld, (rateLimitStreakByTld.get(tld) || 0) + 1);
      } else {
        rateLimitStreakByTld.set(tld, 0);
        if (row.registration_available != null) clearAvailabilityCooldown(tld);
      }
      if (!pausedTlds.has(tld) && rateLimitStreakByTld.get(tld) >= rateLimitStopThreshold) {
        pausedTlds.add(tld);
        const cooldown = recordAvailabilityCooldown(tld, {
          retryAfterMs: row.availability_retry_after_ms,
          reason: 'RDAP rate limited',
        });
        pausedTldMessages.push(
          `${tld} paused after ${rateLimitStreakByTld.get(tld)} consecutive RDAP rate-limited checks` +
          (cooldown?.until ? ` until ${cooldown.until}` : '')
        );
      }
    }

    if (cursor < candidates.length) {
      await sleep(cooldownSeen ? Math.min(delayMs, 100) : delayMs);
    }
  }

  const summary = {
    candidates: candidates.length,
    ...summarizeResults(results),
    stoppedEarly: pausedTldMessages.length ? pausedTldMessages.join('; ') : null,
  };
  updateProgress(runId, summary);

  console.log(
    `[ExpiredAvailability] Done: ${summary.checked} checked, ` +
    `${summary.available} available, ${summary.unavailable} unavailable, ${summary.unknown} unknown` +
    (summary.stoppedEarly ? ` (${summary.stoppedEarly})` : '')
  );

  return summary;
}

module.exports = {
  EXCLUDED_STREAMS,
  estimateAvailabilityBacklog,
  getAvailabilityCooldowns,
  getAvailabilityBacklogSignature,
  roundRobinCandidateRows,
  projectConfirmedDrops,
  refreshExpiredAvailability,
  selectAvailabilityCandidates,
};
