/**
 * Certificate Transparency discovery via crt.sh
 *
 * PURPOSE: Seed our RDAP poll queue with .ai/.io/.sh/.bot domains.
 *
 * Why crt.sh for this?
 *   - .ai/.io/.sh/.bot have NO public zone files (ccTLDs)
 *   - Every real domain eventually gets an SSL cert
 *   - crt.sh logs ~all SSL certs ever issued → great domain discovery corpus
 *   - We return domains as "discovered" stream so WHOIS/RDAP polling picks them up
 *
 * What crt.sh is NOT:
 *   - It does NOT tell you a domain expired or dropped
 *   - A new cert = new registration OR renewal — the opposite of dropping
 *   - Do NOT classify crt.sh results as "just-dropped"
 *
 * No auth required. Free public API. https://crt.sh
 */
const axios = require('axios');

const CT_TLDS = ['.ai', '.io', '.sh', '.bot'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function validDomainLabel(label) {
  const value = String(label || '');
  if (value.length < 2 || value.length > 63) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function parseDomain(domain) {
  const lower = String(domain || '').toLowerCase().trim()
    .replace(/^\*\./, '') // strip wildcards
    .replace(/\.$/, '');
  if (!lower || lower.includes('@') || /\s/.test(lower)) return null;
  const dotIdx = lower.lastIndexOf('.');
  const tld = dotIdx >= 0 ? lower.slice(dotIdx) : '';
  const name = dotIdx >= 0 ? lower.slice(0, dotIdx) : lower;
  if (name.includes('.')) return null; // skip subdomains
  if (!tld || !CT_TLDS.includes(tld)) return null;
  if (!validDomainLabel(name)) return null;
  return {
    domain: lower,
    tld,
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
  };
}

/**
 * Fetch unique domains for a TLD from crt.sh.
 * Two passes:
 *   1. Full discovery (all certs ever) — broad corpus
 *   2. Renewal candidates (certs issued 10-14 months ago) — these domains are
 *      coming up for their 1-year renewal right now and are likely to expire
 */
async function fetchDiscoveryForTLD(tld, opts = {}) {
  const cleanTld = tld.replace('.', '');
  let url = `https://crt.sh/?q=%25.${cleanTld}&output=json`;

  if (opts.notBefore && opts.notAfter) {
    url += `&not_before=${opts.notBefore}&not_after=${opts.notAfter}`;
  }

  try {
    const resp = await axios.get(url, {
      timeout: 45000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DomainScout/1.0 (domain expiry tracker)',
      },
    });

    if (!Array.isArray(resp.data)) return [];

    const seen = new Set();
    const results = [];

    for (const cert of resp.data) {
      // cert.name_value may contain multiple domains separated by newlines
      const names = (cert.name_value || cert.common_name || '').split('\n');
      for (const name of names) {
        const parsed = parseDomain(name.trim());
        if (!parsed || seen.has(parsed.domain)) continue;
        seen.add(parsed.domain);
        results.push({
          ...parsed,
          stream: 'discovered',
          source: opts.notBefore ? 'crt.sh renewal-candidate' : 'crt.sh discovery',
          auction_url: null,
        });
      }
    }

    return results;
  } catch (err) {
    console.error(`[crt.sh/${tld}]:`, err.message);
    return [];
  }
}

async function runCRTSH() {
  console.log('[crt.sh] Discovering ccTLD domain corpus (.ai/.io/.sh/.bot)...');
  const results = [];

  // Pass 1: broad discovery — all certs ever issued for these TLDs
  for (const tld of CT_TLDS) {
    const r = await fetchDiscoveryForTLD(tld);
    console.log(`[crt.sh] ${tld}: ${r.length} domains discovered`);
    results.push(...r);
    await sleep(2000);
  }

  // Pass 2: renewal candidates — certs issued 10-14 months ago
  // Domains that got certs ~1 year ago are coming up for their annual renewal right now
  const now = new Date();
  const notBefore = new Date(now - 14 * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 14 months ago
  const notAfter  = new Date(now - 10 * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 10 months ago

  console.log(`[crt.sh] Renewal candidates: certs from ${notBefore} to ${notAfter}...`);
  for (const tld of CT_TLDS) {
    const r = await fetchDiscoveryForTLD(tld, { notBefore, notAfter });
    console.log(`[crt.sh] ${tld} renewal candidates: ${r.length}`);
    results.push(...r);
    await sleep(2000);
  }

  // Deduplicate
  const seen = new Set();
  const unique = results.filter(d => {
    if (seen.has(d.domain)) return false;
    seen.add(d.domain);
    return true;
  });

  console.log(`[crt.sh] Total: ${unique.length} unique domains (${results.length - unique.length} dupes removed)`);
  return unique;
}

module.exports = { runCRTSH, parseDomain };
