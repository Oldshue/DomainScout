const crypto = require('crypto');
const { getZoneTruth } = require('./zone-truth');
const { getCheckTlds, getTldSource } = require('./tlds-list');

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
    .filter(tld => /^\.[a-z0-9-]+$/.test(tld))
  )].sort();
}

function hashTlds(tlds) {
  return crypto.createHash('sha1').update(tlds.join('\n')).digest('hex').slice(0, 12);
}

function getSupportedTldUniverse() {
  const tlds = normalizeTlds(getCheckTlds());
  const metadata = getTldSource();
  const indexed = process.env.DOMAINSCOUT_DNS_ONLY_UNIVERSE === '1'
    ? []
    : normalizeTlds([...getZoneTruth().completeTldSet()]).filter(tld => tlds.includes(tld));
  const indexedSet = new Set(indexed);
  const version = metadata.version || hashTlds(tlds);
  return {
    id: metadata.identity || 'iana-root-tlds',
    identity: metadata.identity || 'iana-root-tlds',
    version,
    source: `nameverse:${metadata.identity || 'iana-root-tlds'}:${version}`,
    loadedAt: metadata.loadedAt,
    authoritative: metadata.authoritative === true,
    count: tlds.length,
    hash: version,
    tlds,
    indexedTlds: indexed,
    dnsTlds: tlds.filter(tld => !indexedSet.has(tld)),
    coreTlds: normalizeTlds(CORE_DNS_TLDS).filter(tld => tlds.includes(tld)),
  };
}

module.exports = {
  CORE_DNS_TLDS,
  getSupportedTldUniverse,
};
