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
const { createNameverseCoverageProducer, deferNameverseRefresh, DEFAULT_MAX_AGE_MS } = require('./nameverse-coverage');
const { interpretDohNsResponse } = require('./dns-registration-evidence');
const { createAuthoritativeResolver } = require('./authoritative-dns');
const { readGoDaddyInventoryIndex } = require('./godaddy-cache');
const { snapshotDemandCandidates } = require('./provider-snapshot-demand');
const { releaseLargeProviderSnapshotCaches } = require('./large-provider-snapshot');
const { buildPreverifyOrder } = require('./preverify-order');
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

// zone-truth is required LAZILY, same reasoning as above: avoid opening any
// zone databases until we actually need zone-covered seeding.
let _getZoneTruth = null;
function getZoneTruth() {
  if (!_getZoneTruth) _getZoneTruth = require('./zone-truth').getZoneTruth;
  return _getZoneTruth();
}

function isRecentAsOf(asOf, days) {
  if (!asOf) return false;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(asOfMs)) return false;
  return (Date.now() - asOfMs) <= days * 24 * 60 * 60 * 1000;
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
    return (Array.isArray(ns) && ns.length > 0) ? 'yes' : 'err';
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOTFOUND' || code === 'NXDOMAIN') return 'no';
    // ENODATA can hide a delegated CNAME (for example a sold-domain lander).
    // Only the wire-aware fallback can distinguish it from a negative answer.
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

// Legacy/recursive path: UDP across the public resolver pool, DoH as the
// last-resort fallback. A failed lookup is never counted as "not registered" — it
// retries, and only returns null after exhausting attempts (caller leaves it
// uncounted). Returns true/false/null. Caller must hold `sem`.
async function resolveNsRecursive(domain, attempts = 4) {
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
}

// Authoritative-direct path: ask the TLD's own nameservers (no recursion, raw
// UDP, referral-aware codec). Definite answers carry the same meaning as the
// recursive path (authoritative NXDOMAIN → not registered; NS for the exact
// label → registered), so receipts produced by either path are interchangeable.
// Anything ambiguous is `unknown` and the caller falls back; never a guess.
const authoritativeResolver = createAuthoritativeResolver({ database: db });
async function resolveNsAuthoritative(domain) {
  const result = await authoritativeResolver.probe(domain);
  if (result.status === 'taken') return true;
  if (result.status === 'not_taken') return false;
  return null;
}

