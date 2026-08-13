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
const { createNameverseCoverageProducer } = require('./nameverse-coverage');
const { interpretDohNsResponse } = require('./dns-registration-evidence');
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
const NAME_CONCURRENCY = Math.max(1, parseInt(process.env.TLDS_WORKER_NAME_CONCURRENCY || '8', 10));
// The persistent priority queue is indexed and cheap to pop. Never reserve more
// work than one active wave: a visible row can be promoted while DNS is running,
// and it must be selected on the very next wave instead of sitting behind a stale
// 200-name prefetch for minutes. The environment remains an upper bound only.
const FETCH_SIZE = Math.max(1, Math.min(
  NAME_CONCURRENCY,
  parseInt(process.env.TLDS_WORKER_FETCH || String(NAME_CONCURRENCY), 10) || NAME_CONCURRENCY,
));
const DNS_CONCURRENCY = Math.max(10, parseInt(process.env.TLDS_WORKER_DNS_CONCURRENCY || '160', 10));
const SCOPE = String(process.env.TLDS_WORKER_SCOPE || 'auction').toLowerCase();
const WINDOW_DAYS = Math.max(1, parseInt(process.env.TLDS_WORKER_WINDOW_DAYS || '10', 10));
// Dead/unregistered domains otherwise hang the full timeout — most real NS records
// answer in <300ms, so a tighter timeout massively raises throughput at negligible
// accuracy cost. Configurable for tuning speed vs completeness.
const DNS_TIMEOUT_MS = Math.max(300, parseInt(process.env.TLDS_WORKER_DNS_TIMEOUT_MS || '900', 10));
// UDP and HTTPS have different latency envelopes. Reusing the aggressively short
// UDP timeout for DoH caused the authoritative fallback to abort under worker load,
// leaving a handful of delegated names permanently unknown. DoH is rare (only after
// all UDP attempts fail), so give it a bounded HTTPS-appropriate timeout.
const DOH_TIMEOUT_MS = Math.max(
  DNS_TIMEOUT_MS,
  parseInt(process.env.TLDS_WORKER_DOH_TIMEOUT_MS || '10000', 10)
);
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
  // A configured priority subset may affect scheduling only; it can never become
  // the public Extensions denominator.
  return universe;
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
  // Checking disabled is deliberate here: the registry state must remain readable
  // during an upstream DNSSEC outage. NXDOMAIN is still required before a negative
  // is accepted, and exact delegation evidence remains positive.
  (n) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=NS&cd=1`,
  (n) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=NS&cd=true`,
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
  const timer = setTimeout(() => ctrl.abort(), DOH_TIMEOUT_MS);
  try {
    const url = DOH[provider % DOH.length](domain);
    const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: ctrl.signal });
    if (!r.ok) return 'err';
    const j = await r.json();
    const evidence = interpretDohNsResponse(j, domain);
    if (evidence.status === 'taken') return 'yes';
    if (evidence.status === 'not_taken') return 'no';
    return 'err';
  } catch (_) {
    return 'err';
  } finally {
    clearTimeout(timer);
  }
}

async function resolveNsDohFallback(domain) {
  // Try every independent endpoint before declaring the registry result unknown.
  // The round-robin starting point spreads load while the bounded loop removes a
  // single-provider timeout as a permanent gap in the complete-IANA receipt.
  for (let attempt = 0; attempt < DOH.length; attempt++) {
    const state = await resolveNsDohOnce(domain, dohIdx++);
    if (state !== 'err') return state;
  }
  return 'err';
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
    const doh = await resolveNsDohFallback(domain);
    if (doh === 'yes') return true;
    if (doh === 'no') return false;
    return null;
  } finally {
    sem.release();
  }
}

const nameverseProducer = createNameverseCoverageProducer({
  database: db,
  resolver: async domain => {
    const result = await resolveNsLimited(domain);
    return result === true ? 'taken' : (result === false ? 'not_taken' : 'unknown');
  },
  batchSize: Math.max(1, parseInt(process.env.TLDS_WORKER_TLD_BATCH || '250', 10)),
  concurrency: DNS_CONCURRENCY,
  source: 'dns-ns',
});

