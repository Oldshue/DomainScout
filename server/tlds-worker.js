/**
 * Accurate TLD-count background worker.
 *
 * This is the ExpiredDomains-style path: compute once in the background, store
 * a supported-universe count, and let the UI read the persisted result instantly.
 * Rows without a current tld_check_cache entry are not considered verified.
 */
const dns  = require('dns').promises;
const db   = require('./db');
const { refreshLogicalTlds } = require('./tlds-list');
const { getNameTlds } = require('./zone-indexer');
const { getSupportedTldUniverse } = require('./tld-universe');

const BATCH = Math.max(1, parseInt(process.env.TLDS_WORKER_BATCH || '25', 10));
const DNS_CONCURRENCY = Math.max(10, parseInt(process.env.TLDS_WORKER_DNS_CONCURRENCY || '160', 10));
const SCOPE = String(process.env.TLDS_WORKER_SCOPE || 'auction').toLowerCase();
const WINDOW_DAYS = Math.max(1, parseInt(process.env.TLDS_WORKER_WINDOW_DAYS || '10', 10));
// Dead/unregistered domains otherwise hang the full timeout — most real NS records
// answer in <300ms, so a tighter timeout massively raises throughput at negligible
// accuracy cost. Configurable for tuning speed vs completeness.
const DNS_TIMEOUT_MS = Math.max(300, parseInt(process.env.TLDS_WORKER_DNS_TIMEOUT_MS || '900', 10));
// Optional curated DNS extension set. gTLD coverage comes from the zone index, so the
// DNS pass only needs the high-value extensions the zones can't cover (mostly ccTLDs).
// Checking ~22 tech/commercial extensions instead of all ~101 in the gap is ~5x faster.
const PRIORITY_DNS_TLDS = String(process.env.TLDS_WORKER_DNS_TLDS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  .map(t => (t.startsWith('.') ? t : '.' + t));

// In priority mode the count is self-contained: "registered in N of the curated
// extensions", checked purely by DNS with no zone-index dependency. Override the
// universe so dedup (getUnchecked), storage (all_count/source), and the result
// filter all agree on that smaller set.
function effectiveUniverse(universe) {
  if (!PRIORITY_DNS_TLDS.length) return universe;
  return {
    ...universe,
    tlds: PRIORITY_DNS_TLDS,
    dnsTlds: PRIORITY_DNS_TLDS,
    count: PRIORITY_DNS_TLDS.length,
    source: `dns-priority-${PRIORITY_DNS_TLDS.length}`,
  };
}

// ── Simple semaphore ──────────────────────────────────────────────────────────
function makeSemaphore(max) {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      return new Promise(res => {
        if (active < max) { active++; res(); }
        else queue.push(res);
      });
    },
    release() {
      active--;
      if (queue.length > 0) { active++; queue.shift()(); }
    },
  };
}

const sem = makeSemaphore(DNS_CONCURRENCY);

// DNS-over-HTTPS: raw port-53 to public resolvers is firewalled in some environments
// and the OS resolver collapses under concurrent load, but HTTPS (443) is open and
// highly concurrent. We round-robin Google + Cloudflare DoH and treat a name as
// registered when the NS query returns an NS answer (type 2).
let dohIdx = 0;
const DOH = [
  (n) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=NS`,
  (n) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=NS`,
];
async function resolveNsLimited(domain) {
  await sem.acquire();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DNS_TIMEOUT_MS);
  try {
    const url = DOH[dohIdx++ % DOH.length](domain);
    const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: ctrl.signal });
    if (!r.ok) return false;
    const j = await r.json();
    return Array.isArray(j.Answer) && j.Answer.some(a => a.type === 2);
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
    sem.release();
  }
}

async function checkAccurateTlds(baseName, universe) {
  // Priority mode: DNS-check only the curated extensions and DO NOT read the zone
  // index — getNameTlds stalls 5s+ ("database is locked") while the zone indexer
  // writes a big zone like .net. This yields a self-contained "N of <priority>"
  // signal with no cross-DB contention and far fewer lookups per name.
  const zoneTlds = PRIORITY_DNS_TLDS.length ? [] : getNameTlds(baseName);
  const gapTlds = PRIORITY_DNS_TLDS.length ? PRIORITY_DNS_TLDS : universe.dnsTlds;
  const live = [];

  for (let i = 0; i < gapTlds.length; i += DNS_CONCURRENCY) {
    const batch = gapTlds.slice(i, i + DNS_CONCURRENCY);
    const results = await Promise.all(batch.map(async tld =>
      (await resolveNsLimited(baseName + tld)) ? tld : null
    ));
    live.push(...results.filter(Boolean));
  }

  // Accept zone TLDs, plus any configured priority extensions that resolved live,
  // plus the rest of the universe — so curated extensions count even if outside the
  // base universe list.
  const universeSet = new Set([...universe.tlds, ...PRIORITY_DNS_TLDS]);
  return [...new Set([...zoneTlds, ...live])]
    .filter(tld => universeSet.has(tld))
    .sort();
}

