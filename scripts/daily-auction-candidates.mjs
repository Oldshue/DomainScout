import { readFileSync } from 'node:fs';

const BASE = process.env.DOMAINSCOUT_BASE || 'http://100.90.156.10:51551';
const PROVIDERS = [
  { stream: 'godaddy-auction', provider: 'GoDaddy' },
  { stream: 'namecheap-auction', provider: 'Namecheap' },
];
const TLDS = new Set(['com', 'ai', 'net', 'io']);
const DISCOVERY_LIMIT = { com: 360, ai: 160, net: 15, io: 15 };
const COVERAGE_BASE_LIMIT = 390;
const READY_TARGET = 345;
// Review breadth, not final-output quotas. Top non-.com strings must earn a place
// in the editor's bounded pool, while the editor can still reject every one.
const REVIEW_BASE_RESERVES = { ai: 60, net: 10, io: 10 };
const MIN_AI_REVIEW = 40;
const COVERAGE_WAIT_MS = 15 * 60_000;
const COVERAGE_MAX_AGE_MS = 8 * 60 * 60_000;
const SNAPSHOT_SCAN_ATTEMPTS = 4;
const SNAPSHOT_PAGE_SIZE = 10_000;
const SNAPSHOT_PAGE_TIMEOUT_MS = 60_000;
const SNAPSHOT_FIELDS = [
  'domain', 'tld', 'auction_price', 'auction_end', 'auction_url',
  'age_years', 'bid_count', 'length', 'has_numbers', 'has_hyphens',
];
const nowMs = Date.now();

const COMMON = new Set(`
able about access account action active adapt advisor agency agent agile air alert alpha answer app apply arc art asset atlas audit auto bank base beacon best beta better bloom blue board bold book boost box bridge bright build buyer byte care cash chain chat city clean cloud club code coin commerce core craft create credit crew data deal desk direct discover doctor drive easy edge energy engine estate expert fair farm fast field finance find fleet flow focus forge fresh fund future game global glow good green grid group guide health hire home host house hub idea index insight invest key kit lab launch lead learning legal lens life link list live local logic loop maker map market media mesh mind mobile money motion move name network next node nova open orbit pay peak people pilot pixel plan play point power prime project proof pulse quick radar real report research rise road root safe save scale scout search secure signal simple smart social solar spark speed spot stack start studio sync team tech time tool top track trade trust united value vault venture view voice web work world zone
`.trim().split(/\s+/));
const REJECT = /(?:casino|gambl|betting|porn|xxx|escort|viagra|cialis|cryptoairdrop|hackaccount|freegiftcard|replica|counterfeit)/i;

const words = new Set(COMMON);
try {
  for (const raw of readFileSync('/usr/share/dict/words', 'utf8').split(/\r?\n/)) {
    const word = raw.trim();
    if (/^[a-z]{3,18}$/.test(word)) words.add(word);
  }
} catch {}

class MinHeap {
  constructor(limit) { this.limit = limit; this.rows = []; }
  push(value) {
    if (this.rows.length < this.limit) {
      this.rows.push(value);
      this.up(this.rows.length - 1);
    } else if (value.score > this.rows[0].score) {
      this.rows[0] = value;
      this.down(0);
    }
  }
  up(i) {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.rows[p].score <= this.rows[i].score) break;
      [this.rows[p], this.rows[i]] = [this.rows[i], this.rows[p]];
      i = p;
    }
  }
  down(i) {
    for (;;) {
      let smallest = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < this.rows.length && this.rows[l].score < this.rows[smallest].score) smallest = l;
      if (r < this.rows.length && this.rows[r].score < this.rows[smallest].score) smallest = r;
      if (smallest === i) break;
      [this.rows[smallest], this.rows[i]] = [this.rows[i], this.rows[smallest]];
      i = smallest;
    }
  }
  sorted() { return this.rows.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain)); }
}

class ProviderSnapshotChangedError extends Error {
  constructor(stream, expected, actual) {
    super(`${stream} provider snapshot changed during deterministic scan (${expected} -> ${actual})`);
    this.name = 'ProviderSnapshotChangedError';
  }
}

