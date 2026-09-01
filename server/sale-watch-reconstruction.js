'use strict';

/**
 * Stage 1 of the Sale Watch live-sales reconstruction: persist the entire
 * for-sale universe DomainScout already tracks (godaddy-auction +
 * godaddy-closeout, ~920k rows) once per day, diff day-over-day, and queue
 * every domain that EXITED the universe as a reconstruction candidate for
 * stage 2 (adjudication probes).
 *
 * Pure/injectable in the style of server/nrd-importer.js: every side-effecting
 * dependency (enumerate, freeDiskMb) is overridable via opts for deterministic
 * tests. Orchestrators never throw. [SaleWatchRecon] log prefix throughout.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { Worker } = require('worker_threads');
const { freeDiskMb } = require('./nrd-importer');

const DEFAULT_MAX_EXITS_PER_DAY = 25000;
const DEFAULT_UNIVERSE_KEEP_DAYS = 14;
const DEFAULT_ENUMERATE_STREAMS = ['godaddy-auction', 'godaddy-closeout'];
const DEFAULT_SCAN_LIMIT = 5000;
// Rows are re-queued for probing only once adjudication has finished; these
// are the terminal states Stage 2 leaves behind.
const TERMINAL_CANDIDATE_STATES = new Set(['resolved', 'abandoned', 'expired']);

/**
 * Creates (IF NOT EXISTS) the two tables Stage 1 owns. Idempotent — safe to
 * call on every use.
 */
function ensureReconstructionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_watch_candidates (
      domain TEXT PRIMARY KEY,
      first_seen_day TEXT,
      last_seen_day TEXT,
      last_stream TEXT,
      last_price REAL,
      exit_observed_day TEXT,
      state TEXT NOT NULL DEFAULT 'exited',
      next_probe_at TEXT,
      probe_count INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      outcome_tier TEXT,
      evidence_json TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sale_watch_candidates_state_probe
      ON sale_watch_candidates (state, next_probe_at);
    CREATE INDEX IF NOT EXISTS idx_sale_watch_candidates_exit_day
      ON sale_watch_candidates (exit_observed_day);

    CREATE TABLE IF NOT EXISTS sale_watch_universe_days (
      day TEXT PRIMARY KEY,
      domain_count INTEGER,
      file_path TEXT,
      created_at TEXT
    );
  `);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function dateMinusDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function dayFilePath(dir, day) {
  return path.join(dir, `${day}.txt.gz`);
}

/**
 * Streams the current for-sale domain set (via opts.enumerate, an async
 * generator/function yielding batches of {domain, stream, price}) to a
 * sorted, deduped gzip text file, one domain per line, written atomically
 * (tmp file + rename). Never holds full row objects — only a Set of domain
 * strings (a ~1M-entry Set of short strings is fine; the 4GB-heap OOM in this
 * app's history came from holding full provider row objects, not strings).
 */
async function persistUniverseDay(db, { day, enumerate, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const domains = new Set();
  const batches = enumerate({ dir });
  for await (const batch of batches) {
    for (const row of Array.isArray(batch) ? batch : []) {
      const domain = String(row?.domain || '').trim().toLowerCase();
      if (domain) domains.add(domain);
    }
  }

  const sorted = [...domains].sort();
  const finalPath = dayFilePath(dir, day);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;

  await new Promise((resolve, reject) => {
    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(tmpPath);
    gzip.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    gzip.pipe(out);
    for (const domain of sorted) gzip.write(`${domain}\n`);
    gzip.end();
  });
  fs.renameSync(tmpPath, finalPath);

  db.prepare(`
    INSERT INTO sale_watch_universe_days (day, domain_count, file_path, created_at)
    VALUES (@day, @count, @filePath, datetime('now'))
    ON CONFLICT(day) DO UPDATE SET
      domain_count = excluded.domain_count,
      file_path = excluded.file_path,
      created_at = excluded.created_at
  `).run({ day, count: sorted.length, filePath: finalPath });

  console.log(`[SaleWatchRecon] persisted universe day ${day}: ${sorted.length} domains`);
  return { day, count: sorted.length };
}

/**
 * Reads one gz day file's domain lines into a Set of strings via a streaming
 * line reader (never buffers the whole file as one string).
 */
async function readDaySet(dir, day) {
  const filePath = dayFilePath(dir, day);
  if (!fs.existsSync(filePath)) return new Set();
  const set = new Set();
  const input = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const domain = line.trim();
    if (domain) set.add(domain);
  }
  return set;
}

/**
 * Diffs two universe day files. exits = domains present in previousDay but
 * absent from day (left the for-sale streams). entries = the reverse
 * (returned for logging only — not persisted by Stage 1).
 */
async function diffUniverseDays(db, { previousDay, day, dir }) {
  const [previousSet, currentSet] = await Promise.all([
    readDaySet(dir, previousDay),
    readDaySet(dir, day),
  ]);
  const exits = [];
  for (const domain of previousSet) if (!currentSet.has(domain)) exits.push(domain);
  const entries = [];
  for (const domain of currentSet) if (!previousSet.has(domain)) entries.push(domain);
  return { exits, entries };
}

/**
 * Inserts exits into sale_watch_candidates (INSERT OR IGNORE semantics via
 * upsert): a brand-new domain gets a fresh 'exited' row queued for stage 2.
 * A domain already tracked only has its last-seen context refreshed when its
 * current state is TERMINAL (adjudication already finished) — an in-flight
 * row (state 'exited'/'probing'/etc still being worked) is left untouched.
 * Caps at maxPerDay (env DOMAINSCOUT_SALE_WATCH_MAX_EXITS_PER_DAY, default
 * 25000), logging loudly how many were dropped when capped.
 */
function enqueueExitCandidates(db, { exits, day, maxPerDay } = {}) {
  const max = Number.isFinite(maxPerDay) && maxPerDay > 0
    ? maxPerDay
    : (parseInt(process.env.DOMAINSCOUT_SALE_WATCH_MAX_EXITS_PER_DAY, 10) || DEFAULT_MAX_EXITS_PER_DAY);
  const list = Array.isArray(exits) ? exits : [];
  const capped = list.slice(0, max);
  const dropped = list.length - capped.length;
  if (dropped > 0) {
    console.warn(`[SaleWatchRecon] enqueueExitCandidates: capped at ${max} for ${day} — dropped ${dropped} exits`);
  }

  const terminalList = [...TERMINAL_CANDIDATE_STATES];
  const terminalPlaceholders = terminalList.map(() => '?').join(',');
  const insert = db.prepare(`
    INSERT INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, last_price, exit_observed_day, state, next_probe_at, probe_count, updated_at)
    VALUES (@domain, @day, @day, NULL, NULL, @day, 'exited', @day, 0, datetime('now'))
    ON CONFLICT(domain) DO UPDATE SET
      last_seen_day = CASE WHEN state IN (${terminalPlaceholders}) THEN excluded.last_seen_day ELSE last_seen_day END,
      exit_observed_day = CASE WHEN state IN (${terminalPlaceholders}) THEN excluded.exit_observed_day ELSE exit_observed_day END,
      state = CASE WHEN state IN (${terminalPlaceholders}) THEN 'exited' ELSE state END,
      next_probe_at = CASE WHEN state IN (${terminalPlaceholders}) THEN excluded.next_probe_at ELSE next_probe_at END,
      updated_at = CASE WHEN state IN (${terminalPlaceholders}) THEN excluded.updated_at ELSE updated_at END
  `);

  const txn = db.transaction((domains) => {
    for (const domain of domains) {
      insert.run({ domain, day }, ...terminalList, ...terminalList, ...terminalList, ...terminalList, ...terminalList);
    }
  });
  // better-sqlite3 binds named (@domain/@day) and positional (the repeated
  // terminalList `?` groups) params together in a single call.
  const runOne = db.prepare(insert.source);
  const txn2 = db.transaction((domains) => {
    for (const domain of domains) {
      runOne.run({ domain, day, ...Object.fromEntries(terminalList.map((s, i) => [`t${i}`, s])) });
    }
  });
  void txn; void txn2; // superseded by the simpler call below

  let queued = 0;
  const simpleTxn = db.transaction((domains) => {
    for (const domain of domains) {
      insert.run({ domain, day }, ...terminalList, ...terminalList, ...terminalList, ...terminalList, ...terminalList);
      queued += 1;
    }
  });
  simpleTxn(capped);

  console.log(`[SaleWatchRecon] enqueueExitCandidates: ${queued} exits processed for ${day}${dropped > 0 ? ` (${dropped} dropped)` : ''}`);
  return { queued, dropped, day };
}

/**
 * Deletes universe day files + rows older than keepDays (env
 * DOMAINSCOUT_SALE_WATCH_UNIVERSE_KEEP_DAYS, default 14).
 */
function pruneUniverseDays(db, { dir, keepDays } = {}) {
  const keep = Number.isFinite(keepDays) && keepDays > 0
    ? keepDays
    : (parseInt(process.env.DOMAINSCOUT_SALE_WATCH_UNIVERSE_KEEP_DAYS, 10) || DEFAULT_UNIVERSE_KEEP_DAYS);
  const cutoff = dateMinusDays(todayUtc(), keep);
  let rows = [];
  try {
    rows = db.prepare('SELECT day, file_path FROM sale_watch_universe_days WHERE day < ?').all(cutoff);
  } catch (err) {
    console.warn(`[SaleWatchRecon] pruneUniverseDays: failed to read rows: ${err.message}`);
    return { deletedRows: 0, deletedFiles: 0, cutoff };
  }
  let deletedFiles = 0;
  for (const row of rows) {
    const filePath = row.file_path || dayFilePath(dir, row.day);
    try {
      if (filePath && fs.existsSync(filePath)) { fs.unlinkSync(filePath); deletedFiles += 1; }
    } catch (err) {
      console.warn(`[SaleWatchRecon] pruneUniverseDays: failed to delete ${filePath}: ${err.message}`);
    }
  }
  let deletedRows = 0;
  try {
    const info = db.prepare('DELETE FROM sale_watch_universe_days WHERE day < ?').run(cutoff);
    deletedRows = info.changes;
  } catch (err) {
    console.warn(`[SaleWatchRecon] pruneUniverseDays: failed to delete rows: ${err.message}`);
  }
  if (deletedRows > 0 || deletedFiles > 0) {
    console.log(`[SaleWatchRecon] pruneUniverseDays: removed ${deletedFiles} files, ${deletedRows} rows older than ${cutoff}`);
  }
  return { deletedRows, deletedFiles, cutoff };
}

function workerScan(worker, { stream, offset, limit, fields, nowMs }, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = `${stream}:${offset}:${Date.now()}:${Math.random()}`;
    const timer = setTimeout(() => {
      worker.removeListener('message', onMessage);
      reject(new Error('sale-watch-recon worker scan timeout'));
    }, timeoutMs);
    function onMessage(msg) {
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      worker.removeListener('message', onMessage);
      if (!msg.ok) return reject(new Error(msg.error || 'worker scan failed'));
      resolve(msg);
    }
    worker.on('message', onMessage);
    worker.postMessage({ id, stream, operation: 'scan', scan: { offset, limit, fields, nowMs } });
  });
}

/**
 * Default `enumerate`: yields every godaddy-auction and godaddy-closeout
 * domain via the large-provider-worker's 'scan' operation (domain-only
 * projection, paginated), so the full snapshot is never JSON.parse'd or held
 * in the main process. Async generator of {domain, stream, price} batches.
 */
async function* enumerateForSaleUniverse({ streams = DEFAULT_ENUMERATE_STREAMS, limit = DEFAULT_SCAN_LIMIT } = {}) {
  const worker = new Worker(path.join(__dirname, 'large-provider-worker.js'));
  try {
    for (const stream of streams) {
      let offset = 0;
      let done = false;
      const nowMs = Date.now();
      while (!done) {
        let result;
        try {
          result = await workerScan(worker, { stream, offset, limit, fields: ['domain', 'stream', 'auction_price'], nowMs });
        } catch (err) {
          console.warn(`[SaleWatchRecon] enumerate scan failed for ${stream} at offset ${offset}: ${err.message}`);
          break;
        }
        if (result.missing) break;
        const rows = Array.isArray(result.rows) ? result.rows : [];
        if (rows.length) yield rows.map(row => ({ domain: row[0], stream: row[1], price: row[2] }));
        done = result.done !== false;
        offset = result.nextOffset;
        if (!Number.isFinite(offset) || rows.length === 0) done = true;
      }
    }
  } finally {
    worker.removeAllListeners();
    try { await worker.terminate(); } catch (_) { /* best effort */ }
  }
}

/**
 * Orchestrator: determine today (UTC), skip if today's universe row already
 * exists, persist, diff against the most recent prior day, enqueue exits,
 * prune, and return a structured summary. Never throws. Reuses the
 * server/nrd-importer.js disk-pressure guard (fail-open when unreadable).
 */
async function runDailyUniversePass(db, opts = {}) {
  const day = opts.today || todayUtc();
  try {
    const dir = opts.dir;
    if (!dir) return { day, ran: false, reason: 'missing-dir' };

    const already = db.prepare('SELECT 1 FROM sale_watch_universe_days WHERE day = ? LIMIT 1').get(day);
    if (already) {
      console.log(`[SaleWatchRecon] runDailyUniversePass: ${day} already persisted, skipping`);
      return { day, ran: false, reason: 'already-persisted' };
    }

    const floor = parseInt(process.env.DOMAINSCOUT_NRD_MIN_FREE_MB, 10) || 400;
    let free = null;
    try { free = (opts.freeDiskMb || freeDiskMb)(db); } catch (_) { free = null; }
    const diskPressure = typeof free === 'number' && Number.isFinite(free) && free < floor;
    if (diskPressure) {
      console.warn(`[SaleWatchRecon] disk pressure: ${free.toFixed(0)}MB free < ${floor}MB floor — skipping universe persist for ${day}`);
      return { day, ran: false, reason: 'disk-pressure', freeMb: free };
    }

    const enumerateFn = opts.enumerate || enumerateForSaleUniverse;
    const persisted = await persistUniverseDay(db, { day, enumerate: enumerateFn, dir });

    const previousRow = db.prepare(`
      SELECT day FROM sale_watch_universe_days WHERE day < ? ORDER BY day DESC LIMIT 1
    `).get(day);

    let diffResult = null;
    let enqueueResult = null;
    if (previousRow) {
      diffResult = await diffUniverseDays(db, { previousDay: previousRow.day, day, dir });
      enqueueResult = enqueueExitCandidates(db, { exits: diffResult.exits, day, maxPerDay: opts.maxPerDay });
      console.log(`[SaleWatchRecon] runDailyUniversePass: ${day} vs ${previousRow.day}: ${diffResult.exits.length} exits, ${diffResult.entries.length} entries`);
    } else {
      console.log(`[SaleWatchRecon] runDailyUniversePass: ${day} has no prior day to diff against`);
    }

    const pruneResult = pruneUniverseDays(db, { dir, keepDays: opts.keepDays });

    return {
      day,
      ran: true,
      persisted,
      previousDay: previousRow ? previousRow.day : null,
      exits: diffResult ? diffResult.exits.length : 0,
      entries: diffResult ? diffResult.entries.length : 0,
      enqueue: enqueueResult,
      prune: pruneResult,
    };
  } catch (err) {
    console.warn(`[SaleWatchRecon] runDailyUniversePass failed: ${err.message}`);
    return { day, ran: false, reason: 'error', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Stage 2a: adjudication probe engine
//
// Probes candidates that Stage 1 queued (state IN 'exited'/'probing'/
// 'parked-watch' with next_probe_at due), reusing server/sale-watch-discovery
// .js's inspectDomainCandidate EXACTLY (one implementation rule — no
// reimplementation of adjudication logic here). Ladder-based rescheduling
// (7, 23, 30, 30 days by probe_count) governs how long a candidate stays in
// the reconstruction loop before being marked terminal.
// ---------------------------------------------------------------------------

const PROBE_LADDER_DAYS = Object.freeze([7, 23, 30, 30]);
const DEFAULT_PROBE_WAVE_SIZE = 1500;
const DEFAULT_PROBE_CONCURRENCY = 15;
let probeWaveInProgress = false;

function isoDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/**
 * Computes the next_probe_at ISO date for a candidate whose probe_count was
 * `probeCountBeforeThisProbe` before the probe just performed, stepping from
 * `referenceDay`. Returns null when the ladder is exhausted (terminal).
 */
function ladderNextProbeAt(probeCountBeforeThisProbe, referenceDay) {
  if (probeCountBeforeThisProbe >= PROBE_LADDER_DAYS.length) return null;
  const offsetDays = PROBE_LADDER_DAYS[probeCountBeforeThisProbe];
  const base = new Date(`${referenceDay}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return isoDay(base);
}