// ── DB statements ─────────────────────────────────────────────────────────────
const upsertCache = db.prepare(`
  INSERT INTO tld_check_cache (base_name, count, taken_json, all_count, source, checked_at)
  VALUES (@baseName, @count, @takenJson, @allCount, @source, datetime('now'))
  ON CONFLICT(base_name) DO UPDATE SET
    count = excluded.count,
    taken_json = excluded.taken_json,
    all_count = excluded.all_count,
    source = excluded.source,
    checked_at = excluded.checked_at
`);

const upsertBaseCount = db.prepare(`
  INSERT INTO base_tld_counts (base_name, tld_count, source, updated_at)
  VALUES (@baseName, @count, @source, datetime('now'))
  ON CONFLICT(base_name) DO UPDATE SET
    tld_count = excluded.tld_count,
    source = excluded.source,
    updated_at = excluded.updated_at
`);

const updateDomains = db.prepare(`
  UPDATE domains
  SET tlds_taken = @count, tlds_checked_at = datetime('now')
  WHERE base_name = @baseName
`);

const getUncheckedSql = `
  SELECT d.base_name
  FROM domains d
  LEFT JOIN tld_check_cache tc
    ON tc.base_name = d.base_name
   AND tc.all_count = @allCount
   AND tc.source = @source
  WHERE d.base_name IS NOT NULL
    AND d.base_name != ''
    AND tc.base_name IS NULL
    AND (
      @scope = 'all'
      OR d.stream IN ('godaddy-auction', 'godaddy-closeout', 'namecheap-auction')
    )
    AND (
      d.stream NOT IN ('godaddy-auction', 'namecheap-auction')
      OR d.auction_end IS NULL
      OR datetime(d.auction_end) > datetime('now')
    )
  GROUP BY d.base_name
  ORDER BY
    MAX(CASE
      WHEN d.stream = 'namecheap-auction' THEN 30
      WHEN d.stream = 'godaddy-auction'
       AND d.auction_end IS NOT NULL
       AND datetime(d.auction_end) <= datetime('now', '+' || @windowDays || ' days') THEN 20
      WHEN d.stream = 'godaddy-auction' THEN 15
      WHEN d.stream = 'godaddy-closeout' THEN 3
      ELSE 1
    END) DESC,
    MIN(CASE
      WHEN d.stream IN ('godaddy-auction', 'namecheap-auction') AND d.auction_end IS NOT NULL
      THEN datetime(d.auction_end)
      ELSE NULL
    END) ASC NULLS LAST,
    MAX(COALESCE(d.bid_count, 0)) DESC,
    MAX(COALESCE(d.auction_price, 0)) DESC,
    d.base_name ASC
  LIMIT @limit
`;
const getUnchecked = db.prepare(getUncheckedSql);

function storeAccurateCount(baseName, taken, universe) {
  const count = taken.length;
  const source = universe.source;
  db.transaction(() => {
    upsertCache.run({
      baseName,
      count,
      takenJson: JSON.stringify(taken),
      allCount: universe.count,
      source,
    });
    upsertBaseCount.run({ baseName, count, source });
    updateDomains.run({ baseName, count });
  })();
}

// ── Worker loop ───────────────────────────────────────────────────────────────
let checked   = 0;
let startTime = Date.now();

async function runBatch() {
  const universe = effectiveUniverse(getSupportedTldUniverse());
  const allCount = universe.count;
  const rows = getUnchecked.all({
    allCount,
    source: universe.source,
    scope: SCOPE,
    windowDays: WINDOW_DAYS,
    limit: BATCH,
  });

  if (rows.length === 0) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[TLDs Worker] Caught up. ${checked} checked in ${elapsed}m. Sleeping 5min...`);
    setTimeout(runBatch, 5 * 60 * 1000);
    return;
  }

  const baseNames = rows.map(r => r.base_name);
  await Promise.all(baseNames.map(async (baseName) => {
    try {
      const taken = await checkAccurateTlds(baseName, universe);
      storeAccurateCount(baseName, taken, universe);
      checked++;
    } catch (err) {
      console.warn(`[TLDs Worker] ${baseName} failed: ${err.message}`);
    }
  }));

  if (checked % 1000 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[TLDs Worker] ${checked} verified in ${elapsed}m`);
  }

  setImmediate(runBatch); // no artificial pause — run as fast as DNS allows
}

async function startWorker() {
  startTime = Date.now();
  await refreshLogicalTlds();
  const universe = effectiveUniverse(getSupportedTldUniverse());
  console.log(`[TLDs Worker] Starting accurate backfill (scope=${SCOPE}, priority_window=${WINDOW_DAYS}d, batch=${BATCH}, dns_concurrency=${DNS_CONCURRENCY}, universe=${universe.count}, dns_extensions=${universe.dnsTlds.length}${PRIORITY_DNS_TLDS.length ? ' [priority mode]' : ''})...`);
  runBatch().catch(err => {
    console.error('[TLDs Worker] Fatal:', err.message);
    setTimeout(startWorker, 15000);
  });
}

if (require.main === module) {
  startWorker().catch(err => {
    console.error('[TLDs Worker] Fatal startup:', err.message);
    process.exit(1);
  });
}

module.exports = { startWorker };
