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
const { getSupportedTldUniverse } = require('./tld-universe');
// zone-indexer is required LAZILY (only when USE_ZONE=1). Requiring it opens the 55GB
// zone_index.db — which, while the zone build holds a huge WAL, blocks the worker in
// uninterruptible I/O. In DNS-only mode we never touch it, so the DNS worker runs in
// parallel with the zone build (separate database) and produces counts immediately.
let _getNameTlds = null;
function getNameTlds(baseName) {
  if (!_getNameTlds) _getNameTlds = require('./zone-indexer').getNameTlds;
  return _getNameTlds(baseName);
}

// In USE_ZONE mode the zone index already gives definitive membership for every
// indexed gTLD, so DNS only needs to cover the TLDs the zone DOESN'T index — the
// ccTLDs (.co/.de/.io/.ai ...) and a few unindexed gTLDs. That cuts DNS lookups
// per name from ~1285 to ~286 (4.5x faster). Loaded once.
let _zoneIndexedSet = null;
function zoneIndexedSet() {
  if (!_zoneIndexedSet) {
    try { _zoneIndexedSet = require('./zone-indexer').getIndexedTldSet(); }
    catch { _zoneIndexedSet = new Set(); }
  }
  return _zoneIndexedSet;
}

const BATCH = Math.max(1, parseInt(process.env.TLDS_WORKER_BATCH || '25', 10));
// Rows fetched per priority-query (the query is ~50s over 800k rows — amortize it over
// thousands of names, not BATCH). NAME_CONCURRENCY names are resolved at a time.
const FETCH_SIZE = Math.max(1, parseInt(process.env.TLDS_WORKER_FETCH || '4000', 10));
const NAME_CONCURRENCY = Math.max(1, parseInt(process.env.TLDS_WORKER_NAME_CONCURRENCY || '8', 10));
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

// UDP DNS is far faster and higher-throughput than DoH-over-HTTPS (no TLS handshake,
// no per-endpoint HTTP rate limit). We keep a pool of public recursive resolvers and
// round-robin across them so no single resolver is overwhelmed. DoH stays as the
// last-resort fallback for names UDP can't resolve.
const dnsLib = require('dns');
const UDP_SERVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '1.0.0.1', '8.8.4.4', '149.112.112.112', '208.67.222.222', '208.67.220.220'];
const UDP_RESOLVERS = UDP_SERVERS.map(s => {
  const r = new dnsLib.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  r.setServers([s]);
  return r;
});
let udpIdx = 0;
// One UDP attempt → 'yes' | 'no' (authoritative) | 'err' (timeout/SERVFAIL → retry).
async function resolveNsUdpOnce(domain) {
  const r = UDP_RESOLVERS[udpIdx++ % UDP_RESOLVERS.length];
  try {
    const ns = await r.resolveNs(domain);
    return (Array.isArray(ns) && ns.length > 0) ? 'yes' : 'no';
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return 'no';
    return 'err'; // SERVFAIL / ETIMEOUT / network → unknown, retry
  }
}
// One DoH attempt. Returns a tri-state:
//   'yes'  → registered (NS answer present)
//   'no'   → authoritatively not registered (clean DNS response, no NS)
//   'err'  → lookup FAILED (429/5xx/timeout/parse) — UNKNOWN, must be retried.
// Critically, a failed lookup is NOT 'no'. Treating throttled/timed-out lookups as
// "not registered" was undercounting every name (bracelet 13/28 instead of ~107).
// One DoH attempt (fallback path). Does NOT acquire the semaphore — the caller
// (resolveNsLimited) holds it. Tri-state: 'yes' | 'no' | 'err'.
async function resolveNsDohOnce(domain, provider) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DNS_TIMEOUT_MS);
  try {
    const url = DOH[provider % DOH.length](domain);
    const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: ctrl.signal });
    if (!r.ok) return 'err';
    const j = await r.json();
    if (j.Status === 0) return (Array.isArray(j.Answer) && j.Answer.some(a => a.type === 2)) ? 'yes' : 'no';
    if (j.Status === 3) return 'no';
    return 'err';
  } catch (_) {
    return 'err';
  } finally {
    clearTimeout(timer);
  }
}

