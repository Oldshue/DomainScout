#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../.env'), quiet: true });

const {
  checkGoDaddyRegistrationAvailability,
  checkRegistrationAvailability,
} = require('../enrichment');

const DEFAULT_BASE_URL = 'http://localhost:3737';
const DEFAULT_TLDS = ['.sh', '.ai', '.com', '.io', '.bot', '.net', '.org', '.dev', '.app', '.co', '.xyz'];
// Dogfood canaries only. Production Expired visibility is driven by persisted
// availability evidence, not this list.
const UNAVAILABLE_CANARIES = ['look.io', 'wait.com', 'cgc.com', 'ichi.com', 'amon.com'];

const baseUrl = String(process.env.DOMAINSCOUT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const priorityTlds = String(process.env.DOMAINSCOUT_DOGFOOD_TLDS || DEFAULT_TLDS.join(','))
  .split(',')
  .map(tld => tld.trim())
  .filter(Boolean)
  .map(tld => tld.startsWith('.') ? tld : `.${tld}`);
const requestTimeoutMs = parseInt(process.env.DOMAINSCOUT_DOGFOOD_TIMEOUT_MS || '15000', 10);
const maxExpiredMs = parseInt(process.env.DOMAINSCOUT_DOGFOOD_EXPIRED_MAX_MS || '2000', 10);
const maxExpiringMs = parseInt(process.env.DOMAINSCOUT_DOGFOOD_EXPIRING_MAX_MS || '15000', 10);
const maxDroppedMs = parseInt(process.env.DOMAINSCOUT_DOGFOOD_DROPPED_MAX_MS || '3000', 10);
const liveSampleSize = Math.max(0, parseInt(process.env.DOMAINSCOUT_DOGFOOD_LIVE_SAMPLE_SIZE || '3', 10) || 0);
const liveCheckAttempts = Math.max(1, parseInt(process.env.DOMAINSCOUT_DOGFOOD_LIVE_ATTEMPTS || '3', 10) || 1);
const maxDogfoodAgeHours = Math.max(
  1,
  Math.min(24 * 30, parseInt(process.env.DOMAINSCOUT_EXPIRED_DOGFOOD_MAX_AGE_HOURS || '3', 10) || 3)
);
const maxAvailabilityAgeHours = Math.max(
  1,
  Math.min(24 * 30, parseInt(process.env.DOMAINSCOUT_EXPIRED_VISIBLE_MAX_AGE_HOURS || '24', 10) || 24)
);

const failures = [];
const warnings = [];
const results = [];
const liveExpiredSamples = [];
const expiredTotalsByTld = {};
let registrarReadiness = null;
let expiredAvailabilityReadiness = null;
let expiredVisibilityReadiness = null;
let expiredEndpointSummary = null;

function activeCooldowns() {
  return expiredAvailabilityReadiness?.cooldowns || {};
}

function isTldCoolingDown(tld) {
  return Boolean(activeCooldowns()[String(tld || '').toLowerCase()]);
}

function countByKey(target, key, status) {
  if (!key) key = 'unknown';
  target[key] ||= { available: 0, unavailable: 0, unknown: 0, checked: 0 };
  target[key][status] += 1;
  target[key].checked += 1;
}

function isAvailability(value, target) {
  return value === target || value === String(target);
}

function fail(message, context = {}) {
  failures.push({ message, ...context });
}

function warn(message, context = {}) {
  warnings.push({ message, ...context });
}

function ageHoursFromMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? Number((n / 3_600_000).toFixed(2)) : null;
}

function countRowsByTld(rows) {
  const byTld = {};
  for (const row of rows) {
    const tld = String(row.tld || '').toLowerCase() || 'unknown';
    byTld[tld] = (byTld[tld] || 0) + 1;
  }
  return byTld;
}

function normalizeCountMap(value) {
  const out = {};
  for (const [key, rawCount] of Object.entries(value || {})) {
    const normalizedKey = String(key || '').toLowerCase();
    const count = Number(rawCount || 0);
    if (normalizedKey && Number.isFinite(count) && count !== 0) out[normalizedKey] = count;
  }
  return out;
}

function countMapsEqual(left, right) {
  const a = normalizeCountMap(left);
  const b = normalizeCountMap(right);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (Number(a[key] || 0) !== Number(b[key] || 0)) return false;
  }
  return true;
}

function dueSampleCount(expiredAvailability) {
  return Number(expiredAvailability?.dueSample?.count || 0);
}

function refreshExpiredAvailabilitySnapshot(target, fresh) {
  if (!target || !fresh) return;
  const fields = [
    'running',
    'active',
    'cooldowns',
    'cooldownRetry',
    'scheduledLimit',
    'scheduledCron',
    'latest',
    'latestAttempt',
    'dueSample',
    'dueEstimate',
    'error',
  ];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(fresh, field)) target[field] = fresh[field];
  }
  target.snapshotChangedDuringDogfood = true;
}

function assertCandidateSupplyBacklog(expiredCandidateSupply, dueEstimate, expiredAvailability) {
  const dueByTld = dueEstimate.byTld || {};
  for (const [tld, supply] of Object.entries(expiredCandidateSupply.byTld || {})) {
    const supplyDue = Number(supply?.expiredAvailabilityUnverified || 0);
    const verifierDue = Number(dueByTld[tld] || 0);
    if (supplyDue <= verifierDue) continue;
    const context = {
      tld,
      supplyDue,
      verifierDue,
      supply,
      dueEstimate,
    };
    if (expiredAvailability.running || expiredAvailability.snapshotChangedDuringDogfood) {
      warn('expired candidate supply/backlog snapshot changed during dogfood', context);
    } else {
      fail('expired candidate supply has availability-due rows missing from verifier backlog', context);
    }
  }
}