/**
 * Selects candidates due for probing: state IN ('exited','probing',
 * 'parked-watch') AND next_probe_at <= now, ordered next_probe_at asc,
 * LIMIT limit.
 */
function selectDueCandidates(db, { now, limit } = {}) {
  const nowDay = isoDay(now || new Date()) || todayUtc();
  const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_PROBE_WAVE_SIZE;
  return db.prepare(`
    SELECT * FROM sale_watch_candidates
    WHERE state IN ('exited', 'probing', 'parked-watch')
      AND next_probe_at IS NOT NULL
      AND next_probe_at <= ?
    ORDER BY next_probe_at ASC
    LIMIT ?
  `).all(nowDay, cappedLimit);
}

/**
 * Probes one due candidate row with the shared adjudicator, applies the
 * outcome mapping (terminal detection / parked-watch ladder / dropped /
 * probing ladder), persists the updated row, and returns the outcome
 * descriptor. `inspect` defaults to the lazily required
 * sale-watch-discovery.inspectDomainCandidate so tests can inject a stub.
 */
async function probeCandidate(db, row, { inspect, now } = {}) {
  const inspectFn = inspect || require('./sale-watch-discovery').inspectDomainCandidate;
  const nowDay = isoDay(now || new Date()) || todayUtc();

  const candidate = {
    domain: row.domain,
    sellerNameservers: [],
    providers: [row.last_stream === 'godaddy-closeout' ? 'GoDaddy Closeouts' : 'GoDaddy Auctions'],
    departureDate: row.exit_observed_day,
    detectionDate: row.exit_observed_day,
    sourceKind: 'stream-exit',
  };

  const result = await inspectFn(candidate, {});

  // Stream-exit limbo guard (from live specimen testing 2026-09-01): a name
  // that leaves the GoDaddy streams but still resolves only to GoDaddy's
  // default DNS (*.domaincontrol.com) is in expiry/redemption limbo — that is
  // not buyer infrastructure, however the homepage reads. Treat any would-be
  // detection there as parked-watch so the ladder re-probes it instead.
  const limboNs = (result.buyerNameservers || []).length > 0
    && (result.buyerNameservers || []).every(ns => String(ns).toLowerCase().endsWith('.domaincontrol.com'));
  if (limboNs && (result.tier === 'probable' || result.tier === 'suspected')) {
    result.tier = 'ruled-out';
    result.discovery = { ...(result.discovery || {}), parkingInfrastructure: true, streamExitLimbo: true };
    result.rationale = `${result.rationale || ''} Held as limbo: authoritative DNS is still GoDaddy default (domaincontrol.com), not buyer infrastructure.`.trim();
  }

  const probeCountBeforeThisProbe = Number(row.probe_count) || 0;
  const nextProbeCount = probeCountBeforeThisProbe + 1;
  const evidenceJson = JSON.stringify(result);

  let state;
  let outcome = null;
  let outcomeTier = null;
  let nextProbeAt = null;

  if (result.tier === 'probable' || result.tier === 'suspected') {
    state = 'detected';
    outcome = 'end-user-sale';
    outcomeTier = result.tier;
    nextProbeAt = null;
  } else if (result.tier === 'ruled-out' && result.discovery?.parkingInfrastructure) {
    const scheduled = ladderNextProbeAt(probeCountBeforeThisProbe, nowDay);
    if (scheduled) {
      state = 'parked-watch';
      nextProbeAt = scheduled;
    } else {
      state = 'parked-watch';
      outcome = 'investor-flip';
      nextProbeAt = null;
    }
  } else if (
    result.tier === 'ruled-out'
    && (result.discovery?.parentDelegation?.nameservers || []).length === 0
    && (result.discovery?.recursiveNameservers || []).length === 0
  ) {
    state = 'dropped';
    outcome = 'dropped';
    nextProbeAt = null;
  } else {
    const scheduled = ladderNextProbeAt(probeCountBeforeThisProbe, nowDay);
    if (scheduled) {
      state = 'probing';
      nextProbeAt = scheduled;
    } else {
      state = 'probing';
      outcome = 'no-evidence';
      nextProbeAt = null;
    }
  }

  db.prepare(`
    UPDATE sale_watch_candidates
    SET state = @state,
        outcome = @outcome,
        outcome_tier = @outcomeTier,
        evidence_json = @evidenceJson,
        next_probe_at = @nextProbeAt,
        probe_count = @probeCount,
        updated_at = datetime('now')
    WHERE domain = @domain
  `).run({
    state,
    outcome,
    outcomeTier,
    evidenceJson,
    nextProbeAt,
    probeCount: nextProbeCount,
    domain: row.domain,
  });

  return { domain: row.domain, state, outcome, outcomeTier, tier: result.tier, nextProbeAt, result };
}

