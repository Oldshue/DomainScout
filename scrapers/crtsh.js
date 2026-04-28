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

function parseDomain(domain) {
  const lower = domain.toLowerCase().trim().replace(/^\*\./, ''); // strip wildcards
  const dotIdx = lower.lastIndexOf('.');
  const tld = dotIdx >= 0 ? lower.slice(dotIdx) : '';
  const name = dotIdx >= 0 ? lower.slice(0, dotIdx) : lower;
  if (name.includes('.')) return null; // skip subdomains
  if (!tld || !CT_TLDS.includes(tld)) return null;
  if (!name || name.length < 2) return null;
  return {
    domain: lower,
    tld,
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
  };
}

/**
 * Fetch all unique domains for a TLD from crt.sh.
 * Queries without a time filter to build a broad discovery set.
 * Returns domains as "discovered" stream — they'll be queued for RDAP expiry polling.
 */
async function fetchDiscoveryForTLD(tld) {
  const cleanTld = tld.replace('.', '');
  // Query for all certs ever issued under this TLD — deduplicated at the DB level
  const url = `https://crt.sh/?q=%25.${cleanTld}&output=json`;

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
          stream: 'discovered',  // NOT "just-dropped" — these get RDAP-polled for expiry
          source: 'crt.sh discovery',
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

  for (const tld of CT_TLDS) {
    const r = await fetchDiscoveryForTLD(tld);
    console.log(`[crt.sh] ${tld}: ${r.length} domains discovered`);
    results.push(...r);
    await sleep(3000); // polite delay between TLD queries
  }

  console.log(`[crt.sh] Total discovered: ${results.length} domains`);
  return results;
}

module.exports = { runCRTSH };