function bestSegmentation(label) {
  if (words.has(label)) return { kind: COMMON.has(label) ? 'common word' : 'dictionary word', parts: [label], points: COMMON.has(label) ? 42 : 27 };
  let best = null;
  for (let i = 3; i <= label.length - 3; i += 1) {
    const a = label.slice(0, i);
    const b = label.slice(i);
    if (!words.has(a) || !words.has(b)) continue;
    const common = Number(COMMON.has(a)) + Number(COMMON.has(b));
    const value = 21 + common * 7 - Math.max(0, label.length - 14);
    if (!best || value > best.points) best = { kind: 'two-word phrase', parts: [a, b], points: value };
  }
  return best || { kind: 'brandable string', parts: [], points: 0 };
}

function finiteNumberOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCompleteCoverage(row) {
  const coverage = row.extensionCoverage || row.extension_coverage || null;
  if (!coverage || coverage.status !== 'complete') return null;
  const universeIdentity = String(coverage.universeIdentity || coverage.universeId || '').trim();
  const universeVersion = String(coverage.universeVersion || coverage.version || '').trim();
  const checkedCount = Number(coverage.checkedCount ?? coverage.checkedTlds);
  const totalCount = Number(coverage.totalCount ?? coverage.totalTlds);
  const completedAt = String(coverage.completedAt || '').trim();
  if (!universeIdentity || !universeVersion || !Number.isInteger(checkedCount) || !Number.isInteger(totalCount)) return null;
  if (checkedCount < 1 || checkedCount !== totalCount || !Number.isFinite(Date.parse(completedAt))) return null;
  return { status: 'complete', universeIdentity, universeVersion, checkedCount, totalCount, completedAt };
}

function coverageIsFresh(coverage) {
  return coverage && (Date.now() - Date.parse(coverage.completedAt)) <= COVERAGE_MAX_AGE_MS;
}

function scoreRow(row, provider, { requireCoverage = true } = {}) {
  const domain = String(row.domain || '').toLowerCase();
  const dot = domain.lastIndexOf('.');
  if (dot <= 0) return null;
  const label = domain.slice(0, dot);
  const tld = domain.slice(dot + 1);
  if (!TLDS.has(tld) || !/^[a-z0-9-]+$/.test(label)) return null;
  const endMs = Date.parse(row.auctionEnd || '');
  if (!Number.isFinite(endMs) || endMs <= nowMs) return null;
  if (REJECT.test(label)) return null;
  const extensionCoverage = normalizeCompleteCoverage(row);
  if (!extensionCoverage && requireCoverage) return null;

  let score = 0;
  const warnings = [];
  if (/\d/.test(label)) { score -= 32; warnings.push('number'); }
  if (label.includes('-')) { score -= 38; warnings.push('hyphen'); }
  if (/(.)\1\1/i.test(label)) { score -= 22; warnings.push('repeated letters'); }
  if (/[^aeiou]{6,}/i.test(label)) { score -= 18; warnings.push('hard consonant run'); }
  const vowels = (label.match(/[aeiouy]/g) || []).length;
  const vowelRatio = vowels / Math.max(1, label.length);
  if (vowelRatio >= 0.25 && vowelRatio <= 0.62) score += 9;
  else score -= 10;

  const ideal = tld === 'com' ? 9 : 7;
  score += Math.max(-15, 25 - Math.abs(label.length - ideal) * 3);
  if (label.length <= 5) score += 7;
  if (label.length > (tld === 'com' ? 18 : 15)) score -= 28;

  const lexical = bestSegmentation(label);
  score += lexical.points;
  const rawTldsTaken = finiteNumberOrNull(row.tldsTaken);
  if (requireCoverage && (!Number.isInteger(rawTldsTaken) || rawTldsTaken < 0)) return null;
  const tldsTaken = Number.isInteger(rawTldsTaken) && rawTldsTaken >= 0 ? rawTldsTaken : 0;
  const ageYears = Number(row.ageYears) || 0;
  const wayback = Number(row.wayback) || 0;
  score += Math.min(28, Math.log2(tldsTaken + 1) * 4.5);
  score += Math.min(18, ageYears * 0.75);
  score += Math.min(14, Math.log2(wayback + 1) * 2.2);
  if (String(row.marketWarnings || '').trim()) {
    score -= 18;
    warnings.push(String(row.marketWarnings).slice(0, 90));
  }

  return {
    domain,
    baseName: label,
    provider,
    tld,
    score: Math.round(score * 10) / 10,
    lexical: lexical.parts.length ? lexical.parts.join(' + ') : lexical.kind,
    tldsTaken,
    ageYears,
    wayback,
    extensionCoverage,
    auctionEnd: new Date(endMs).toISOString(),
    currentPrice: finiteNumberOrNull(row.currentPrice),
    bids: null,
    auctionUrl: String(row.auctionUrl || ''),
    warnings,
  };
}