/**
 * Runs one probe wave: selects due candidates (waveSize env
 * DOMAINSCOUT_SALE_WATCH_PROBE_WAVE, default 1500), probes them with bounded
 * concurrency (env DOMAINSCOUT_SALE_WATCH_PROBE_CONCURRENCY, default 15) via
 * mapLimit, logs one summary line, and returns the summary object. Never
 * throws; guards against overlapping waves at module scope.
 */
async function runProbeWave(db, opts = {}) {
  if (probeWaveInProgress) {
    console.warn('[SaleWatchRecon] runProbeWave: previous wave still in progress, skipping');
    return { ran: false, reason: 'overlap' };
  }
  probeWaveInProgress = true;
  try {
    const waveSize = Number.isFinite(opts.waveSize) && opts.waveSize > 0
      ? Math.floor(opts.waveSize)
      : (parseInt(process.env.DOMAINSCOUT_SALE_WATCH_PROBE_WAVE, 10) || DEFAULT_PROBE_WAVE_SIZE);
    const concurrency = Number.isFinite(opts.concurrency) && opts.concurrency > 0
      ? Math.floor(opts.concurrency)
      : (parseInt(process.env.DOMAINSCOUT_SALE_WATCH_PROBE_CONCURRENCY, 10) || DEFAULT_PROBE_CONCURRENCY);
    const { mapLimit } = require('./sale-watch-discovery-mapLimit-shim');

    const due = (opts.selectDueCandidates || selectDueCandidates)(db, { now: opts.now, limit: waveSize });

    let detected = 0;
    let parkedWatch = 0;
    let dropped = 0;
    let rescheduled = 0;

    const outcomes = await mapLimit(due, concurrency, async (row) => {
      try {
        return await (opts.probeCandidate || probeCandidate)(db, row, { inspect: opts.inspect, now: opts.now });
      } catch (err) {
        console.warn(`[SaleWatchRecon] runProbeWave: probe failed for ${row.domain}: ${err.message}`);
        return { domain: row.domain, state: 'error', error: err.message };
      }
    });

    for (const outcome of outcomes) {
      if (outcome.state === 'detected') detected += 1;
      else if (outcome.state === 'parked-watch') parkedWatch += 1;
      else if (outcome.state === 'dropped') dropped += 1;
      else if (outcome.state === 'probing') rescheduled += 1;
    }

    const summary = {
      probed: outcomes.length,
      detected,
      parkedWatch,
      dropped,
      rescheduled,
    };
    console.log(`[SaleWatchRecon] wave: ${summary.probed} probed, ${summary.detected} detected, ${summary.parkedWatch} parked-watch, ${summary.dropped} dropped, ${summary.rescheduled} rescheduled`);
    return summary;
  } catch (err) {
    console.warn(`[SaleWatchRecon] runProbeWave failed: ${err.message}`);
    return { ran: false, reason: 'error', error: err.message };
  } finally {
    probeWaveInProgress = false;
  }
}

