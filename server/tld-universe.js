const crypto = require('crypto');
const { getIndexedTldSet } = require('./zone-indexer');
const { getCheckTlds } = require('./tlds-list');

// Zone files are the fast authoritative source. These TLDs are the DNS-only
// safety net for commercially important namespaces that may not be indexed yet
// or are not available through ICANN CZDS, especially ccTLDs.
const CORE_DNS_TLDS = [
  '.com', '.net', '.org', '.io', '.ai', '.co', '.sh', '.bot',
  '.app', '.dev', '.xyz', '.online', '.site', '.shop', '.store', '.tech',
  '.info', '.biz', '.club', '.top', '.vip', '.live', '.click', '.website',
  '.cloud', '.digital', '.software', '.systems', '.network', '.solutions',
  '.services', '.agency', '.group', '.company', '.business', '.world',
  '.global', '.pro', '.one', '.space', '.life', '.today', '.news', '.media',
  '.blog', '.social', '.design', '.studio', '.art', '.finance', '.capital',
  '.fund', '.ventures', '.partners', '.exchange', '.team', '.tools', '.works',
  '.run', '.codes', '.build', '.domains', '.email', '.marketing', '.center',
  '.academy', '.school', '.education', '.games', '.fun', '.love', '.law',
  '.legal', '.llc', '.inc', '.name', '.mobi', '.asia', '.tel',
  '.me', '.tv', '.cc', '.vc', '.gg', '.ly', '.so', '.to', '.fm', '.am',
  '.us', '.ca', '.uk', '.de', '.fr', '.it', '.es', '.nl', '.se', '.no',
  '.dk', '.fi', '.ch', '.at', '.be', '.ie', '.pl', '.cz', '.pt', '.gr',
  '.ro', '.hu', '.jp', '.kr', '.cn', '.hk', '.tw', '.sg', '.in', '.my',
  '.id', '.ph', '.vn', '.th', '.au', '.nz', '.ae', '.sa', '.il', '.tr',
  '.br', '.mx', '.ar', '.cl', '.za', '.ng', '.ke', '.pk', '.eg', '.ma',
  '.is', '.ee', '.lv', '.lt',
];

function normalizeTlds(tlds) {
  return [...new Set((tlds || [])
    .map(tld => String(tld || '').trim().toLowerCase())
    .filter(Boolean)
    .map(tld => tld.startsWith('.') ? tld : `.${tld}`)
    .filter(tld => /^\.[a-z0-9-]+$/.test(tld) && !tld.startsWith('.xn--'))
  )].sort();
}

function hashTlds(tlds) {
  return crypto.createHash('sha1').update(tlds.join('\n')).digest('hex').slice(0, 12);
}

function getSupportedTldUniverse() {
  // DNS-only mode: skip the zone-index read. Opening zone_index.db while the build
  // holds a multi-GB WAL blocks the caller in uninterruptible I/O — that deadlock is
  // why the worker sat at 0/hr. With no indexed set, the full universe is DNS-checked.
  const dnsOnly = process.env.DOMAINSCOUT_DNS_ONLY_UNIVERSE === '1';
  const indexed = dnsOnly ? [] : normalizeTlds([...getIndexedTldSet()]);
  const indexedSet = new Set(indexed);
  // The DNS safety net is the FULL commercially-relevant TLD universe (~1285), not a
  // 143-entry core. A name like "bracelet" is registered across ~107 extensions
  // (.com/.net/.org/.de/.fr/.ru/.nl/.cn/...) — counting it against only 143 TLDs (and
  // missing .ru/.co.uk/etc.) is what produced the wrong "13". Everything not covered by
  // the zone index is DNS-checked, so the count reflects the same breadth dotDB reports.
  let full = [];
  try { full = normalizeTlds(getCheckTlds()); } catch { /* fall back below */ }
  if (full.length < CORE_DNS_TLDS.length) full = normalizeTlds(CORE_DNS_TLDS);
  const dns = normalizeTlds([...full, ...CORE_DNS_TLDS]).filter(tld => !indexedSet.has(tld));
  const tlds = normalizeTlds([...indexed, ...dns]);
  const hash = hashTlds(tlds);
  return {
    source: `supported-zone+full-dns:${hash}`,
    loadedAt: new Date().toISOString(),
    count: tlds.length,
    hash,
    tlds,
    indexedTlds: indexed,
    dnsTlds: dns,
    coreTlds: normalizeTlds(CORE_DNS_TLDS),
  };
}

module.exports = {
  CORE_DNS_TLDS,
  getSupportedTldUniverse,
};
