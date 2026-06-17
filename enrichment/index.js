/**
 * Domain enrichment — Wayback Machine, WHOIS age, DNS availability
 * All free/public APIs, no keys needed
 */
const axios = require('axios');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const dotenv = require('dotenv');
const { getCheckTlds } = require('../server/tlds-list');

const NO_REGISTRY_RDAP_TLDS = new Set(['.io', '.sh']);
const REGISTRY_RDAP_BASES = {
  '.com': 'https://rdap.verisign.com/com/v1/domain/',
  '.net': 'https://rdap.verisign.com/net/v1/domain/',
  '.org': 'https://rdap.publicinterestregistry.org/rdap/domain/',
  '.ai': 'https://rdap.identitydigital.services/rdap/domain/',
  '.dev': 'https://pubapi.registry.google/rdap/domain/',
  '.app': 'https://pubapi.registry.google/rdap/domain/',
};
const WHOIS_AVAILABILITY_SERVERS = {
  '.com': 'whois.verisign-grs.com',
  '.net': 'whois.verisign-grs.com',
  '.ai': 'whois.nic.ai',
  '.io': 'whois.nic.io',
  '.sh': 'whois.identitydigital.services',
};
const RDAP_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
const rdapCooldownUntil = new Map();
// Public DNS/RDAP/WHOIS is the default expired-pool verifier path. Registrar
// confirmation remains opt-in via DOMAINSCOUT_REQUIRE_REGISTRAR_TLDS.
const DEFAULT_REGISTRAR_REQUIRED_AVAILABLE_TLDS = [];
const ENV_FILE_PATH = path.join(__dirname, '../.env');
let runtimeEnvFileMtimeMs = null;

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

function parseRetryAfterMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function refreshRuntimeEnvFile() {
  if (process.env.DOMAINSCOUT_DISABLE_RUNTIME_ENV_RELOAD === '1') return;
  let stat;
  try {
    stat = fs.statSync(ENV_FILE_PATH);
  } catch (_) {
    runtimeEnvFileMtimeMs = null;
    return;
  }
  if (runtimeEnvFileMtimeMs === stat.mtimeMs) return;
  runtimeEnvFileMtimeMs = stat.mtimeMs;
  let parsed = {};
  try {
    parsed = dotenv.parse(fs.readFileSync(ENV_FILE_PATH));
  } catch (_) {
    return;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (String(process.env[key] || '').trim()) continue;
    if (!String(value || '').trim()) continue;
    process.env[key] = value;
  }
}

/**
 * Check if a domain is registered using Cloudflare DNS-over-HTTPS.
 * More reliable than Node's built-in DNS resolver in hosted environments.
 * Returns the TLD string if taken, null if not.
 */
