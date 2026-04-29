/**
 * Domain enrichment — Wayback Machine, WHOIS age, DNS availability
 * All free/public APIs, no keys needed
 */
const axios = require('axios');
const dns = require('dns').promises;
const { CHECK_TLDS } = require('../server/tlds-list');

/**
 * Count how many TLDs a base name is registered in across the internet.
 * Uses parallel DNS NS lookups — fast, no API key needed.
 */
async function checkTldsTaken(baseName) {
  const results = await Promise.all(
    CHECK_TLDS.map(async (tld) => {
      try {
        await dns.resolveNs(baseName + tld);
        return true;
      } catch (_) {
        return false;
      }
    })
  );
  return results.filter(Boolean).length;
}

/**
 * Same as checkTldsTaken but returns the full list of taken TLDs, not just the count.
 */
async function checkTldsTakenFull(baseName) {
  const results = await Promise.all(
    CHECK_TLDS.map(async (tld) => {
      try {
        await dns.resolveNs(baseName + tld);
        return tld;
      } catch (_) {
        return null;
      }
    })
  );
  const taken = results.filter(Boolean);
  return { count: taken.length, taken, all: CHECK_TLDS };
}

// Check if domain resolves (i.e., NOT available if it resolves)
async function checkDNS(domain) {
  try {
    await dns.resolve(domain);
    return 0; // resolves = taken
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      return 1; // not found = available
    }
    return null; // unknown
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

// RDAP (modern WHOIS replacement) — ICANN-standardized, free
async function checkRDAP(domain) {
  try {
    const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
    const resp = await axios.get(url, { timeout: 10000 });
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

    return { age_years: ageYears, expiry_date: expiryDate };
  } catch (err) {
    return { age_years: null, expiry_date: null };
  }
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
      return {
        domain,
        dns_available: dnsResult,
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

module.exports = { enrichDomains, checkDNS, checkWayback, checkRDAP, checkTldsTaken, checkTldsTakenFull };