function hydrateExactCoverage(row, payload) {
  const coverage = normalizeCompleteCoverage({ extensionCoverage: payload?.coverage });
  const count = Number(payload?.count);
  const takenExtensions = Array.isArray(payload?.taken)
    ? [...new Set(payload.taken.map(value => String(value || '').replace(/^\./, '').toLowerCase()).filter(Boolean))].sort()
    : [];
  if (!coverage || !Number.isInteger(count) || count < 0 || count !== takenExtensions.length) return null;
  const extensionBonus = Math.min(28, Math.log2(count + 1) * 4.5);
  return {
    ...row,
    score: Math.round((row.score + extensionBonus) * 10) / 10,
    tldsTaken: count,
    takenExtensions,
    extensionCoverage: coverage,
  };
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeSnapshotTuple(tuple, columns) {
  const row = Object.fromEntries(columns.map((column, index) => [column, tuple[index] ?? null]));
  return {
    domain: row.domain,
    auctionEnd: row.auction_end,
    ageYears: row.age_years,
    wayback: null,
    auctionUrl: row.auction_url,
    marketWarnings: '',
    currentPrice: row.auction_price,
    bids: row.bid_count,
  };
}

async function fetchSnapshotPage(stream, offset, snapshotSha256) {
  const url = new URL('/api/provider-snapshots/scan', BASE);
  for (const [key, value] of Object.entries({
    stream,
    offset: String(offset),
    limit: String(SNAPSHOT_PAGE_SIZE),
    fields: SNAPSHOT_FIELDS.join(','),
    tlds: [...TLDS].join(','),
  })) url.searchParams.set(key, value);
  if (snapshotSha256) url.searchParams.set('snapshotSha256', snapshotSha256);
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(SNAPSHOT_PAGE_TIMEOUT_MS) });
      if (response.status === 409) {
        const body = await response.json().catch(() => ({}));
        throw new ProviderSnapshotChangedError(stream, snapshotSha256 || 'initial', body.actualSnapshotSha256 || 'unknown');
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.inventoryHealth?.current !== true || body.inventoryHealth?.serveable !== true || !body.snapshotSha256) {
        throw new Error('inventory is not current and serveable');
      }
      if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) throw new Error('response has no snapshot rows');
      return body;
    } catch (error) {
      if (error instanceof ProviderSnapshotChangedError) throw error;
      lastError = error;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, Math.min(10_000, attempt * 1250)));
    }
  }
  throw new Error(`${stream} snapshot offset ${offset} failed: ${lastError?.message || lastError}`);
}

async function scanProvider({ stream, provider }) {
  const heaps = Object.fromEntries([...TLDS].map(tld => [tld, new MinHeap(DISCOVERY_LIMIT[tld])]));
  const seen = Object.fromEntries([...TLDS].map(tld => [tld, 0]));
  let offset = 0;
  let snapshotSha256 = null;
  let inventoryReceipt = null;
  for (;;) {
    const body = await fetchSnapshotPage(stream, offset, snapshotSha256);
    if (snapshotSha256 && body.snapshotSha256 !== snapshotSha256) {
      throw new ProviderSnapshotChangedError(stream, snapshotSha256, body.snapshotSha256);
    }
    snapshotSha256 = body.snapshotSha256;
    inventoryReceipt ||= {
      stream,
      rowCount: Number(body.totalSnapshotRows),
      generatedAt: body.generatedAt,
      snapshotSha256,
      generationId: body.generationId || null,
      current: true,
      serveable: true,
    };
    for (const tuple of body.rows) {
      const raw = normalizeSnapshotTuple(tuple, body.columns);
      const tld = String(tuple[body.columns.indexOf('tld')] || '').replace(/^\./, '').toLowerCase();
      if (!TLDS.has(tld)) throw new Error(`${stream} snapshot scan crossed its declared TLD scope`);
      seen[tld] += 1;
      const scored = scoreRow(raw, provider, { requireCoverage: false });
      if (scored) {
        scored.bids = finiteNumberOrNull(raw.bids);
        heaps[tld].push(scored);
      }
    }
    const nextOffset = Number(body.nextOffset);
    if (!Number.isInteger(nextOffset) || nextOffset <= offset || nextOffset > body.totalSnapshotRows) {
      if (body.done === true && nextOffset === offset && offset === body.totalSnapshotRows) break;
      throw new Error(`${stream} returned invalid scan cursor ${nextOffset} from ${offset}`);
    }
    offset = nextOffset;
    if (body.done === true) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return {
    inventoryReceipt,
    scan: { provider, stream, seen, candidates: Object.fromEntries([...TLDS].map(tld => [tld, heaps[tld].sorted()])) },
  };
}

async function scanStableProvider(provider) {
  let lastSnapshotError = null;
  for (let attempt = 1; attempt <= SNAPSHOT_SCAN_ATTEMPTS; attempt += 1) {
    try {
      return await scanProvider(provider);
    } catch (error) {
      if (!(error instanceof ProviderSnapshotChangedError)) throw error;
      lastSnapshotError = error;
      if (attempt < SNAPSHOT_SCAN_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1500));
      }
    }
  }
  throw new Error(`${provider.stream} did not hold one stable current snapshot after ${SNAPSHOT_SCAN_ATTEMPTS} bounded scan attempts: ${lastSnapshotError?.message || 'snapshot rollover'}`);
}