async function checkAccurateTlds(baseName, universe) {
  const useZone = process.env.TLDS_WORKER_USE_ZONE === '1' && universe.indexedTlds.length > 0;
  const zoneTaken = useZone ? new Set(getNameTlds(baseName)) : new Set();
  const indexedSeeds = useZone
    ? universe.indexedTlds.map(tld => ({
        tld,
        status: zoneTaken.has(tld) ? 'taken' : 'not_taken',
        source: 'validated-zone-index',
      }))
    : [];
  return nameverseProducer.refreshBaseName(baseName, universe, indexedSeeds);
}

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

// ── Imminent-auction top-up ───────────────────────────────────────────────────
// The full work queue is built ONCE (soonest-first, capped at QUEUE_MAX) and only
// refilled when fully drained. That starves freshly-scraped imminent auctions: a
// name whose auction ends tomorrow but was added after the last populate (or sits
// beyond the QUEUE_MAX cut) is never enqueued until the whole queue drains — by
// which point its auction has closed. Symptom: the "taken in .ai" filter (which
// reads ONLY tld_check_cache for ccTLDs) shows a tiny fraction of imminent auctions
// because ~90% were never ccTLD-checked. Fix: on a throttle, push the soonest-ending
// auction names that lack a current-universe cache row to the FRONT (negative ord),
// so imminent auctions are always covered first regardless of the main queue state.
const TOPUP_DAYS = Math.max(1, parseInt(process.env.TLDS_WORKER_TOPUP_DAYS || '3', 10));
const TOPUP_LIMIT = Math.max(1000, parseInt(process.env.TLDS_WORKER_TOPUP_LIMIT || '40000', 10));
const TOPUP_INTERVAL_MS = Math.max(60000, parseInt(process.env.TLDS_WORKER_TOPUP_INTERVAL_MS || '600000', 10));
// Let explicit visible/report priorities run before the first broad census.
// The top-up remains periodic, but it cannot strand an on-demand receipt at
// process startup behind a large market-wide query.
let _lastTopUp = Date.now();
// Imminent auction bases with NO current-universe cache row, not already queued,
// soonest-ending first. Per-stream keeps it on idx_stream_auction_end (the 3-stream
// IN forces a full scan); merged in JS. allCount/source pin "checked" to the FULL
// universe so focused/partial rows still get a complete re-check here.
const imminentMissingPerStream = db.prepare(`
  SELECT base_name, MIN(auction_end) AS ae
  FROM domains
  WHERE stream = @stream AND base_name IS NOT NULL AND base_name != ''
    AND auction_end > @now AND auction_end <= @cutoff
    AND base_name NOT IN (SELECT base_name FROM tld_work_queue)
    AND base_name NOT IN (
      SELECT base_name FROM tld_check_cache
      WHERE universe_id = @universeId
        AND universe_version = @universeVersion
        AND checked_count = total_count
        AND total_count = @totalCount
        AND coverage_status = 'complete'
        AND failures_json = '[]'
    )
  GROUP BY base_name
  ORDER BY ae ASC
  LIMIT @limit
`);
function topUpImminent(universe) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + TOPUP_DAYS * 86400000).toISOString();
  const rows = [];
  for (const stream of ['namecheap-auction', 'godaddy-auction']) {
    for (const r of imminentMissingPerStream.all({
      stream, now, cutoff,
      universeId: universe.id, universeVersion: universe.version,
      totalCount: universe.count, limit: TOPUP_LIMIT,
    })) rows.push(r);
  }
  if (!rows.length) return 0;
  rows.sort((a, b) => (a.ae < b.ae ? -1 : a.ae > b.ae ? 1 : 0));
  // Negative ords (soonest = most negative) so these jump ahead of the main backlog.
  let i = 0;
  const ins = db.transaction((rs) => {
    for (const r of rs) {
      insertQueue.run(r.base_name, i - rs.length);
      if (++i >= TOPUP_LIMIT) break;
    }
  });
  ins(rows);
  return Math.min(i, rows.length);
}

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

