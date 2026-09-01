'use strict';

/**
 * Stage 1 of the Sale Watch live-sales reconstruction: persist the entire
 * for-sale universe DomainScout already tracks (godaddy-auction +
 * godaddy-closeout, ~920k rows) once per day, diff day-over-day, and queue
 * every domain that EXITED the universe as a reconstruction candidate for
 * stage 2 (adjudication probes — NOT built here).
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
// are the terminal states a Stage 2 (not built here) would leave behind.
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
};