// Resolve: authoritative-direct first, recursive/DoH only for ambiguous
// results. Returns true/false/null. Global concurrency bounded by `sem`.
async function resolveNsLimited(domain, attempts = 4, { authoritative = true } = {}) {
  await sem.acquire();
  try {
    const direct = authoritative ? await resolveNsAuthoritative(domain) : null;
    if (direct !== null) return direct;
    return await resolveNsRecursive(domain, attempts);
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
  const zoneAllowed = process.env.TLDS_WORKER_USE_ZONE !== '0';
  const forcedOn = process.env.TLDS_WORKER_USE_ZONE === '1';
  const truth = getZoneTruth();
  // zoneMembership() is exact for EVERY label when the summary carries single-zone
  // membership: multi-zone and single-zone labels list their zones; an absent label
  // is in no zone except possibly an anchor (.com by default), which is returned as
  // `unresolved` and left to DNS. Every other zone is exact not-taken, so a name
  // needs DNS only for the non-zone extensions plus the unresolved anchors, never
  // for the whole universe.
  const zoneInfo = typeof truth.zoneMembership === 'function'
    ? truth.zoneMembership(baseName)
    : { ...truth.nameZones(baseName), unresolved: [] };
  const freshEnough = forcedOn || truth.complete || isRecentAsOf(truth.asOf, 7);
  const useZoneSeeds = zoneAllowed && zoneInfo.exact && freshEnough;
  const zoneSet = useZoneSeeds ? truth.zoneTldSet() : null;
  const unresolved = new Set(Array.isArray(zoneInfo.unresolved) ? zoneInfo.unresolved : []);
  const takenSet = new Set(zoneInfo.tlds || []);
  const indexedSeeds = useZoneSeeds
    ? universe.tlds
        .filter(tld => zoneSet.has(tld) && !unresolved.has(tld))
        .map(tld => ({
          tld,
          status: takenSet.has(tld) ? 'taken' : 'not_taken',
          source: truth.source === 'zone-index' ? 'validated-zone-index' : 'validated-universe-summary',
          checkedAt: truth.asOf ? `${truth.asOf.slice(0, 10)}T00:00:00.000Z` : undefined,
        }))
    : [];
  return nameverseProducer.refreshBaseName(baseName, universe, indexedSeeds);
}

// Snapshot-only providers (e.g. `godaddy-auction`, `godaddy-closeout`) publish their
// large-provider snapshot directly and never insert into `domains` — the worker's other
// demand sources (fastQueuePerStream, imminentMissingPerStream) only read `domains`, so
// those rows were invisible to the accuracy worker. Pull demand straight from the
// immutable provider snapshot instead (generic: any snapshot-only provider hits this).
function snapshotAuctionCandidates(nowMs, exclude) {
  const rows = [];
  for (const stream of ['godaddy-auction', 'godaddy-closeout']) {
    let index = null;
    try {
      index = readGoDaddyInventoryIndex(stream);
    } catch (err) {
      console.warn(`[TLDs Worker] snapshot read failed for ${stream}: ${err.message}`);
      continue;
    }
    if (!index) continue;
    const candidates = snapshotDemandCandidates(index, {
      nowMs,
      endIsExpiry: stream !== 'godaddy-closeout',
      limit: QUEUE_MAX,
      exclude,
    });
    process.stderr.write(`[queue] snapshot:${stream}: ${candidates.length} rows\n`);
    // Tag by stream so the pre-verify producer can give closeouts their own fair
    // share instead of sorting every undated closeout row behind every auction.
    for (const c of candidates) rows.push({ ...c, stream });
    index = null;
    try { releaseLargeProviderSnapshotCaches(stream); } catch (_) {}
  }
  return rows;
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
const popQueue     = db.prepare(`SELECT base_name FROM tld_work_queue WHERE next_attempt_at <= @now ORDER BY ord LIMIT @limit`);
const delFromQueue = db.prepare(`DELETE FROM tld_work_queue WHERE base_name = ?`);
// Interactive requests use -750000/-800000/-1000000 bands. Reorder the old
// broad imminent-auction band too, so it cannot starve closeouts after upgrade.
const scheduleQueue = db.prepare(`INSERT INTO tld_work_queue (base_name, ord) VALUES (?, ?)
  ON CONFLICT(base_name) DO UPDATE SET ord = excluded.ord WHERE tld_work_queue.ord > -100000`);

let _lastTopUp = Date.now();
const RETRY_COOLDOWN_MS = Math.max(60000, Number(process.env.TLDS_WORKER_RETRY_COOLDOWN_MS) || 3600000);
const QUEUE_MAX = Math.max(1000, parseInt(process.env.TLDS_WORKER_QUEUE_MAX || '120000', 10));
// Pre-verify producer: every ingested inventory stream is walked as soon as it
// is imported and interleaved with a fair share per stream, so a large undated
// closeout inventory never starves timed auctions and vice versa. Streams and
// their relative shares are config-driven; unknown streams get share 1.
const PREVERIFY_STREAMS = String(process.env.TLDS_WORKER_PREVERIFY_STREAMS || 'godaddy-auction,namecheap-auction,godaddy-closeout')
  .split(',').map(s => s.trim()).filter(Boolean);
const PREVERIFY_SHARES = Object.fromEntries(String(process.env.TLDS_WORKER_PREVERIFY_SHARES || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(pair => pair.split(':'))
  .filter(([name, share]) => name && Number(share) > 0)
  .map(([name, share]) => [name.trim(), Number(share)]));

// Refresh both inventory streams on the existing inventory top-up cadence.
const TOPUP_INTERVAL_MS = Math.max(60000, parseInt(process.env.TLDS_WORKER_TOPUP_INTERVAL_MS || '600000', 10));

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
    AND (@stream = 'godaddy-closeout' OR auction_end IS NULL OR auction_end > @now)
  ORDER BY auction_end ASC
  LIMIT @scan
`);

function populateWorkQueue(universe) {
  const t = Date.now();
  console.log(`[TLDs Worker] Building work queue (fair-share pre-verify: ${PREVERIFY_STREAMS.join(', ')})...`);
  const now = new Date().toISOString();
  const exclude = new Set(db.prepare(`SELECT base_name FROM tld_check_cache
    WHERE universe_id = ? AND universe_version = ? AND total_count = ?
      AND checked_count = total_count AND coverage_status = 'complete' AND failures_json = '[]'
      AND completed_at >= ? AND completed_at <= ?`).all(
        universe.id, universe.version, universe.count,
        new Date(Date.now() - DEFAULT_MAX_AGE_MS).toISOString(), now).map(row => row.base_name));
  for (const row of db.prepare('SELECT base_name FROM nameverse_check_progress WHERE universe_version = ? AND updated_at > ?')
    .all(universe.version, new Date(Date.now() - DEFAULT_MAX_AGE_MS).toISOString())) exclude.add(row.base_name);
  const scan = QUEUE_MAX * 3;
  const byStream = {};
  for (const stream of PREVERIFY_STREAMS) {
    const st = Date.now();
    const r = fastQueuePerStream.all({ stream, now, scan });
    process.stderr.write(`[queue] ${stream}: ${r.length} rows in ${((Date.now()-st)/1000).toFixed(1)}s\n`);
    byStream[stream] = r; // rows carry base_name + auction_end; never spread (360k args overflows the stack)
  }
  // Snapshot-only providers (godaddy-auction/closeout) publish directly and never enter
  // `domains`, so also seed the queue from the immutable provider snapshot, keyed by
  // stream. Each stream is ordered soonest-end-first (undated rows after dated rows),
  // then interleaved with a fair share per stream: ~170k undated closeouts no longer
  // wait behind every timed auction, and auctions are never starved by closeouts.
  for (const c of snapshotAuctionCandidates(Date.now(), exclude)) {
    const stream = c.stream || 'snapshot';
    if (!byStream[stream]) byStream[stream] = [];
    byStream[stream].push({ base_name: c.base_name, auction_end: c.auction_end || null });
  }
  const collected = Object.values(byStream).reduce((n, r) => n + r.length, 0);
  process.stderr.write(`[queue] ordering ${collected} rows across ${Object.keys(byStream).length} streams...\n`);
  const ordered = buildPreverifyOrder(byStream, { max: QUEUE_MAX, shares: PREVERIFY_SHARES, exclude });
  process.stderr.write(`[queue] ordered ${ordered.length}, inserting...\n`);
  let ord = 0;
  const ins = db.transaction((rs) => {
    for (const r of rs) scheduleQueue.run(r.base_name, ord++);
  });
  ins(ordered);
  console.log(`[TLDs Worker] Work queue built: ${ord} names in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  return ord;
}

// ── Worker loop ───────────────────────────────────────────────────────────────
let checked   = 0;
let processed = 0;
let startTime = Date.now();
let universeRefreshedAt = Date.now();

async function runBatch() {
  if (Date.now() - universeRefreshedAt >= 12 * 60 * 60 * 1000) {
    await refreshLogicalTlds();
    universeRefreshedAt = Date.now();
  }
  const universe = effectiveUniverse(getSupportedTldUniverse());

  // Refresh all inventory streams periodically, including undated closeouts.
  if (Date.now() - _lastTopUp >= TOPUP_INTERVAL_MS) {
    _lastTopUp = Date.now();
    populateWorkQueue(universe);
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
  const rows = popQueue.all({ limit: FETCH_SIZE, now: Date.now() });
  if (!rows.length) { setTimeout(runBatch, 5000); return; }
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
        } else {
          // One unreachable extension must never pin a label at the queue head.
          // Retain its per-extension progress and give the next inventory name a turn.
          deferNameverseRefresh(db, baseName, Date.now() + RETRY_COOLDOWN_MS);
        }
        processed++;
        if (processed % 100 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
          console.log(`[TLDs Worker] ${processed} processed, ${checked} whole-universe verified in ${elapsed}m`);
        }
      } catch (err) {
        deferNameverseRefresh(db, baseName, Date.now() + RETRY_COOLDOWN_MS);
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
  const truth = getZoneTruth();
  console.log(`[TLDs Worker] Starting accurate backfill (scope=${SCOPE}, priority_window=${WINDOW_DAYS}d, batch=${BATCH}, dns_concurrency=${DNS_CONCURRENCY}, universe=${universe.count}, dns_extensions=${universe.dnsTlds.length}${PRIORITY_DNS_TLDS.length ? ' [priority mode]' : ''}, zone_truth=${truth.source}@${truth.asOf})...`);
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
    fsLock.writeFileSync(LOCK_PATH, JSON.stringify({
      pid: process.pid,
      parentPid: process.ppid,
      startedAt: new Date().toISOString(),
    }));
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

module.exports = {
  startWorker,
  resolveNsLimited,
  resolveNsRecursive,
  resolveNsAuthoritative,
  authoritativeResolver,
  checkAccurateTlds,
};