const inventory = [];
const scans = [];
for (const provider of PROVIDERS) {
  const stable = await scanStableProvider(provider);
  inventory.push(stable.inventoryReceipt);
  scans.push(stable.scan);
}

const discovered = {};
for (const tld of TLDS) {
  const byDomain = new Map();
  for (const row of scans.flatMap(scan => scan.candidates[tld])) {
    const existing = byDomain.get(row.domain);
    if (!existing || row.score > existing.score || row.auctionEnd < existing.auctionEnd) byDomain.set(row.domain, row);
  }
  discovered[tld] = [...byDomain.values()]
    .sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
}

const tldPriority = { com: 28, ai: 7, net: -20, io: -20 };
const discoveredRows = Object.values(discovered).flat();
const bestPriorityByBase = new Map();
for (const row of discoveredRows) {
  const priority = row.score + tldPriority[row.tld];
  bestPriorityByBase.set(row.baseName, Math.max(priority, bestPriorityByBase.get(row.baseName) ?? -Infinity));
}
const rankedBaseNames = [...bestPriorityByBase]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([baseName]) => baseName);
const selectedBaseSet = new Set();
const requiredAiReviewBases = new Set();
for (const [tld, reserve] of Object.entries(REVIEW_BASE_RESERVES)) {
  const seen = new Set();
  for (const row of discovered[tld]) {
    if (seen.has(row.baseName)) continue;
    seen.add(row.baseName);
    selectedBaseSet.add(row.baseName);
    if (tld === 'ai' && requiredAiReviewBases.size < MIN_AI_REVIEW) requiredAiReviewBases.add(row.baseName);
    if (seen.size >= reserve) break;
  }
}
for (const baseName of rankedBaseNames) {
  if (selectedBaseSet.size >= COVERAGE_BASE_LIMIT) break;
  selectedBaseSet.add(baseName);
}
const selectedBaseNames = [...selectedBaseSet]
  .sort((a, b) => (bestPriorityByBase.get(b) || 0) - (bestPriorityByBase.get(a) || 0) || a.localeCompare(b));
const selectedRows = discoveredRows.filter(row => selectedBaseSet.has(row.baseName));
const rowsByBase = new Map();
for (const row of selectedRows) {
  if (!rowsByBase.has(row.baseName)) rowsByBase.set(row.baseName, []);
  rowsByBase.get(row.baseName).push(row);
}
const baseNames = selectedBaseNames.filter(baseName => rowsByBase.has(baseName));

async function lookupCoverage(baseName) {
  const url = new URL('/api/tlds-lookup-full', BASE);
  url.searchParams.set('baseName', baseName);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 202) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 750));
    }
  }
  throw new Error(`coverage lookup failed for ${baseName}: ${lastError?.message || lastError}`);
}

async function enqueueCoverage(baseName, force) {
  const url = new URL('/api/tlds-check-hybrid', BASE);
  url.searchParams.set('baseName', baseName);
  if (force) url.searchParams.set('force', '1');
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, Math.min(10_000, 750 * (2 ** (attempt - 1)))));
    }
  }
  throw new Error(`coverage enqueue failed for ${baseName}: ${lastError?.message || lastError}`);
}