/**
 * Reads state='detected' rows (default limit 5000, newest updated_at first)
 * mapped to the exact entry shape server/sale-watch.js normalizeEntry
 * accepts. Fields not tracked directly on the row are recovered from
 * evidence_json, falling back sanely when absent.
 */
function readReconstructionEntries(db, { limit } = {}) {
  const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5000;
  const rows = db.prepare(`
    SELECT * FROM sale_watch_candidates
    WHERE state = 'detected'
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(cappedLimit);

  return rows.map((row) => {
    let evidence = {};
    try {
      evidence = row.evidence_json ? JSON.parse(row.evidence_json) : {};
    } catch (_) {
      evidence = {};
    }
    return {
      domain: row.domain,
      tier: row.outcome_tier || evidence.tier || null,
      buyer: evidence.buyer || 'Buyer not yet identified',
      reportDate: evidence.reportDate || row.exit_observed_day || null,
      reportedPriceUsd: null,
      venue: evidence.venue || null,
      precision: evidence.precision || null,
      sellerNameservers: evidence.sellerNameservers || [],
      buyerNameservers: evidence.buyerNameservers || [],
      buyerTitle: evidence.buyerTitle || null,
      buyerUrl: evidence.buyerUrl || `https://${row.domain}/`,
      sourceUrl: evidence.sourceUrl || null,
      rationale: evidence.rationale || '',
      firstObservedAt: row.first_seen_day || null,
      lastObservedAt: row.updated_at || null,
      observationCount: Number.isFinite(Number(row.probe_count)) ? Number(row.probe_count) : null,
      observationStatus: 'reconstruction',
      discovery: evidence.discovery || null,
    };
  });
}

module.exports = {
  ensureReconstructionSchema,
  persistUniverseDay,
  diffUniverseDays,
  enqueueExitCandidates,
  pruneUniverseDays,
  runDailyUniversePass,
  enumerateForSaleUniverse,
  todayUtc,
  dayFilePath,
  readDaySet,
  freeDiskMb,
  DEFAULT_MAX_EXITS_PER_DAY,
  DEFAULT_UNIVERSE_KEEP_DAYS,
  selectDueCandidates,
  probeCandidate,
  runProbeWave,
  readReconstructionEntries,
};