// Resolve with retries: UDP primary (fast, across the resolver pool), DoH as the
// last-resort fallback. A failed lookup is never counted as "not registered" — it
// retries, and only returns null after exhausting attempts (caller leaves it
// uncounted). Returns true/false/null. Global concurrency bounded by `sem`.
async function resolveNsLimited(domain, attempts = 4) {
  await sem.acquire();
  try {
    for (let a = 0; a < attempts; a++) {
      const state = await resolveNsUdpOnce(domain);
      if (state === 'yes') return true;
      if (state === 'no') return false;
      if (a < attempts - 1) await new Promise(r => setTimeout(r, 60 * (a + 1)));
    }
    // UDP exhausted as 'err' → one DoH fallback before giving up
    const doh = await resolveNsDohOnce(domain, dohIdx++);
    if (doh === 'yes') return true;
    if (doh === 'no') return false;
    return null;
  } finally {
    sem.release();
  }
}

async function checkAccurateTlds(baseName, universe) {
  // Priority mode: DNS-check only the curated extensions and DO NOT read the zone
  // index — getNameTlds stalls 5s+ ("database is locked") while the zone indexer
  // writes a big zone like .net. This yields a self-contained "N of <priority>"
  // signal with no cross-DB contention and far fewer lookups per name.
  // Reading the zone index per name blocks ("database is locked") while the CZDS sync
  // is writing big zones — and until the zones are indexed it returns nothing useful.
  // Gate it behind USE_ZONE: off → DNS-check the full universe via fast UDP (no zone
  // contention); on → use the zone index as the instant gTLD fast-path once it's built.
  const useZone = process.env.TLDS_WORKER_USE_ZONE === '1' && !PRIORITY_DNS_TLDS.length;
  const zoneTlds = useZone ? getNameTlds(baseName) : [];
  // When the zone index is the gTLD authority, DNS only the gap (ccTLDs + any
  // unindexed gTLD) — every indexed gTLD's membership is already known from zoneTlds.
  const gapTlds = PRIORITY_DNS_TLDS.length
    ? PRIORITY_DNS_TLDS
    : (useZone ? universe.dnsTlds.filter(t => !zoneIndexedSet().has(t)) : universe.dnsTlds);
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

// ── Persistent work queue ───────────────────────────────────────────────────
// The priority query above is a GROUP BY + multi-key sort over ~800k+ auction rows;
// on a cold cache it takes minutes, and re-running it per batch (or on every restart)
// is what pinned the worker at 0/hr. Instead we run it ONCE, persist the prioritized
// names into a tiny indexed table, and pop from it instantly. The queue survives
// restarts — no re-sort — and is refilled only when drained.
db.exec(`CREATE TABLE IF NOT EXISTS tld_work_queue (base_name TEXT PRIMARY KEY, ord INTEGER)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tld_work_queue_ord ON tld_work_queue(ord)`);
const queueCount   = db.prepare(`SELECT COUNT(*) c FROM tld_work_queue`);
const popQueue     = db.prepare(`SELECT base_name FROM tld_work_queue ORDER BY ord LIMIT @limit`);
const delFromQueue = db.prepare(`DELETE FROM tld_work_queue WHERE base_name = ?`);
const insertQueue  = db.prepare(`INSERT OR IGNORE INTO tld_work_queue (base_name, ord) VALUES (?, ?)`);
const QUEUE_MAX = Math.max(1000, parseInt(process.env.TLDS_WORKER_QUEUE_MAX || '120000', 10));

// Fast populate: NO anti-join (the per-row tld_check_cache lookup over ~1M rows was the
// killer) and NO GROUP BY temp B-tree — walk auction rows in auction_end order (index)
// and INSERT OR IGNORE; the queue's PRIMARY KEY dedups names. Including already-counted
// names is harmless: they all need the new full-universe count anyway, and the handful
// already done get a cheap recompute. Soonest auctions first.
// auction_end is ISO text ("2026-06-03T16:00:00.000Z") so a STRING compare + ORDER BY
// auction_end uses idx_auction_end (1.5s) — wrapping it in datetime() defeated the index
// and made this a 44s+ full scan. @now is an ISO string passed at call time.
// Query each stream SEPARATELY — a single-stream WHERE uses idx_stream_auction_end
// (index-ordered, ~1.5s); a 3-stream IN forces a full scan + sort (40s+). We merge the
// per-stream results by auction_end in JS.
const fastQueuePerStream = db.prepare(`
  SELECT base_name, auction_end FROM domains
  WHERE stream = @stream AND base_name IS NOT NULL AND base_name != ''
    AND auction_end IS NOT NULL AND auction_end > @now
  ORDER BY auction_end ASC
  LIMIT @scan
`);

function populateWorkQueue(universe) {
  const t = Date.now();
  console.log(`[TLDs Worker] Building work queue (soonest-auction-first)...`);
  const now = new Date().toISOString();
  const scan = QUEUE_MAX * 3;
  const rows = [];
  for (const stream of ['godaddy-auction', 'namecheap-auction', 'godaddy-closeout']) {
    const st = Date.now();
    const r = fastQueuePerStream.all({ stream, now, scan });
    process.stderr.write(`[queue] ${stream}: ${r.length} rows in ${((Date.now()-st)/1000).toFixed(1)}s\n`);
    for (const x of r) rows.push(x); // NOT rows.push(...r) — spreading 360k args overflows the stack
  }
  process.stderr.write(`[queue] sorting ${rows.length} rows...\n`);
  rows.sort((a, b) => (a.auction_end < b.auction_end ? -1 : a.auction_end > b.auction_end ? 1 : 0));
  process.stderr.write(`[queue] sorted, inserting...\n`);
  let ord = 0;
  const seen = new Set();
  const ins = db.transaction((rs) => {
    for (const r of rs) {
      if (seen.has(r.base_name)) continue;
      seen.add(r.base_name);
      insertQueue.run(r.base_name, ord++);
      if (ord >= QUEUE_MAX) break;
    }
  });
  ins(rows);
  console.log(`[TLDs Worker] Work queue built: ${ord} names in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  return ord;
}

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

  // Refill the persistent queue only when it's drained (rare — the slow sort runs once
  // per ~QUEUE_MAX names, never on a warm-restart with names still queued).
  if (queueCount.get().c === 0) {
    const n = populateWorkQueue(universe);
    if (n === 0) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`[TLDs Worker] Caught up. ${checked} checked in ${elapsed}m. Sleeping 5min...`);
      setTimeout(runBatch, 5 * 60 * 1000);
      return;
    }
  }

  // Pop a chunk from the queue (instant, index-ordered) and stream through the pool.
  const rows = popQueue.all({ limit: FETCH_SIZE });
  const baseNames = rows.map(r => r.base_name);
  let idx = 0;
  const pool = Array.from({ length: NAME_CONCURRENCY }, async () => {
    while (idx < baseNames.length) {
      const baseName = baseNames[idx++];
      try {
        const taken = await checkAccurateTlds(baseName, universe);
        storeAccurateCount(baseName, taken, universe);
        delFromQueue.run(baseName);
        checked++;
        if (checked % 100 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
          console.log(`[TLDs Worker] ${checked} verified in ${elapsed}m`);
        }
      } catch (err) {
        console.warn(`[TLDs Worker] ${baseName} failed: ${err.message}`);
      }
    }
  });
  await Promise.all(pool);

  setImmediate(runBatch); // re-fetch the next big batch
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