const completedByBase = new Map();
const staleByBase = new Set();
await mapPool(baseNames, 4, async baseName => {
  try {
    const payload = await lookupCoverage(baseName);
    const coverage = normalizeCompleteCoverage({ extensionCoverage: payload?.coverage });
    if (payload && coverageIsFresh(coverage)) completedByBase.set(baseName, payload);
    else if (payload && coverage) staleByBase.add(baseName);
  } catch {
    // A transient lookup failure is not terminal: the bounded enqueue/poll path
    // below gets an independent chance to produce the exact receipt.
  }
});

const enqueueFailures = [];
await mapPool(baseNames.filter(baseName => !completedByBase.has(baseName)), 2, async baseName => {
  try {
    await enqueueCoverage(baseName, staleByBase.has(baseName));
  } catch (error) {
    enqueueFailures.push({ baseName, error: error.message });
  }
  await new Promise(resolve => setTimeout(resolve, 250));
});

const coverageDeadline = Date.now() + COVERAGE_WAIT_MS;
while (Date.now() < coverageDeadline) {
  const pending = baseNames.filter(baseName => !completedByBase.has(baseName));
  await mapPool(pending, 6, async baseName => {
    try {
      const payload = await lookupCoverage(baseName);
      if (normalizeCompleteCoverage({ extensionCoverage: payload?.coverage })) completedByBase.set(baseName, payload);
    } catch {
      // Keep polling other candidates; one unavailable string must not discard
      // the complete receipts already earned by the rest of the quality pool.
    }
  });
  const readyRows = [...completedByBase.keys()].reduce((sum, baseName) => sum + (rowsByBase.get(baseName)?.length || 0), 0);
  const readyProviders = new Set([...completedByBase.keys()].flatMap(baseName => (rowsByBase.get(baseName) || []).map(row => row.provider)));
  const readyAiReview = [...requiredAiReviewBases].filter(baseName => completedByBase.has(baseName)).length;
  if (readyRows >= READY_TARGET && readyProviders.size === PROVIDERS.length && readyAiReview === requiredAiReviewBases.size) break;
  await new Promise(resolve => setTimeout(resolve, 5000));
}

const hydratedRows = selectedRows
  .map(row => completedByBase.has(row.baseName) ? hydrateExactCoverage(row, completedByBase.get(row.baseName)) : null)
  .filter(Boolean);

const compact = (row) => [
  row.domain, row.provider, row.score, row.lexical, row.tldsTaken, row.ageYears,
  row.wayback, row.auctionEnd, row.currentPrice, row.bids, row.auctionUrl,
  row.warnings.join('; '), row.extensionCoverage, row.takenExtensions,
];
const candidates = {};
for (const tld of TLDS) {
  candidates[tld] = hydratedRows.filter(row => row.tld === tld).sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain)).map(compact);
}
const universe = Object.fromEntries([...TLDS].map(tld => [tld, scans.reduce((sum, scan) => sum + scan.seen[tld], 0)]));
const eligible = Object.fromEntries([...TLDS].map(tld => [tld, candidates[tld].length]));
const allCandidates = Object.values(candidates).flat();
const capCompliantCapacity = candidates.com.length + candidates.ai.length
  + Math.min(5, candidates.net.length) + Math.min(5, candidates.io.length);
if (capCompliantCapacity < 250) {
  throw new Error(`only ${capCompliantCapacity} cap-compliant candidates have complete current extension coverage; ${enqueueFailures.length} coverage enqueues failed`);
}
const coverageReceipts = allCandidates.map(row => row[12]);
const firstCoverage = coverageReceipts[0];
if (!coverageReceipts.every(coverage =>
  coverage?.status === 'complete' &&
  coverage.universeIdentity === firstCoverage.universeIdentity &&
  coverage.universeVersion === firstCoverage.universeVersion &&
  coverage.checkedCount === firstCoverage.checkedCount &&
  coverage.totalCount === firstCoverage.totalCount
)) throw new Error('candidate extension coverage receipts do not share one complete universe');
const extensionCoverage = {
  ...firstCoverage,
  completedAt: coverageReceipts.map(coverage => coverage.completedAt).sort()[0],
};
console.log(JSON.stringify({
  status: 'candidate_pool_ready',
  generatedAt: new Date().toISOString(),
  timezone: 'America/Chicago',
  inventory,
  extensionCoverage,
  universe,
  eligible,
  columns: ['domain','provider','heuristicScore','lexicalEvidence','tldsTaken','ageYears','wayback','auctionEnd','currentPrice','bids','auctionUrl','warnings','extensionCoverage','takenExtensions'],
  candidates,
}));