async function checkOneTld(domain, tld, timeoutMs = 5000) {
  const DOH = 'https://cloudflare-dns.com/dns-query';
  try {
    // Query A records first
    const resp = await axios.get(DOH, {
      params: { name: domain, type: 'A' },
      headers: { Accept: 'application/dns-json' },
      timeout: timeoutMs,
    });
    const d = resp.data;
    if (d.Status === 3) return null;            // NXDOMAIN = not registered
    if (d.Answer && d.Answer.length > 0) return tld; // Has A records = taken
    // NOERROR but no A records — could be email-only or NS-only domain, check NS
    const nsResp = await axios.get(DOH, {
      params: { name: domain, type: 'NS' },
      headers: { Accept: 'application/dns-json' },
      timeout: timeoutMs,
    });
    const nd = nsResp.data;
    if (nd.Status === 3) return null;
    if (nd.Answer && nd.Answer.length > 0) return tld;
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Count how many TLDs a base name is registered in across the internet.
 */
async function checkTldsTaken(baseName) {
  const results = await checkTldList(baseName, getCheckTlds());
  return results.filter(Boolean).length;
}

/**
 * Same as checkTldsTaken but returns the full list of taken TLDs, not just the count.
 */
async function checkTldsTakenFull(baseName, options = {}) {
  const all = getCheckTlds();
  const results = await checkTldList(baseName, all, options.concurrency || 100, options.timeoutMs || 4000);
  const taken = results.filter(Boolean);
  return { count: taken.length, taken, all };
}

async function checkTldList(baseName, tlds, concurrency = 50, timeoutMs = 5000) {
  const results = [];
  for (let i = 0; i < tlds.length; i += concurrency) {
    const batch = tlds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(tld => checkOneTld(baseName + tld, tld, timeoutMs))
    );
    results.push(...batchResults);
  }
  return results;
}

// Check if domain has registration-style DNS. A domain with no A record can
// still be registered, so require NS/A/SOA to all be absent before saying
// "available by DNS".
async function checkDNS(domain) {
  const timeoutMs = positiveInt(process.env.DOMAINSCOUT_DNS_AVAILABILITY_TIMEOUT_MS, 2500, 250, 10000);
  const checks = [
    () => dns.resolveNs(domain),
    () => dns.resolve(domain),
    () => dns.resolveSoa(domain),
  ];
  let sawOnlyNegative = true;
  for (const check of checks) {
    try {
      const result = await withTimeout(check(), timeoutMs, 'DNS timeout');
      if (Array.isArray(result) ? result.length > 0 : result) return 0;
    } catch (err) {
      if (err.code !== 'ENOTFOUND' && err.code !== 'ENODATA') sawOnlyNegative = false;
    }
  }
  return sawOnlyNegative ? 1 : null;
}

function tldFromDomain(domain) {
  const d = String(domain || '').toLowerCase();
  const dot = d.lastIndexOf('.');
  return dot >= 0 ? d.slice(dot) : '';
}

function baseNameFromDomain(domain) {
  const d = String(domain || '').toLowerCase();
  const dot = d.lastIndexOf('.');
  return dot > 0 ? d.slice(0, dot) : d;
}

function shouldRegistrarCrossCheck(domain) {
  return getRegistrarRequiredAvailableTlds().includes(tldFromDomain(domain));
}

function envValue(name) {
  refreshRuntimeEnvFile();
  return String(process.env[name] || '').trim();
}

function parseTldList(value) {
  return [...new Set(
    String(value || '')
      .split(',')
      .map(tld => String(tld || '').trim().toLowerCase())
      .filter(Boolean)
      .map(tld => tld.startsWith('.') ? tld : `.${tld}`)
  )];
}

function getRegistrarRequiredAvailableTlds() {
  refreshRuntimeEnvFile();
  if (Object.prototype.hasOwnProperty.call(process.env, 'DOMAINSCOUT_REQUIRE_REGISTRAR_TLDS')) {
    return parseTldList(process.env.DOMAINSCOUT_REQUIRE_REGISTRAR_TLDS);
  }
  return DEFAULT_REGISTRAR_REQUIRED_AVAILABLE_TLDS.slice();
}

function getGoDaddyCredentials() {
  return {
    apiKey: envValue('GODADDY_API_KEY'),
    apiSecret: envValue('GODADDY_API_SECRET'),
  };
}

function normalizeGoDaddyCheckType(value, fallback = 'FULL') {
  const normalized = String(value || fallback || 'FULL').trim().toUpperCase();
  return normalized === 'FAST' ? 'FAST' : 'FULL';
}

function getRegistrarAvailabilityCheckType() {
  refreshRuntimeEnvFile();
  return normalizeGoDaddyCheckType(
    process.env.DOMAINSCOUT_REGISTRAR_AVAILABILITY_CHECK_TYPE ||
    process.env.DOMAINSCOUT_GODADDY_AVAILABILITY_CHECK_TYPE,
    'FULL'
  );
}

function getRegistrarAvailabilityConfig() {
  const { apiKey, apiSecret } = getGoDaddyCredentials();
  const missingOrBlankEnv = [];
  if (!apiKey) missingOrBlankEnv.push('GODADDY_API_KEY');
  if (!apiSecret) missingOrBlankEnv.push('GODADDY_API_SECRET');
  const registrarRequiredAvailableTlds = getRegistrarRequiredAvailableTlds();
  const availabilityCheckType = getRegistrarAvailabilityCheckType();
  const configured = missingOrBlankEnv.length === 0;
  const requiredForExpiredAvailability = registrarRequiredAvailableTlds.length > 0;
  return {
    configured,
    providers: configured ? ['godaddy'] : [],
    crossChecksAvailableCom: configured && registrarRequiredAvailableTlds.includes('.com'),
    availabilityCheckType,
    registrarRequiredAvailableTlds,
    requiredForExpiredAvailability,
    unavailableRowsHiddenByVerificationState: requiredForExpiredAvailability && !configured,
    missingOrBlankEnv,
  };
}

function parseGoDaddyAvailabilityRow(data, domain) {
  const wanted = String(domain || '').toLowerCase();
  const candidates = [];
  if (Array.isArray(data)) {
    candidates.push(...data);
  } else if (data && Array.isArray(data.domains)) {
    candidates.push(...data.domains);
  } else if (data && typeof data === 'object') {
    candidates.push(data);
    for (const value of Object.values(data)) {
      if (value && typeof value === 'object') candidates.push(value);
    }
  }
  return candidates.find(row => String(row?.domain || '').toLowerCase() === wanted) || candidates[0] || null;
}

async function checkGoDaddyRegistrationAvailability(domain, options = {}) {
  const { apiKey, apiSecret } = getGoDaddyCredentials();
  if (!apiKey || !apiSecret) return { status: 'unsupported', error: 'registrar API not configured' };
  const checkType = normalizeGoDaddyCheckType(options.checkType, getRegistrarAvailabilityCheckType());
  try {
    const resp = await axios.post(
      `https://api.godaddy.com/v1/domains/available?checkType=${encodeURIComponent(checkType)}`,
      [domain],
      {
        headers: {
          Authorization: `sso-key ${apiKey}:${apiSecret}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    const row = parseGoDaddyAvailabilityRow(resp.data, domain);
    if (row && row.available === true) return { status: 'available', checkType };
    if (row && row.available === false) return { status: 'registered', checkType };
    return { status: 'unknown', checkType, error: 'registrar response inconclusive' };
  } catch (err) {
    return { status: 'unknown', checkType, error: err.response?.data?.message || err.message || 'registrar check failed' };
  }
}

async function confirmAvailableRegistration(domain, result) {
  if (!result || result.registration_available !== 1) return result;
  if (!shouldRegistrarCrossCheck(domain)) return result;

  const registrar = await checkGoDaddyRegistrationAvailability(domain);
  if (registrar.status === 'available') {
    return {
      ...result,
      availability_source: `registrar+${result.availability_source || 'dns'}`,
      availability_error: null,
    };
  }
  if (registrar.status === 'registered') {
    return {
      ...result,
      registration_available: 0,
      availability_source: 'registrar',
      availability_error: null,
    };
  }
  return {
    ...result,
    registration_available: null,
    availability_error: registrar.error
      ? `registrar required: ${registrar.error}`
      : 'registrar required',
  };
}

function whoisQuery(domain, server, timeoutMs = positiveInt(process.env.DOMAINSCOUT_WHOIS_AVAILABILITY_TIMEOUT_MS, 6000, 500, 20000)) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let data = '';
    client.setTimeout(timeoutMs);
    client.connect(43, server, () => { client.write(`${domain}\r\n`); });
    client.on('data', chunk => { data += chunk.toString(); });
    client.on('end', () => resolve(data));
    client.on('timeout', () => { client.destroy(); reject(new Error('WHOIS timeout')); });
    client.on('error', err => reject(err));
  });
}

function parseWhoisRegistrationStatus(text) {
  const raw = String(text || '');
  if (!raw.trim()) return 'unknown';
  if (/domain not found|no match for|not found|no data found|no entries found|no objects found|not currently registered|object does not exist|status:\s*free/i.test(raw)) {
    return 'not_found';
  }
  if (/reserved by the registry|domain name:|registry domain id:|registrar:|creation date:|registry expiry date:/i.test(raw)) {
    return 'registered';
  }
  return 'unknown';
}

async function checkWHOISRegistration(domain) {
  const tld = tldFromDomain(domain);
  const server = WHOIS_AVAILABILITY_SERVERS[tld];
  if (!server) return { whois_status: 'unsupported' };
  try {
    const text = await whoisQuery(domain, server);
    return { whois_status: parseWhoisRegistrationStatus(text) };
  } catch (err) {
    return { whois_status: 'unknown', error: err?.message || 'WHOIS failed' };
  }
}

async function checkRegistrationAvailability(domain) {
  try {
    const tld = tldFromDomain(domain);
    const [dnsResult, rdap] = await Promise.all([checkDNS(domain), checkRDAP(domain)]);
    if (dnsResult === 0 || rdap.rdap_status === 'registered') {
      return {
        dns_available: dnsResult,
        registration_available: 0,
        availability_source: dnsResult === 0 ? 'dns' : 'rdap',
        availability_error: null,
        // Registry expiry from RDAP (already parsed). Lets the Expired view tell a
        // dropping name (past expiry: redemption/pending-delete — shown) from one a
        // new owner re-registered after expiry (future expiry — hidden).
        registry_expiry_date: rdap.expiry_date || null,
      };
    }

    if (WHOIS_AVAILABILITY_SERVERS[tld]) {
      const whois = await checkWHOISRegistration(domain);
      if (whois.whois_status === 'registered') {
        return {
          dns_available: dnsResult,
          registration_available: 0,
          availability_source: 'whois',
          availability_error: null,
        };
      }
      if (dnsResult === 1 && whois.whois_status === 'not_found') {
        return confirmAvailableRegistration(domain, {
          dns_available: dnsResult,
          registration_available: 1,
          availability_source: 'whois+dns',
          availability_error: null,
        });
      }
      return {
        dns_available: dnsResult,
        registration_available: null,
        availability_source: 'whois+dns',
        availability_error: whois.error || 'WHOIS inconclusive',
      };
    }

    if (dnsResult === 1 && rdap.rdap_status === 'not_found') {
      return confirmAvailableRegistration(domain, {
        dns_available: dnsResult,
        registration_available: 1,
        availability_source: 'rdap+dns',
        availability_error: null,
      });
    }
    return {
      dns_available: dnsResult,
      registration_available: null,
      availability_source: 'rdap+dns',
      availability_error: rdap.rdap_error || 'inconclusive',
      availability_retry_after_ms: rdap.rdap_retry_after_ms || null,
    };
  } catch (err) {
    return {
      dns_available: null,
      registration_available: null,
      availability_source: 'rdap+dns',
      availability_error: err?.message || 'availability check failed',
    };
  }
}

// Wayback Machine CDX API — fast, free, no auth
async function checkWayback(domain) {
  try {
    const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=2&fl=timestamp,statuscode&filter=statuscode:200&fastLatest=true`;
    const resp = await axios.get(url, { timeout: 10000 });
    const rows = resp.data;
    if (!Array.isArray(rows) || rows.length < 2) {
      return { snapshots: 0, first: null, last: null };
    }
    // rows[0] = header, rows[1..] = data
    const data = rows.slice(1);
    const timestamps = data.map(r => r[0]).sort();

    // Get total count
    const countUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp&matchType=domain&showNumPages=true`;
    let snapshots = data.length;
    try {
      const countResp = await axios.get(countUrl, { timeout: 8000 });
      if (countResp.data) {
        const n = parseInt(countResp.data, 10);
        if (!isNaN(n)) snapshots = n;
      }
    } catch (_) {}

    const fmt = (ts) => ts ? `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}` : null;

    return {
      snapshots,
      first: fmt(timestamps[0]),
      last: fmt(timestamps[timestamps.length - 1]),
    };
  } catch (err) {
    return { snapshots: 0, first: null, last: null };
  }
}

function emptyRDAP(status = 'unknown', error = null, retryAfterMs = null) {
  return {
    age_years: null,
    expiry_date: null,
    rdap_status: status,
    rdap_error: error,
    rdap_retry_after_ms: retryAfterMs,
  };
}

function parseRDAPResponse(resp, tld) {
  if (resp.status === 404 || resp.data?.errorCode === 404) {
    if (NO_REGISTRY_RDAP_TLDS.has(tld)) {
      return emptyRDAP('unknown');
    }
    return emptyRDAP('not_found');
  }
  if (resp.status === 429 || resp.data?.error_code === 1015) {
    return emptyRDAP(
      'unknown',
      'RDAP rate limited',
      parseRetryAfterMs(resp.headers?.['retry-after'])
    );
  }
  if (resp.status < 200 || resp.status >= 300) {
    return emptyRDAP('unknown', `RDAP status ${resp.status}`);
  }
  const data = resp.data;

  let createdDate = null;
  let expiryDate = null;

  if (data.events) {
    const reg = data.events.find(e => e.eventAction === 'registration');
    if (reg) createdDate = reg.eventDate;

    const exp = data.events.find(e =>
      e.eventAction === 'expiration' || e.eventAction === 'expiry'
    );
    if (exp) expiryDate = exp.eventDate ? new Date(exp.eventDate).toISOString() : null;
  }

  let ageYears = null;
  if (createdDate) {
    const created = new Date(createdDate);
    const now = new Date();
    ageYears = Math.floor((now - created) / (365.25 * 24 * 60 * 60 * 1000));
  }

  return { age_years: ageYears, expiry_date: expiryDate, rdap_status: 'registered', rdap_error: null };
}

async function fetchRDAP(domain, url, tld) {
  let cooldownKey = null;
  try {
    cooldownKey = new URL(url).origin;
    const until = rdapCooldownUntil.get(cooldownKey) || 0;
    if (until > Date.now()) return emptyRDAP('unknown', 'RDAP rate limited', until - Date.now());

    const resp = await axios.get(url, { timeout: 10000, validateStatus: () => true });
    const result = parseRDAPResponse(resp, tld);
    if (result.rdap_error === 'RDAP rate limited') {
      rdapCooldownUntil.set(
        cooldownKey,
        Date.now() + (result.rdap_retry_after_ms || RDAP_RATE_LIMIT_COOLDOWN_MS)
      );
    }
    return result;
  } catch (err) {
    return emptyRDAP('unknown', err?.message || 'RDAP failed');
  }
}

// RDAP (modern WHOIS replacement) — ICANN-standardized, free
async function checkRDAP(domain) {
  const tld = tldFromDomain(domain);
  const encoded = encodeURIComponent(domain);
  const urls = [];
  if (REGISTRY_RDAP_BASES[tld]) urls.push(`${REGISTRY_RDAP_BASES[tld]}${encoded}`);
  urls.push(`https://rdap.org/domain/${encoded}`);

  for (const url of urls) {
    const result = await fetchRDAP(domain, url, tld);
    if (result.rdap_status !== 'unknown') return result;
    if (result.rdap_error === 'RDAP rate limited') return result;
  }
  return emptyRDAP('unknown');
}

// Enrich a batch of domains with rate limiting
async function enrichDomains(domains, opts = {}) {
  const { concurrency = 5, delayMs = 300 } = opts;
  const results = [];

  for (let i = 0; i < domains.length; i += concurrency) {
    const batch = domains.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async (domain) => {
      const [dnsResult, wayback, rdap] = await Promise.all([
        checkDNS(domain),
        checkWayback(domain),
        checkRDAP(domain),
      ]);
      let registrationAvailable = null;
      let availabilitySource = 'rdap+dns';
      let availabilityError = null;
      if (dnsResult === 0 || rdap.rdap_status === 'registered') {
        registrationAvailable = 0;
        availabilitySource = dnsResult === 0 ? 'dns' : 'rdap';
      } else if (WHOIS_AVAILABILITY_SERVERS[tldFromDomain(domain)]) {
        const whois = await checkWHOISRegistration(domain);
        availabilitySource = 'whois+dns';
        availabilityError = whois.error || null;
        if (whois.whois_status === 'registered') {
          registrationAvailable = 0;
          availabilitySource = 'whois';
        } else if (dnsResult === 1 && whois.whois_status === 'not_found') {
          registrationAvailable = 1;
        } else {
          availabilityError = availabilityError || 'WHOIS inconclusive';
        }
      } else if (dnsResult === 1 && rdap.rdap_status === 'not_found') {
        registrationAvailable = 1;
      } else if (rdap.rdap_error) {
        availabilityError = rdap.rdap_error;
      }
      const availability = await confirmAvailableRegistration(domain, {
        dns_available: dnsResult,
        registration_available: registrationAvailable,
        availability_source: availabilitySource,
        availability_error: availabilityError,
      });
      return {
        domain,
        dns_available: availability.dns_available,
        registration_available: availability.registration_available,
        availability_source: availability.availability_source,
        availability_error: availability.availability_error,
        availability_checked_at: new Date().toISOString(),
        wayback_snapshots: wayback.snapshots,
        wayback_first: wayback.first,
        wayback_last: wayback.last,
        age_years: rdap.age_years,
        expiry_date: rdap.expiry_date || null,
      };
    }));
    results.push(...batchResults);
    if (i + concurrency < domains.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}

module.exports = {
  enrichDomains,
  checkDNS,
  checkWHOISRegistration,
  checkRegistrationAvailability,
  checkGoDaddyRegistrationAvailability,
  getRegistrarAvailabilityCheckType,
  getRegistrarRequiredAvailableTlds,
  getRegistrarAvailabilityConfig,
  parseGoDaddyAvailabilityRow,
  checkWayback,
  checkRDAP,
  checkTldsTaken,
  checkTldsTakenFull,
};
