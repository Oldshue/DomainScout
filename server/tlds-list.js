// Shared TLD list used by enrichment and the tlds-taken worker.
//
// CHECK_TLDS is intentionally mutable: modules destructure it at require-time,
// so refreshLogicalTlds() updates the array in place after loading IANA data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_BASE = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const CACHE_PATH = path.join(DATA_BASE, 'logical-tlds.json');
const IANA_TLD_URL = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt';
const IANA_CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const FALLBACK_TLDS = [
  // Core gTLDs
  '.com', '.net', '.org', '.info', '.biz', '.co', '.us',
  // Tech / startup
  '.io', '.ai', '.app', '.dev', '.tech', '.digital', '.cloud', '.software',
  '.systems', '.network', '.codes', '.tools', '.build', '.run', '.works',
  '.solutions', '.services', '.engineering', '.technology', '.computer',
  // Media / content
  '.tv', '.media', '.news', '.blog', '.social', '.live', '.online', '.site',
  '.web', '.click', '.link', '.stream', '.video', '.audio', '.studio',
  // Brand / personality
  '.me', '.gg', '.cc', '.vc', '.xyz', '.inc', '.llc', '.agency', '.group',
  '.team', '.club', '.pro', '.one', '.global', '.world', '.space', '.zone',
  '.life', '.guru', '.ninja', '.expert', '.consulting', '.ventures',
  // Commerce
  '.shop', '.store', '.market', '.trade', '.deals', '.sale', '.auction',
  '.finance', '.capital', '.fund', '.holdings', '.exchange', '.partners',
  '.company', '.business', '.enterprises', '.associates', '.international',
  // Creative
  '.design', '.art', '.photography', '.gallery', '.creative', '.productions',
  '.graphics', '.photos',
  // Other common gTLDs
  '.ly', '.sh', '.bot', '.plus', '.academy', '.center', '.foundation',
  '.institute', '.education', '.school', '.university', '.science',
  '.health', '.care', '.fit', '.gym', '.games', '.fun', '.entertainment',
  '.events', '.show', '.band', '.music', '.radio',
  '.legal', '.law', '.attorney', '.insurance', '.mortgage', '.loans',
  '.energy', '.solar', '.green', '.eco',
  '.pizza', '.coffee', '.beer', '.wine', '.restaurant', '.food', '.kitchen',
  '.travel', '.flights', '.hotel', '.estate', '.properties', '.land',
  '.city', '.town', '.place',
  // Major ccTLDs
  '.de', '.fr', '.es', '.it', '.nl', '.ca', '.ru', '.br', '.in',
  '.uk', '.au', '.jp', '.cn', '.ch', '.se', '.no', '.dk', '.fi',
  '.pl', '.cz', '.at', '.be', '.pt', '.gr', '.ro', '.hu', '.ie',
  '.mx', '.ar', '.cl', '.za', '.sg', '.hk', '.tw', '.kr', '.id',
  '.ph', '.th', '.vn', '.my', '.nz', '.ae', '.sa', '.tr', '.il',
  '.ng', '.ke', '.eg', '.ma', '.pk', '.lk', '.is', '.lt', '.lv', '.ee',
];

const EXCLUDED_TLDS = new Set([
  // Infrastructure namespace; it is delegated but not a public registration suffix.
  '.arpa',
]);

const CHECK_TLDS = [...FALLBACK_TLDS];
let tldSource = {
  source: 'fallback', loadedAt: null, count: CHECK_TLDS.length, error: null,
  identity: 'iana-root-tlds', version: null, authoritative: false,
};

function normalizeTlds(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || raw.startsWith('#')) continue;
    const tld = raw.startsWith('.') ? raw : `.${raw}`;
    // IANA publishes the root in ASCII, including A-label (xn--) IDN TLDs.
    // Those are real delegated extensions and belong in the denominator.
    if (!/^\.[a-z0-9-]+$/.test(tld)) continue;
    if (EXCLUDED_TLDS.has(tld)) continue;
    if (!seen.has(tld)) {
      seen.add(tld);
      out.push(tld);
    }
  }
  return out.sort();
}

function replaceCheckTlds(next, source, error = null, fetchedAt = null) {
  const normalized = normalizeTlds(next);
  if (!normalized.length) return false;
  CHECK_TLDS.splice(0, CHECK_TLDS.length, ...normalized);
  const loadedAt = fetchedAt || new Date().toISOString();
  const fetchedMs = Date.parse(loadedAt);
  const authoritative = source === 'iana' || (
    source === 'iana-cache' && Number.isFinite(fetchedMs) && Date.now() - fetchedMs <= IANA_CACHE_MAX_AGE_MS
  );
  tldSource = {
    source,
    loadedAt,
    count: CHECK_TLDS.length,
    error,
    identity: 'iana-root-tlds',
    version: authoritative ? crypto.createHash('sha256').update(CHECK_TLDS.join('\n')).digest('hex') : null,
    authoritative,
  };
  return true;
}

function loadCachedTlds() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return false;
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return replaceCheckTlds(cached.tlds, 'iana-cache', null, cached.fetchedAt || null);
  } catch (err) {
    tldSource = { ...tldSource, error: err.message };
    return false;
  }
}

async function refreshLogicalTlds() {
  fs.mkdirSync(DATA_BASE, { recursive: true });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(IANA_TLD_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`IANA HTTP ${resp.status}`);
    const body = await resp.text();
    const tlds = body
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (!replaceCheckTlds(tlds, 'iana')) throw new Error('IANA response did not contain usable TLDs');
    fs.writeFileSync(CACHE_PATH, JSON.stringify({
      source: IANA_TLD_URL,
      fetchedAt: tldSource.loadedAt,
      tlds: CHECK_TLDS,
    }, null, 2));
    return tldSource;
  } catch (err) {
    const usedCache = loadCachedTlds();
    if (!usedCache) {
      replaceCheckTlds(FALLBACK_TLDS, 'fallback', err.message, null);
    } else {
      tldSource = { ...tldSource, error: err.message };
    }
    return tldSource;
  }
}

function getCheckTlds() {
  return CHECK_TLDS;
}

function getTldSource() {
  return { ...tldSource };
}

// Synchronously prefer a previously fetched IANA cache before the server starts
// accepting requests; async refresh then updates it if the network is available.
loadCachedTlds();

module.exports = {
  CHECK_TLDS,
  FALLBACK_TLDS,
  getCheckTlds,
  getTldSource,
  refreshLogicalTlds,
};