function keysOutsideScope(value, tld) {
  const scoped = String(tld || '').toLowerCase();
  return Object.keys(value || {})
    .map(key => String(key || '').toLowerCase())
    .filter(key => key && key !== scoped);
}

function endpoint(path, params = {}) {
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchJson(label, path, params = {}, timeoutMsOverride = requestTimeoutMs) {
  const url = endpoint(path, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMsOverride);
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
    const elapsedMs = Date.now() - started;
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      fail(`${label} returned HTTP ${response.status}`, { url: url.toString(), elapsedMs });
      return { elapsedMs, data: null };
    }
    if (!contentType.includes('application/json')) {
      fail(`${label} returned non-JSON`, { url: url.toString(), contentType, elapsedMs });
      return { elapsedMs, data: null };
    }
    return { elapsedMs, data: await response.json() };
  } catch (err) {
    fail(`${label} request failed`, { url: url.toString(), error: err.message || String(err) });
    return { elapsedMs: Date.now() - started, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function postJsonRaw(label, path, body = {}) {
  const url = endpoint(path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - started;
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : null;
    return { elapsedMs, status: response.status, ok: response.ok, data };
  } catch (err) {
    fail(`${label} request failed`, { url: url.toString(), error: err.message || String(err) });
    return { elapsedMs: Date.now() - started, status: null, ok: false, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

function assertNoDuplicateDomains(label, rows) {
  const seen = new Set();
  const duplicates = [];
  for (const row of rows) {
    const domain = String(row.domain || '').toLowerCase();
    if (!domain) continue;
    if (seen.has(domain)) duplicates.push(domain);
    seen.add(domain);
  }
  if (duplicates.length) fail(`${label} contains duplicate domains`, { duplicates: [...new Set(duplicates)].slice(0, 20) });
}

function assertExpiredRows(label, rows) {
  assertNoDuplicateDomains(label, rows);
  const now = Date.now();
  const registrarRequired = new Set(
    (registrarReadiness?.registrarRequiredAvailableTlds || [])
      .map(tld => String(tld || '').toLowerCase())
  );
  for (const row of rows) {
    if (!isAvailability(row.registration_available, 1)) {
      fail(`${label} contains a row that is not confirmed available`, {
        domain: row.domain,
        registration_available: row.registration_available,
        availability_source: row.availability_source,
        availability_error: row.availability_error,
      });
    }
    if (row.availability_error) {
      fail(`${label} contains availability_error`, {
        domain: row.domain,
        availability_error: row.availability_error,
      });
    }
    const qualityScore = Number(row.quality_score);
    if (!Number.isFinite(qualityScore) || qualityScore <= 0) {
      fail(`${label} contains a row without a positive quality_score`, {
        domain: row.domain,
        quality_score: row.quality_score,
      });
    }
    if (!String(row.quality_reasons || '').trim()) {
      fail(`${label} contains a row without quality_reasons`, {
        domain: row.domain,
        quality_reasons: row.quality_reasons,
      });
    }
    const rowTld = String(row.tld || '').toLowerCase();
    const source = String(row.availability_source || '').toLowerCase();
    if (registrarRequired.has(rowTld) && !source.startsWith('registrar')) {
      fail(`${label} contains registrar-required row without registrar evidence`, {
        domain: row.domain,
        tld: row.tld,
        availability_source: row.availability_source,
      });
    }
    const checkedAtMs = Date.parse(row.availability_checked_at || '');
    if (!Number.isFinite(checkedAtMs)) {
      fail(`${label} contains a row without availability_checked_at`, { domain: row.domain });
    } else {
      const ageHours = (now - checkedAtMs) / 3_600_000;
      if (ageHours > maxAvailabilityAgeHours) {
        fail(`${label} contains stale availability evidence`, {
          domain: row.domain,
          availability_checked_at: row.availability_checked_at,
          ageHours: Number(ageHours.toFixed(2)),
          maxAvailabilityAgeHours,
        });
      }
    }
  }
}

function rotatedSampleRows(rows, sampleSize, seedLabel = '') {
  if (sampleSize <= 0 || rows.length === 0) return [];
  const seed = Math.floor(Date.now() / 3_600_000) + [...seedLabel].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const selected = [];
  const count = Math.min(sampleSize, rows.length);
  for (let i = 0; i < count; i += 1) {
    selected.push(rows[(seed + i) % rows.length]);
  }
  return selected;
}

function assertDueSampleBalance(expiredAvailability, dueEstimate) {
  const dueSample = expiredAvailability.dueSample || {};
  if (!dueSample.saturated) return;
  const sampleByTld = dueSample.byTld || {};
  const estimateByTld = dueEstimate.byTld || {};
  const limit = Number(dueSample.limit || dueSample.count || 0);
  const sampleTotal = Number(dueSample.count || 0);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(sampleTotal) || sampleTotal <= 0) return;

  const materialBacklogs = Object.entries(estimateByTld)
    .map(([tld, count]) => [tld, Number(count || 0)])
    .filter(([, count]) => count >= Math.max(50, limit * 0.1));
  if (materialBacklogs.length < 2) return;

  const sampleEntries = Object.entries(sampleByTld)
    .map(([tld, count]) => [tld, Number(count || 0)])
    .sort((a, b) => b[1] - a[1]);
  const [dominantTld, dominantCount] = sampleEntries[0] || [];
  if (dominantTld && dominantCount / sampleTotal > 0.75) {
    fail('expired availability due sample is imbalanced across material TLD backlogs', {
      dominantTld,
      dominantShare: Number((dominantCount / sampleTotal).toFixed(3)),
      sampleByTld,
      materialBacklogs: Object.fromEntries(materialBacklogs),
    });
  }
}

async function checkExpiredTld(tld) {
  const label = `expired ${tld}`;
  const { elapsedMs, data } = await fetchJson(label, '/api/domains', {
    stream: '_expired90',
    tld,
    sortField: 'quality_score',
    sortDir: 'DESC',
    page: 1,
    limit: 100,
  });
  if (!data) return;
  const rows = Array.isArray(data.domains) ? data.domains : [];
  const bySource = {};
  for (const row of rows) {
    const source = String(row.availability_source || 'unknown');
    bySource[source] = (bySource[source] || 0) + 1;
  }
  expiredTotalsByTld[tld] = Number(data.total || 0);
  results.push({ label, elapsedMs, total: data.total, checkedRows: rows.length, bySource });
  if (elapsedMs > maxExpiredMs) fail(`${label} exceeded latency budget`, { elapsedMs, maxExpiredMs });
  if (Number(data.total || 0) > 0 && rows.length === 0) fail(`${label} reported total rows but returned none`, { total: data.total });
  if (Number(data.total || 0) === 0 && ['.sh', '.ai'].includes(tld)) {
    warn(`${label} currently has no confirmed available rows`, { total: data.total });
  }
  assertExpiredRows(label, rows);
  const cooldown = activeCooldowns()[tld];
  if (cooldown) {
    results.push({
      label: `${label} live samples skipped`,
      skippedRows: Math.min(liveSampleSize, rows.length),
      reason: cooldown.reason || 'registry cooldown',
      until: cooldown.until || null,
    });
    return;
  }
  for (const row of rotatedSampleRows(rows, liveSampleSize, tld)) {
    liveExpiredSamples.push({
      label,
      domain: row.domain,
      tld,
      storedSource: row.availability_source || null,
    });
  }
}

async function checkExpiredEndpoint() {
  const label = 'expired all-TLD endpoint';
  const { elapsedMs, data } = await fetchJson(label, '/api/domains', {
    stream: '_expired90',
    sortField: 'quality_score',
    sortDir: 'DESC',
    page: 1,
    limit: 10000,
  });
  if (!data) return null;
  const rows = Array.isArray(data.domains) ? data.domains : [];
  const total = Number(data.total || 0);
  const byTld = countRowsByTld(rows);
  expiredEndpointSummary = {
    total,
    checkedRows: rows.length,
    byTld,
    fullyChecked: rows.length >= total,
  };
  results.push({
    label,
    elapsedMs,
    total,
    checkedRows: rows.length,
    byTld,
    fullyChecked: expiredEndpointSummary.fullyChecked,
  });
  if (elapsedMs > maxExpiredMs) fail(`${label} exceeded latency budget`, { elapsedMs, maxExpiredMs });
  if (total > 0 && rows.length === 0) fail(`${label} reported total rows but returned none`, { total });
  if (!expiredEndpointSummary.fullyChecked) {
    warn(`${label} returned a partial page; visibility by-TLD comparison is limited`, {
      total,
      checkedRows: rows.length,
    });
  }
  assertExpiredRows(label, rows);
  return expiredEndpointSummary;
}

async function checkExpiredDateFiltersIgnored() {
  const label = 'expired ignores auction date filters';
  const baseParams = {
    stream: '_expired90',
    sortField: 'quality_score',
    sortDir: 'DESC',
    page: 1,
    limit: 25,
  };
  const base = await fetchJson(`${label} base`, '/api/domains', baseParams);
  const filtered = await fetchJson(label, '/api/domains', {
    ...baseParams,
    dateWindow: 'today',
    expiryToday: '1',
  });
  if (!base.data || !filtered.data) return;

  const baseDomains = (base.data.domains || []).map(row => row.domain);
  const filteredDomains = (filtered.data.domains || []).map(row => row.domain);
  results.push({
    label,
    elapsedMs: filtered.elapsedMs,
    baseTotal: base.data.total,
    filteredTotal: filtered.data.total,
    firstPageMatches: JSON.stringify(baseDomains) === JSON.stringify(filteredDomains),
  });
  if (Number(base.data.total || 0) !== Number(filtered.data.total || 0)) {
    fail(`${label} changed the expired total`, {
      baseTotal: base.data.total,
      filteredTotal: filtered.data.total,
    });
  }
  if (JSON.stringify(baseDomains) !== JSON.stringify(filteredDomains)) {
    fail(`${label} changed the first page`, {
      baseDomains,
      filteredDomains,
    });
  }
}

function assertExpiredVisibility(visibility, actualSummary = expiredEndpointSummary) {
  const label = 'expired visibility status';
  if (!visibility || typeof visibility !== 'object') {
    fail(`${label} missing from config-status`);
    return;
  }
  const byTld = visibility.byTld || {};
  const totalFromVisibility = Number(visibility.total || 0);
  const actualTotal = Number(actualSummary?.total ?? 0);
  results.push({
    label,
    total: totalFromVisibility,
    checkedRows: actualSummary?.checkedRows ?? null,
    byTld,
    actualByTld: actualSummary?.byTld || null,
    oldestAgeHours: ageHoursFromMs(visibility.oldestAgeMs),
    maxAgeHours: Number(visibility.maxAgeHours || maxAvailabilityAgeHours),
    stale: Boolean(visibility.stale),
  });
  if (!Number.isFinite(totalFromVisibility)) {
    fail(`${label} reports an invalid total`, { visibilityTotal: visibility.total });
  }
  const snapshotChanging = Boolean(
    expiredAvailabilityReadiness?.running ||
    expiredAvailabilityReadiness?.snapshotChangedDuringDogfood
  );
  if (actualSummary && totalFromVisibility !== actualTotal) {
    const context = {
      visibilityTotal: totalFromVisibility,
      apiTotal: actualTotal,
      visibilityByTld: byTld,
      apiByTld: actualSummary.byTld,
    };
    if (snapshotChanging) warn(`${label} total changed while dogfood was running`, context);
    else fail(`${label} total disagrees with Expired API totals`, context);
  }
  if (actualSummary?.fullyChecked) {
    const keys = new Set([...Object.keys(byTld), ...Object.keys(actualSummary.byTld || {})]);
    for (const tld of keys) {
      const visibleTotal = Number(byTld[tld] || 0);
      const apiTotal = Number(actualSummary.byTld[tld] || 0);
      if (visibleTotal !== apiTotal) {
        const context = {
          tld,
          visibilityTotal: visibleTotal,
          apiTotal,
        };
        if (snapshotChanging) warn(`${label} TLD count changed while dogfood was running`, context);
        else fail(`${label} TLD count disagrees with Expired API`, context);
      }
    }
  }
  if (visibility.stale) {
    fail(`${label} reports stale visible evidence`, {
      oldestCheckedAt: visibility.oldestCheckedAt,
      oldestAgeHours: ageHoursFromMs(visibility.oldestAgeMs),
      maxAgeHours: Number(visibility.maxAgeHours || maxAvailabilityAgeHours),
    });
  }
}

async function checkUnavailableCanary(domain) {
  const label = `expired canary ${domain}`;
  const { elapsedMs, data } = await fetchJson(label, '/api/domains', {
    stream: '_expired90',
    q: domain,
    page: 1,
    limit: 10,
  });
  if (!data) return;
  results.push({ label, elapsedMs, total: data.total, checkedRows: data.domains?.length || 0 });
  if (Number(data.total || 0) !== 0 || (Array.isArray(data.domains) && data.domains.length > 0)) {
    fail(`${domain} is visible in Expired`, {
      total: data.total,
      rows: (data.domains || []).map(row => ({
        domain: row.domain,
        registration_available: row.registration_available,
        availability_source: row.availability_source,
      })),
    });
  }
}

async function checkRegistrarBlockedRefresh(registrar) {
  const required = (registrar.registrarRequiredAvailableTlds || [])
    .map(tld => String(tld || '').toLowerCase())
    .filter(Boolean);
  if (registrar.configured || required.length === 0) return;

  const tld = required[0];
  const label = `blocked registrar refresh ${tld}`;
  const { elapsedMs, status, data } = await postJsonRaw(label, '/api/expired-availability-refresh', {
    tlds: [tld],
    limit: 1,
  });
  results.push({
    label,
    elapsedMs,
    status,
    blockedTlds: data?.blockedTlds || [],
    missingOrBlankEnv: data?.missingOrBlankEnv || [],
  });
  if (status !== 409) {
    fail(`${label} did not reject registrar-required refresh without credentials`, {
      status,
      response: data,
    });
  }
  if (!Array.isArray(data?.blockedTlds) || !data.blockedTlds.includes(tld)) {
    fail(`${label} did not report the blocked TLD`, {
      expected: tld,
      response: data,
    });
  }
}

async function checkRegistrarProviderProbe(registrar) {
  if (!registrar.configured) return;
  const providers = (registrar.providers || [])
    .map(provider => String(provider || '').toLowerCase())
    .filter(Boolean);
  if (!providers.includes('godaddy')) return;

  const probeDomain = String(process.env.DOMAINSCOUT_DOGFOOD_REGISTRAR_PROBE_DOMAIN || 'example.com').trim().toLowerCase();
  const label = 'registrar provider probe godaddy';
  const started = Date.now();
  const result = await checkGoDaddyRegistrationAvailability(probeDomain);
  results.push({
    label,
    elapsedMs: Date.now() - started,
    domain: probeDomain,
    status: result.status || null,
    checkType: result.checkType || null,
    error: result.error || null,
  });
  if (result.status !== 'registered') {
    fail(`${label} did not confirm a known registered domain`, {
      domain: probeDomain,
      status: result.status || null,
      error: result.error || null,
    });
  }
}

async function checkNoopRefreshForUndueTld(registrar, expiredAvailability) {
  if (expiredAvailability.running) {
    warn('noop expired refresh guard skipped because availability verifier is already running');
    return;
  }
  const byTld = expiredAvailability.dueSample?.byTld || {};
  const registrarRequired = new Set(
    (registrar.registrarRequiredAvailableTlds || [])
      .map(tld => String(tld || '').toLowerCase())
  );
  const tld = priorityTlds.find(candidate =>
    !registrarRequired.has(candidate) &&
    !isTldCoolingDown(candidate) &&
    !Object.prototype.hasOwnProperty.call(byTld, candidate)
  );
  if (!tld) return;

  const label = `noop expired refresh ${tld}`;
  const { elapsedMs, status, data } = await postJsonRaw(label, '/api/expired-availability-refresh', {
    tlds: [tld],
    limit: 1,
  });
  results.push({
    label,
    elapsedMs,
    status,
    noop: Boolean(data?.noop),
    started: Boolean(data?.started),
    duePreview: data?.duePreview || null,
  });
  if (data?.running) {
    warn(`${label} could not run because availability verifier is already running`, {
      status,
      response: data,
    });
    return;
  }
  if (status !== 200 || data?.noop !== true || data?.started) {
    fail(`${label} did not return a no-op response`, {
      status,
      response: data,
    });
  }
  const leakedCooldowns = keysOutsideScope(data?.duePreview?.cooldowns, tld);
  if (leakedCooldowns.length) {
    fail(`${label} leaked unrelated cooldowns into scoped due preview`, {
      tld,
      leakedCooldowns,
      duePreview: data?.duePreview || null,
    });
  }

  const scopedLabel = `scoped expired backlog ${tld}`;
  const scoped = await fetchJson(scopedLabel, '/api/expired-availability-backlog', { tld }, 45000);
  results.push({
    label: scopedLabel,
    elapsedMs: scoped.elapsedMs,
    total: scoped.data?.total ?? null,
    byTld: scoped.data?.byTld || {},
    pausedTotal: scoped.data?.pausedTotal ?? null,
    pausedByTld: scoped.data?.pausedByTld || {},
    blockedTotal: scoped.data?.blockedTotal ?? null,
    blockedByTld: scoped.data?.blockedByTld || {},
    cooldowns: scoped.data?.cooldowns || {},
    scopedTlds: scoped.data?.scopedTlds || [],
  });
  if (scoped.data) {
    const leakedScopedState = [
      ...keysOutsideScope(scoped.data.byTld, tld),
      ...keysOutsideScope(scoped.data.pausedByTld, tld),
      ...keysOutsideScope(scoped.data.blockedByTld, tld),
      ...keysOutsideScope(scoped.data.cooldowns, tld),
    ];
    if (leakedScopedState.length) {
      fail(`${scopedLabel} leaked unrelated TLD state`, {
        tld,
        leakedScopedState: [...new Set(leakedScopedState)],
        response: scoped.data,
      });
    }
  }
}

async function checkExpiredBacklogEstimate(expiredAvailability) {
  const hasCooldowns = Object.keys(expiredAvailability.cooldowns || {}).length > 0;
  const initialDueCount = dueSampleCount(expiredAvailability);
  if (!expiredAvailability.dueSample?.saturated && !hasCooldowns && initialDueCount <= 0) return null;
  const label = 'expired backlog estimate';
  const { elapsedMs, data } = await fetchJson(
    label,
    '/api/expired-availability-backlog',
    initialDueCount > 0 ? { force: 1 } : {},
    45000
  );
  if (!data) return null;
  let estimate = data;
  results.push({
    label,
    elapsedMs,
    forced: initialDueCount > 0,
    total: estimate.total,
    cached: Boolean(estimate.cached),
    ageHours: ageHoursFromMs(estimate.ageMs),
    estimateElapsedMs: estimate.elapsedMs ?? null,
    byTld: estimate.byTld || {},
    byBucket: estimate.byBucket || {},
    pausedTotal: estimate.pausedTotal || 0,
    pausedByTld: estimate.pausedByTld || {},
    pausedByBucket: estimate.pausedByBucket || {},
    blockedTotal: estimate.blockedTotal || 0,
    blockedByTld: estimate.blockedByTld || {},
    blockedByBucket: estimate.blockedByBucket || {},
    cooldowns: estimate.cooldowns || {},
  });
  if (!Number.isFinite(Number(estimate.total))) {
    fail(`${label} did not return a finite total`, { response: estimate });
    return estimate;
  }

  if (dueSampleCount(expiredAvailability) > Number(estimate.total)) {
    const reconciliation = await fetchJson(
      'expired availability status reconciliation',
      '/api/config-status',
      {},
      45000
    );
    const freshAvailability = reconciliation.data?.expiredAvailability || null;
    const freshEstimate = freshAvailability?.dueEstimate || null;
    if (freshAvailability) {
      refreshExpiredAvailabilitySnapshot(expiredAvailability, freshAvailability);
      expiredAvailabilityReadiness = expiredAvailability;
    }
    if (freshEstimate && Number.isFinite(Number(freshEstimate.total))) {
      estimate = freshEstimate;
    }
    results.push({
      label: 'expired availability status reconciliation',
      elapsedMs: reconciliation.elapsedMs,
      refreshed: Boolean(freshAvailability),
      running: Boolean(freshAvailability?.running),
      dueSample: freshAvailability?.dueSample || null,
      dueEstimateTotal: freshEstimate?.total ?? null,
      dueEstimateByTld: freshEstimate?.byTld || {},
    });
  }

  if (dueSampleCount(expiredAvailability) > Number(estimate.total)) {
    const context = {
      dueSample: expiredAvailability.dueSample,
      estimate,
    };
    if (expiredAvailability.running || expiredAvailability.snapshotChangedDuringDogfood) {
      warn(`${label} changed while dogfood was running`, context);
    } else {
      fail(`${label} is smaller than the due sample`, context);
    }
  }
  return estimate;
}

async function checkRegistrarReadiness() {
  const label = 'registrar readiness';
  const { elapsedMs, data } = await fetchJson(label, '/api/config-status');
  if (!data) return;
  const registrar = data.registrarAvailability || {};
  const expiredAvailability = data.expiredAvailability || {};
  const expiredDogfood = data.expiredDogfood || {};
  const expiredVisibility = data.expiredVisibility || {};
  const expiredCandidateSupply = data.expiredCandidateSupply || {};
  let dueEstimate = expiredAvailability.dueEstimate || {};
  registrarReadiness = registrar;
  expiredAvailabilityReadiness = expiredAvailability;
  expiredVisibilityReadiness = expiredVisibility;
  results.push({
    label,
    elapsedMs,
    configured: Boolean(registrar.configured),
    providers: registrar.providers || [],
    crossChecksAvailableCom: Boolean(registrar.crossChecksAvailableCom),
    availabilityCheckType: registrar.availabilityCheckType || null,
    registrarRequiredAvailableTlds: registrar.registrarRequiredAvailableTlds || [],
    missingOrBlankEnv: registrar.missingOrBlankEnv || [],
    availabilityLatestOk: expiredAvailability.latest ? Boolean(expiredAvailability.latest.ok) : null,
    availabilityDueSample: expiredAvailability.dueSample?.count ?? null,
    availabilityDueSaturated: Boolean(expiredAvailability.dueSample?.saturated),
    availabilityBacklogTotal: dueEstimate.total ?? null,
    availabilityBacklogByTld: dueEstimate.byTld || {},
    availabilityPausedBacklogTotal: dueEstimate.pausedTotal ?? null,
    availabilityPausedBacklogByTld: dueEstimate.pausedByTld || {},
    availabilityBlockedBacklogTotal: dueEstimate.blockedTotal ?? null,
    availabilityBlockedBacklogByTld: dueEstimate.blockedByTld || {},
    registrarBlockedBacklogTotal: registrar.registrarBlockedBacklogTotal ?? null,
    registrarBlockedBacklogByTld: registrar.registrarBlockedBacklogByTld || {},
    availabilityCooldowns: expiredAvailability.cooldowns || dueEstimate.cooldowns || {},
    dogfoodLatestOk: expiredDogfood.latest ? Boolean(expiredDogfood.latest.ok) : null,
    dogfoodLatestAgeHours: ageHoursFromMs(expiredDogfood.latest?.ageMs),
    dogfoodMaxAgeHours: maxDogfoodAgeHours,
    dogfoodStale: Boolean(expiredDogfood.latest?.stale),
    visibilityTotal: expiredVisibility.total ?? null,
    visibilityByTld: expiredVisibility.byTld || {},
    visibilityStale: Boolean(expiredVisibility.stale),
    visibilityOldestAgeHours: ageHoursFromMs(expiredVisibility.oldestAgeMs),
    visibilityNewestAgeHours: ageHoursFromMs(expiredVisibility.newestAgeMs),
    visibilityMaxAgeHours: Number(expiredVisibility.maxAgeHours || maxAvailabilityAgeHours),
  });
  results.push({
    label: 'expired candidate supply',
    targetTlds: expiredCandidateSupply.targetTlds || [],
    totals: expiredCandidateSupply.totals || {},
    byTld: expiredCandidateSupply.byTld || {},
  });
  if (Number(expiredCandidateSupply.totals?.malformed || 0) > 0) {
    fail('expired candidate supply contains malformed ccTLD discovery rows', {
      totals: expiredCandidateSupply.totals || {},
      byTld: expiredCandidateSupply.byTld || {},
    });
  }
  const registrarRequiredTlds = (registrar.registrarRequiredAvailableTlds || [])
    .map(tld => String(tld || '').toLowerCase())
    .filter(Boolean);
  if (!registrar.configured && registrarRequiredTlds.length) {
    warn('registrar availability provider is not configured; registrar-required TLDs are withheld from Expired', {
      registrarRequiredAvailableTlds: registrarRequiredTlds,
      missingOrBlankEnv: registrar.missingOrBlankEnv || [],
      blockedTotal: registrar.registrarBlockedBacklogTotal ?? dueEstimate.blockedTotal ?? 0,
      blockedByTld: registrar.registrarBlockedBacklogByTld || dueEstimate.blockedByTld || {},
    });
    if (
      Number.isFinite(Number(dueEstimate.blockedTotal)) &&
      (
        Number(registrar.registrarBlockedBacklogTotal || 0) !== Number(dueEstimate.blockedTotal) ||
        !countMapsEqual(registrar.registrarBlockedBacklogByTld, dueEstimate.blockedByTld)
      )
    ) {
      fail('registrar blocked backlog disagrees with expired backlog estimate', {
        registrarBlockedBacklogTotal: registrar.registrarBlockedBacklogTotal,
        estimateBlockedTotal: dueEstimate.blockedTotal,
        registrarBlockedBacklogByTld: registrar.registrarBlockedBacklogByTld || {},
        estimateBlockedByTld: dueEstimate.blockedByTld || {},
      });
    }
    const blockedDueTlds = Object.keys(expiredAvailability.dueSample?.byTld || {})
      .filter(tld => registrarRequiredTlds.includes(String(tld || '').toLowerCase()));
    if (blockedDueTlds.length) {
      fail('expired availability due sample includes registrar-required TLDs without registrar credentials', {
        blockedDueTlds,
        byTld: expiredAvailability.dueSample?.byTld || {},
      });
    }
    await checkRegistrarBlockedRefresh(registrar);
  } else {
    await checkRegistrarProviderProbe(registrar);
  }
  await checkNoopRefreshForUndueTld(registrar, expiredAvailability);
  dueEstimate = await checkExpiredBacklogEstimate(expiredAvailability) || dueEstimate;
  assertCandidateSupplyBacklog(expiredCandidateSupply, dueEstimate, expiredAvailability);
  expiredAvailabilityReadiness = {
    ...expiredAvailability,
    dueEstimate,
    cooldowns: expiredAvailability.cooldowns || dueEstimate.cooldowns || {},
  };
  assertDueSampleBalance(expiredAvailability, dueEstimate);
  if (!expiredAvailability.latest) {
    warn('expired availability verifier has no persisted run yet');
  } else if (!expiredAvailability.latest.ok) {
    fail('expired availability verifier latest run failed', { latest: expiredAvailability.latest });
  }
  if (expiredAvailability.dueSample && Number(expiredAvailability.dueSample.count || 0) <= 0) {
    if (Number(dueEstimate.pausedTotal || 0) > 0) {
      warn('expired availability verifier candidates are paused by registry cooldown', {
        pausedTotal: dueEstimate.pausedTotal,
        pausedByTld: dueEstimate.pausedByTld || {},
        cooldowns: expiredAvailability.cooldowns || dueEstimate.cooldowns || {},
      });
    } else {
      warn('expired availability verifier has no due candidate sample');
    }
  } else if (expiredAvailability.dueSample?.saturated) {
    warn('expired availability verifier due sample is saturated', {
      limit: expiredAvailability.dueSample.limit,
      count: expiredAvailability.dueSample.count,
      byTld: expiredAvailability.dueSample.byTld || {},
      backlogTotal: dueEstimate.total ?? null,
      backlogByTld: dueEstimate.byTld || {},
      pausedTotal: dueEstimate.pausedTotal ?? null,
      pausedByTld: dueEstimate.pausedByTld || {},
    });
  }
  if (expiredAvailability.dueSample?.saturated && !Number.isFinite(Number(dueEstimate.total))) {
    fail('expired availability due sample is saturated but exact backlog estimate is missing', {
      dueSample: expiredAvailability.dueSample,
      dueEstimate,
    });
  }
  if (
    Number.isFinite(Number(dueEstimate.total)) &&
    dueSampleCount(expiredAvailability) > Number(dueEstimate.total)
  ) {
    const context = {
      dueSample: expiredAvailability.dueSample,
      dueEstimate,
    };
    if (expiredAvailability.running || expiredAvailability.snapshotChangedDuringDogfood) {
      warn('expired availability due sample/backlog snapshot changed during dogfood', context);
    } else {
      fail('expired availability due sample exceeds exact backlog estimate', context);
    }
  }
  if (!expiredDogfood.latest) {
    warn('scheduled expired dogfood has no persisted run yet');
  } else if (!expiredDogfood.latest.ok) {
    warn('scheduled expired dogfood latest run failed', { latest: expiredDogfood.latest });
  } else if (expiredDogfood.latest.stale) {
    warn('scheduled expired dogfood latest run is stale', {
      ranAt: expiredDogfood.latest.ranAt,
      ageHours: ageHoursFromMs(expiredDogfood.latest.ageMs),
      maxAgeHours: maxDogfoodAgeHours,
    });
  }
}

async function checkNormalDroppedCom() {
  const label = 'normal dropped .com';
  const { elapsedMs, data } = await fetchJson(label, '/api/domains', {
    stream: 'just-dropped',
    tld: '.com',
    sortField: 'quality_score',
    sortDir: 'DESC',
    page: 1,
    limit: 100,
  });
  if (!data) return;
  const rows = Array.isArray(data.domains) ? data.domains : [];
  results.push({ label, elapsedMs, total: data.total, checkedRows: rows.length });
  if (elapsedMs > maxDroppedMs) fail(`${label} exceeded latency budget`, { elapsedMs, maxDroppedMs });
  assertNoDuplicateDomains(label, rows);

  const knownBadVisible = rows
    .map(row => String(row.domain || '').toLowerCase())
    .filter(domain => UNAVAILABLE_CANARIES.includes(domain));
  if (knownBadVisible.length) fail(`${label} shows known unavailable names`, { domains: knownBadVisible });

  for (const row of rows) {
    if (isAvailability(row.registration_available, 0)) {
      fail(`${label} shows confirmed unavailable row`, {
        domain: row.domain,
        availability_source: row.availability_source,
      });
    }
  }
}

async function checkExpiringWindow() {
  const label = 'expiring 90-day first page';
  const { elapsedMs, data } = await fetchJson(label, '/api/domains', {
    stream: '_expiring90',
    sortField: 'expiring_at',
    sortDir: 'ASC',
    page: 1,
    limit: 500,
  });
  if (!data) return;
  const rows = Array.isArray(data.domains) ? data.domains : [];
  results.push({ label, elapsedMs, total: data.total, checkedRows: rows.length });
  if (elapsedMs > maxExpiringMs) fail(`${label} exceeded latency budget`, { elapsedMs, maxExpiringMs });
  if (Number(data.total || 0) > 0 && rows.length === 0) fail(`${label} reported total rows but returned none`, { total: data.total });
  assertNoDuplicateDomains(label, rows);

  const knownBadVisible = rows
    .map(row => String(row.domain || '').toLowerCase())
    .filter(domain => UNAVAILABLE_CANARIES.includes(domain));
  if (knownBadVisible.length) fail(`${label} shows known unavailable names`, { domains: knownBadVisible });

  let previous = '';
  for (const row of rows) {
    const at = String(row.expiring_at || '');
    if (!at) fail(`${label} contains a row without expiring_at`, { domain: row.domain, stream: row.stream });
    if (previous && at < previous) {
      fail(`${label} is not sorted by soonest expiring`, { previous, current: at, domain: row.domain });
      break;
    }
    previous = at;
  }
}

async function liveAvailabilityWithRetry(domain) {
  let last = null;
  for (let attempt = 1; attempt <= liveCheckAttempts; attempt += 1) {
    last = await checkRegistrationAvailability(domain);
    if (isAvailability(last.registration_available, 1) || isAvailability(last.registration_available, 0)) {
      return { ...last, attempts: attempt };
    }
  }
  return { ...(last || {}), attempts: liveCheckAttempts };
}

async function checkLiveExpiredSamples() {
  if (liveSampleSize <= 0 || liveExpiredSamples.length === 0) return;

  const label = 'live expired availability samples';
  const started = Date.now();
  const seen = new Set();
  const samples = liveExpiredSamples.filter(sample => {
    const domain = String(sample.domain || '').toLowerCase();
    if (!domain || seen.has(domain)) return false;
    seen.add(domain);
    return true;
  });
  let available = 0;
  let unavailable = 0;
  let unknown = 0;
  const byTld = {};
  const byStoredSource = {};
  const byLiveSource = {};
  const unknownSamplesByTld = {};

  for (const sample of samples) {
    try {
      const result = await liveAvailabilityWithRetry(sample.domain);
      if (isAvailability(result.registration_available, 1)) {
        available += 1;
        countByKey(byTld, sample.tld, 'available');
        countByKey(byStoredSource, sample.storedSource, 'available');
        countByKey(byLiveSource, result.availability_source, 'available');
      } else if (isAvailability(result.registration_available, 0)) {
        unavailable += 1;
        countByKey(byTld, sample.tld, 'unavailable');
        countByKey(byStoredSource, sample.storedSource, 'unavailable');
        countByKey(byLiveSource, result.availability_source, 'unavailable');
        fail(`${label} contradicted stored availability`, {
          domain: sample.domain,
          tld: sample.tld,
          storedSource: sample.storedSource,
          liveRegistrationAvailable: result.registration_available,
          liveSource: result.availability_source,
          liveError: result.availability_error,
        });
      } else {
        unknown += 1;
        countByKey(byTld, sample.tld, 'unknown');
        countByKey(byStoredSource, sample.storedSource, 'unknown');
        countByKey(byLiveSource, result.availability_source, 'unknown');
        unknownSamplesByTld[sample.tld] ||= [];
        unknownSamplesByTld[sample.tld].push({
          domain: sample.domain,
          tld: sample.tld,
          storedSource: sample.storedSource,
          liveSource: result.availability_source,
          liveError: result.availability_error,
          attempts: result.attempts,
        });
      }
    } catch (err) {
      unknown += 1;
      countByKey(byTld, sample.tld, 'unknown');
      countByKey(byStoredSource, sample.storedSource, 'unknown');
      countByKey(byLiveSource, 'exception', 'unknown');
      unknownSamplesByTld[sample.tld] ||= [];
      unknownSamplesByTld[sample.tld].push({
        domain: sample.domain,
        tld: sample.tld,
        storedSource: sample.storedSource,
        error: err.message || String(err),
      });
    }
  }

  for (const [tld, counts] of Object.entries(byTld)) {
    if (counts.unknown > 0 && counts.available === 0 && counts.unavailable === 0) {
      warn(`${label} was inconclusive`, {
        tld,
        unknown: counts.unknown,
        checked: counts.checked,
        samples: (unknownSamplesByTld[tld] || []).slice(0, 5),
      });
    }
  }

  results.push({
    label,
    elapsedMs: Date.now() - started,
    checkedRows: samples.length,
    available,
    unavailable,
    unknown,
    byTld,
    byStoredSource,
    byLiveSource,
  });
}

async function main() {
  let configStatus = null;
  await fetchJson('health', '/api/stats').then(({ elapsedMs, data }) => {
    if (!data) return;
    results.push({
      label: 'stats',
      elapsedMs,
      expired90: data.expired90,
      expiring90: data.expiring90,
      cached: data.cached,
      stale: data.stale,
    });
    if (data.stale === true) warn('stats endpoint is reporting stale data');
  });

  const configResult = await checkRegistrarReadiness();
  await checkExpiringWindow();
  for (const tld of priorityTlds) await checkExpiredTld(tld);
  await checkExpiredEndpoint();
  await checkExpiredDateFiltersIgnored();
  await fetchJson('visibility', '/api/config-status').then(({ data }) => {
    configStatus = data;
    if (data) assertExpiredVisibility(data.expiredVisibility, expiredEndpointSummary);
    else if (expiredVisibilityReadiness) assertExpiredVisibility(expiredVisibilityReadiness, expiredEndpointSummary);
  });
  await checkLiveExpiredSamples();
  for (const domain of UNAVAILABLE_CANARIES) await checkUnavailableCanary(domain);
  await checkNormalDroppedCom();

  const report = {
    ok: failures.length === 0,
    baseUrl,
    checkedAt: new Date().toISOString(),
    priorityTlds,
    results,
    warnings,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err.message || String(err),
    stack: err.stack,
  }, null, 2));
  process.exit(1);
});