// ── Worker loop ───────────────────────────────────────────────────────────────
let checked   = 0;
let startTime = Date.now();
let universeRefreshedAt = Date.now();

async function runBatch() {
  if (Date.now() - universeRefreshedAt >= 12 * 60 * 60 * 1000) {
    await refreshLogicalTlds();
    universeRefreshedAt = Date.now();
  }
  const universe = effectiveUniverse(getSupportedTldUniverse());

  // Keep imminent auctions covered: on a throttle, push the soonest-ending names
  // missing a full-universe check to the FRONT of the queue. Cheap, targeted query —
  // does NOT trigger the heavy full re-sort. Skipped in priority mode (its universe
  // is intentionally partial, so the "full check" pin would loop forever).
  if (!PRIORITY_DNS_TLDS.length && (Date.now() - _lastTopUp) >= TOPUP_INTERVAL_MS) {
    _lastTopUp = Date.now();
    try {
      const added = topUpImminent(universe);
      if (added) console.log(`[TLDs Worker] Imminent top-up: +${added} soon-ending names to front of queue`);
    } catch (err) { console.warn(`[TLDs Worker] top-up failed: ${err.message}`); }
  }

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
        const receipt = await checkAccurateTlds(baseName, universe);
        if (receipt.status === 'complete') {
          delFromQueue.run(baseName);
          checked++;
        }
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
  universeRefreshedAt = Date.now();
  const universe = effectiveUniverse(getSupportedTldUniverse());
  console.log(`[TLDs Worker] Starting accurate backfill (scope=${SCOPE}, priority_window=${WINDOW_DAYS}d, batch=${BATCH}, dns_concurrency=${DNS_CONCURRENCY}, universe=${universe.count}, dns_extensions=${universe.dnsTlds.length}${PRIORITY_DNS_TLDS.length ? ' [priority mode]' : ''})...`);
  runBatch().catch(err => {
    console.error('[TLDs Worker] Fatal:', err.message);
    setTimeout(startWorker, 15000);
  });
}

if (require.main === module) {
  // Singleton guard. This worker is started by TWO mechanisms — the launchd
  // `com.hamp.domainscout.tldworker` job AND the server (DOMAINSCOUT_TLD_ACCURACY_WORKER=1
  // → startTldAccuracyWorkerProcess). The tld_work_queue has no per-item claim/lock, so
  // two instances pop the SAME top-N rows and double-process them: wasted DNS/RDAP
  // lookups (rate-limit risk) + duplicate DB writes that contend on locks and bloat the
  // WAL. If a live instance already holds the lock, exit cleanly so exactly one runs.
  // (In this deployment the launchd job is RunAtLoad and starts first, so it holds the
  // lock and the later server-spawned instance is the one that exits — no restart loop.)
  const fsLock = require('fs');
  const pathLock = require('path');
  const lockDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || pathLock.join(__dirname, '../data');
  const LOCK_PATH = pathLock.join(lockDir, 'tlds-worker.lock.json');
  try {
    const existing = fsLock.existsSync(LOCK_PATH)
      ? JSON.parse(fsLock.readFileSync(LOCK_PATH, 'utf8'))
      : null;
    if (existing && existing.pid && existing.pid !== process.pid) {
      let alive = false;
      try { process.kill(existing.pid, 0); alive = true; } catch (_) { alive = false; }
      if (alive) {
        console.log(`[TLDs Worker] Another instance (pid ${existing.pid}) is active — exiting (singleton).`);
        process.exit(0);
      }
    }
    fsLock.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const releaseLock = () => {
      try {
        const cur = JSON.parse(fsLock.readFileSync(LOCK_PATH, 'utf8'));
        if (cur.pid === process.pid) fsLock.unlinkSync(LOCK_PATH);
      } catch (_) {}
    };
    process.on('exit', releaseLock);
    process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
    process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  } catch (err) {
    console.warn('[TLDs Worker] singleton lock check failed (continuing):', err.message);
  }

  startWorker().catch(err => {
    console.error('[TLDs Worker] Fatal startup:', err.message);
    process.exit(1);
  });
}

module.exports = { startWorker };
