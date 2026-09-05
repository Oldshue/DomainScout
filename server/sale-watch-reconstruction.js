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
 *
 * Stage 3 adds a zone-wide universe source: the CZDS .com zone file carries
 * the NS records of every delegated .com name, so server/zone-ns-universe.js
 * is unioned in here (behind DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED) alongside
 * the provider (GoDaddy) scan, with per-source counts persisted for audit.
 */

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const child_process = require('child_process');
const { Worker } = require('worker_threads');
const { freeDiskMb } = require('./nrd-importer');
const { ensureZoneNsUniverseSchema } = require('./zone-ns-universe');

const DEFAULT_MAX_EXITS_PER_DAY = 25000;
const DEFAULT_UNIVERSE_KEEP_DAYS = 14;
const DEFAULT_ENUMERATE_STREAMS = ['godaddy-auction', 'godaddy-closeout'];
const DEFAULT_SCAN_LIMIT = 5000;
const DEFAULT_ZONE_NS_UNIVERSE_TIMEOUT_MS = 90 * 60 * 1000;
// Rows are re-queued for probing only once adjudication has finished; these
// are the terminal states Stage 2 leaves behind.
const TERMINAL_CANDIDATE_STATES = new Set(['resolved', 'abandoned', 'expired']);

/**
 * Creates (IF NOT EXISTS) the tables Stage 1/3 own. Idempotent — safe to
 * call on every use.
 */
function ensureReconstructionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_watch_observations (
      domain TEXT NOT NULL, observed_at TEXT NOT NULL, kind TEXT NOT NULL,
      digest TEXT NOT NULL, evidence_json TEXT NOT NULL,
      PRIMARY KEY (domain, digest)
    );
    CREATE INDEX IF NOT EXISTS sale_watch_observations_domain_date ON sale_watch_observations(domain, observed_at);
    CREATE TABLE IF NOT EXISTS sale_watch_movement_imports (
      day TEXT PRIMARY KEY, source_signature TEXT NOT NULL, imported_at TEXT NOT NULL,
      departures INTEGER NOT NULL, queued INTEGER NOT NULL, summary_json TEXT NOT NULL
    );
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

    CREATE TABLE IF NOT EXISTS sale_watch_universe_sources (
      day TEXT NOT NULL,
      source TEXT NOT NULL,
      count INTEGER,
      created_at TEXT,
      PRIMARY KEY (day, source)
    );
  `);
  // Revive previously terminal heuristic detections once: they need continued observation.
  db.prepare("UPDATE sale_watch_candidates SET next_probe_at = date('now') WHERE state = 'detected' AND next_probe_at IS NULL").run();
}

function recordObservation(db, domain, observedAt, kind, evidence) {
  const serialized = JSON.stringify(evidence);
  const digest = crypto.createHash('sha256').update(kind + serialized).digest('hex');
  db.prepare('INSERT OR IGNORE INTO sale_watch_observations(domain,observed_at,kind,digest,evidence_json) VALUES(?,?,?,?,?)').run(domain,observedAt,kind,digest,serialized);
  // Keep a bounded, dated history per domain. Movement chronology is retained independently.
  db.prepare(`DELETE FROM sale_watch_observations WHERE domain=? AND kind='probe' AND digest NOT IN
    (SELECT digest FROM sale_watch_observations WHERE domain=? AND kind='probe' ORDER BY observed_at DESC LIMIT 40)`).run(domain,domain);
}

async function ingestMovementCandidates(db, { directory = process.env.DOMAINSCOUT_UNIVERSE_DIR || path.join(os.homedir(),'DomainScout','universe','work'), maxDays = 7 } = {}) {
  let days;
  try { days = fs.readdirSync(directory).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-maxDays); }
  catch(error) { if(error.code==='ENOENT') return { available:false, queued:0 }; throw error; }
  let queued = 0;
  for (const day of days) {
    const tape = path.join(directory,day,'ns','movement.jsonl');
    const summaryPath = path.join(directory,day,'ns','summary.json');
    if (!fs.existsSync(tape) || !fs.existsSync(summaryPath)) continue;
    const stat=fs.statSync(tape), signature=`${stat.size}:${stat.mtimeMs}`;
    if(db.prepare('SELECT source_signature FROM sale_watch_movement_imports WHERE day=?').get(day)?.source_signature===signature)continue;
    const summary=JSON.parse(fs.readFileSync(summaryPath,'utf8'));
    let departures=0, dayQueued=0;
    const cohorts=new Map();
    const lines=readline.createInterface({input:fs.createReadStream(tape),crlfDelay:Infinity});
    const upsert=db.prepare(`INSERT INTO sale_watch_candidates(domain,first_seen_day,last_seen_day,last_stream,exit_observed_day,state,next_probe_at,probe_count,evidence_json,updated_at)
      VALUES(@domain,@before,@day,'zone-seller-departure',@day,'exited',@day,0,@evidence,@observed)
      ON CONFLICT(domain) DO UPDATE SET last_seen_day=excluded.last_seen_day,
      last_stream=CASE WHEN excluded.exit_observed_day>sale_watch_candidates.exit_observed_day THEN excluded.last_stream ELSE sale_watch_candidates.last_stream END,
      evidence_json=CASE WHEN sale_watch_candidates.evidence_json IS NULL OR excluded.exit_observed_day>sale_watch_candidates.exit_observed_day THEN excluded.evidence_json ELSE sale_watch_candidates.evidence_json END,
      next_probe_at=CASE WHEN sale_watch_candidates.next_probe_at IS NULL OR excluded.exit_observed_day>sale_watch_candidates.exit_observed_day THEN excluded.next_probe_at ELSE sale_watch_candidates.next_probe_at END,
      state=CASE WHEN excluded.exit_observed_day>sale_watch_candidates.exit_observed_day THEN 'exited' ELSE sale_watch_candidates.state END,
      exit_observed_day=MAX(COALESCE(sale_watch_candidates.exit_observed_day,''),excluded.exit_observed_day)`);
    const save=db.transaction(batch=>{for(const row of batch){
      departures++;
      const movement={day,prevDay:summary.prevDay||dateMinusDays(day,1),previousNameservers:row.prev_ns||[],currentNameservers:row.today_ns||[],previousProvider:row.prev_provider||null,currentProvider:row.today_provider||null,previousClass:row.prev_class,currentClass:row.today_class,destinationProbe:row.probe||null,source:'daily-zone-delegation-diff',sourceUrl:`/api/universe/ns-movement?day=${day}&q=${encodeURIComponent(row.domain)}`};
      const cohortKey=(movement.currentNameservers||[]).slice().sort().join(',');
      if(!cohorts.has(cohortKey))cohorts.set(cohortKey,[]);cohorts.get(cohortKey).push(row.domain);
      const initial={domain:row.domain,tier:'suspected',sellerNameservers:movement.previousNameservers,buyerNameservers:movement.currentNameservers,reportDate:day,venue:movement.previousProvider,discovery:{movement,structurallyMoved:true,departureDate:day}};
      upsert.run({domain:row.domain,before:movement.prevDay,day,evidence:JSON.stringify(initial),observed:new Date().toISOString()});
      recordObservation(db,row.domain,day+'T00:00:00Z','movement',movement);dayQueued++;
    }});
    let batch=[];
    for await(const line of lines){if(!line.trim())continue;const row=JSON.parse(line);if(row.selection!=='departures'||!['seller','parking'].includes(row.prev_class)||!row.domain||!Array.isArray(row.prev_ns))continue;batch.push(row);if(batch.length>=250){save(batch);batch=[];}}
    if(batch.length)save(batch);
    const cohortUpdate=db.prepare("UPDATE sale_watch_candidates SET evidence_json=json_set(evidence_json,'$.discovery.movement.cohortSize',?) WHERE domain=? AND exit_observed_day=?");
    db.transaction(()=>{for(const domains of cohorts.values())for(const domain of domains)cohortUpdate.run(domains.length,domain,day);})();
    db.prepare('INSERT OR REPLACE INTO sale_watch_movement_imports VALUES(?,?,?,?,?,?)').run(day,signature,new Date().toISOString(),departures,dayQueued,JSON.stringify({day,prevDay:summary.prevDay,zones:summary.zones,departures:summary.departures,totals:summary.totals}));queued+=dayQueued;
  }
  return {available:true,queued};
}

function ingestDiscoveryCandidates(db, { file = process.env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_PATH || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname,'../data'),'sale-watch-discovery.json') } = {}) {
  if(!fs.existsSync(file))return {queued:0};
  const ledger=JSON.parse(fs.readFileSync(file,'utf8'));
  const insert=db.prepare(`INSERT OR IGNORE INTO sale_watch_candidates(domain,first_seen_day,last_seen_day,last_stream,exit_observed_day,state,next_probe_at,probe_count,evidence_json,updated_at) VALUES(?,?,?,'historical-departure',?, ?, ?,0,?,?)`);
  let queued=0;
  db.transaction(()=>{for(const entry of [...(ledger.entries||[]),...(ledger.retiredEntries||[])]){
    if(!entry.discovery||!entry.domain||!entry.sellerNameservers?.length)continue;
    const observed=entry.lastObservedAt||ledger.generatedAt;
    const day=entry.discovery.departureDate||entry.reportDate;
    const added=insert.run(entry.domain,entry.firstObservedAt||day,day,day,(entry.discovery.rdap?.pendingTransfer || (entry.discovery.rdap?.statuses||[]).some(s=>String(s).toLowerCase().replace(/[^a-z]/g,'')==='pendingtransfer'))?'transferring':'exited',new Date().toISOString(),JSON.stringify(entry),observed||new Date().toISOString());
    if(added.changes){queued++;if(observed)recordObservation(db,entry.domain,observed,'probe',{nameservers:entry.buyerNameservers||[],rdap:entry.discovery.rdap||null,homepage:entry.discovery.homepage||null,registrar:entry.discovery.rdap?.registrar||null,tier:entry.tier,source:'retained-discovery-observation'});}
  }})();
  return {queued};
}

function reconstructionCoverage(db) {
  const latest=db.prepare('SELECT * FROM sale_watch_movement_imports ORDER BY day DESC LIMIT 1').get();
  const states=db.prepare('SELECT state,COUNT(*) AS count FROM sale_watch_candidates GROUP BY state').all();
  const observed=db.prepare("SELECT COUNT(DISTINCT domain) AS count FROM sale_watch_observations WHERE kind='probe'").get().count;
  const latestProbe=db.prepare("SELECT MAX(observed_at) AS at FROM sale_watch_observations WHERE kind='probe'").get().at;
  return {movement:latest?{...JSON.parse(latest.summary_json),importedAt:latest.imported_at,queued:latest.queued}:null,states,domainsObserved:observed,lastProbeAt:latestProbe,
    due:db.prepare("SELECT COUNT(*) AS count FROM sale_watch_candidates WHERE next_probe_at<=? AND state IN('exited','probing','parked-watch','detected','transferring')").get(new Date().toISOString()).count};
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
 *
 * When `zoneNsUniverse` is supplied (stage 3, an async () => result thunk
 * that resolves to server/zone-ns-universe.js's buildZoneUniverseDay()
 * shape), its domains are unioned into the set before the file is written,
 * so the persisted day file already reflects the full reconstruction
 * universe (provider scan union zone NS scan). Per-source counts are logged
 * and persisted to sale_watch_universe_sources for audit.
 *
 * When `zoneNsHits` is supplied instead (`{ database, day }`, the bounded
 * SQLite-backed union used by runDailyUniversePass in production), the
 * provider Set built above is never unioned in memory with the zone set: it
 * is written into a `temp.universe_provider` table (batched inserts of
 * 5000, in transactions) in `zoneNsHits.database`, then the sorted union of
 * that temp table with `zone_ns_universe_hits` for `zoneNsHits.day` is
 * streamed straight into the gzip writer via `.iterate()`. Memory stays
 * O(batch) regardless of universe size. `zoneNsUniverse` and `zoneNsHits`
 * are mutually exclusive; when both are absent behavior is unchanged
 * (provider-only, as before).
 */
async function persistUniverseDay(db, { day, enumerate, dir, zoneNsUniverse, zoneNsHits } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const domains = new Set();
  const batches = enumerate({ dir });
  for await (const batch of batches) {
    for (const row of Array.isArray(batch) ? batch : []) {
      const domain = String(row?.domain || '').trim().toLowerCase();
      if (domain) domains.add(domain);
    }
  }

  const providerCount = domains.size;
  let zoneCount = 0;
  let total = 0;
  const finalPath = dayFilePath(dir, day);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;

  if (zoneNsHits && zoneNsHits.database) {
    const zdb = zoneNsHits.database;
    ensureZoneNsUniverseSchema(zdb);
    zdb.exec('CREATE TEMP TABLE IF NOT EXISTS universe_provider (domain TEXT PRIMARY KEY)');
    zdb.exec('DELETE FROM temp.universe_provider');
    const insertStmt = zdb.prepare('INSERT OR IGNORE INTO temp.universe_provider (domain) VALUES (?)');
    const insertBatch = zdb.transaction((rows) => {
      for (const domain of rows) insertStmt.run(domain);
    });
    const providerList = [...domains];
    for (let i = 0; i < providerList.length; i += 5000) {
      insertBatch(providerList.slice(i, i + 5000));
    }

    zoneCount = zdb.prepare('SELECT COUNT(*) AS c FROM zone_ns_universe_hits WHERE day = ?').get(zoneNsHits.day).c;

    await new Promise((resolve, reject) => {
      const gzip = zlib.createGzip();
      const out = fs.createWriteStream(tmpPath);
      gzip.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      gzip.pipe(out);
      const rows = zdb.prepare(`
        SELECT domain FROM temp.universe_provider
        UNION
        SELECT domain FROM zone_ns_universe_hits WHERE day = ?
        ORDER BY domain
      `).iterate(zoneNsHits.day);
      for (const row of rows) {
        gzip.write(`${row.domain}\n`);
        total += 1;
      }
      gzip.end();
    });
    fs.renameSync(tmpPath, finalPath);
    zdb.exec('DROP TABLE IF EXISTS temp.universe_provider');
  } else {
    if (zoneNsUniverse) {
      try {
        const zoneResult = await zoneNsUniverse();
        if (zoneResult && zoneResult.ran && zoneResult.domains) {
          for (const domain of zoneResult.domains) domains.add(domain);
          zoneCount = zoneResult.domains.size;
        } else if (zoneResult && !zoneResult.ran) {
          console.log(`[SaleWatchRecon] zone ns universe not run: ${zoneResult.reason || 'unknown'}`);
        }
      } catch (err) {
        console.warn(`[SaleWatchRecon] zone ns universe failed: ${err.message}`);
      }
    }

    const sorted = [...domains].sort();
    total = sorted.length;

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
  }

  db.prepare(`
    INSERT INTO sale_watch_universe_days (day, domain_count, file_path, created_at)
    VALUES (@day, @count, @filePath, datetime('now'))
    ON CONFLICT(day) DO UPDATE SET
      domain_count = excluded.domain_count,
      file_path = excluded.file_path,
      created_at = excluded.created_at
  `).run({ day, count: total, filePath: finalPath });

  if (zoneNsUniverse || zoneNsHits) {
    console.log(`[SaleWatchRecon] universe day ${day}: ${providerCount} provider-listed + ${zoneCount} zone seller/parking = ${total} total`);
    const insertSource = db.prepare(`
      INSERT INTO sale_watch_universe_sources (day, source, count, created_at)
      VALUES (@day, @source, @count, datetime('now'))
      ON CONFLICT(day, source) DO UPDATE SET
        count = excluded.count,
        created_at = excluded.created_at
    `);
    insertSource.run({ day, source: 'provider-scan', count: providerCount });
    insertSource.run({ day, source: 'zone-ns', count: zoneCount });
  }

  console.log(`[SaleWatchRecon] persisted universe day ${day}: ${total} domains`);
  return { day, count: total, providerCount, zoneCount };
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
 * DOMAINSCOUT_SALE_WATCH_UNIVERSE_KEEP_DAYS, default 14). Also drops that
 * day's zone_ns_universe_hits / zone_ns_universe_runs rows so the bounded
 * hit store keeps the same retention as the day-set files (guarded with
 * try/catch: older databases may not have those tables yet).
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
    try {
      db.prepare('DELETE FROM zone_ns_universe_hits WHERE day = ?').run(row.day);
      db.prepare('DELETE FROM zone_ns_universe_runs WHERE day = ?').run(row.day);
    } catch (err) {
      console.warn(`[SaleWatchRecon] pruneUniverseDays: failed to delete zone ns rows for ${row.day}: ${err.message}`);
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
 * Spawns server/zone-ns-universe-worker.js as a child process for `day`,
 * waits for it to exit (or kills it after a timeout, env
 * DOMAINSCOUT_ZONE_NS_UNIVERSE_TIMEOUT_MS, default 90 minutes), and returns
 * its parsed JSON summary line (or a {ran:false,...} descriptor on any
 * spawn/parse/timeout failure). Never throws — a child failure here must
 * never fail the daily universe pass. `opts.spawn` overrides
 * child_process.spawn for tests; `opts.zoneNsTimeoutMs` overrides the
 * timeout.
 */
function spawnZoneNsUniverseWorker(day, opts = {}) {
  return new Promise((resolve) => {
    const workerPath = path.join(__dirname, 'zone-ns-universe-worker.js');
    const timeoutMs = Number.isFinite(opts.zoneNsTimeoutMs) && opts.zoneNsTimeoutMs > 0
      ? opts.zoneNsTimeoutMs
      : (parseInt(process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_TIMEOUT_MS, 10) || DEFAULT_ZONE_NS_UNIVERSE_TIMEOUT_MS);

    const spawnFn = opts.spawn || child_process.spawn;
    let child;
    try {
      child = spawnFn(process.execPath, [workerPath], {
        env: { ...process.env, ZONE_NS_UNIVERSE_DAY: day, DOMAINSCOUT_SKIP_DB_MAINTENANCE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ran: false, reason: 'spawn-failed', error: err.message });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      console.warn(`[SaleWatchRecon] zone ns universe worker timed out after ${timeoutMs}ms for ${day}, killing`);
      try { child.kill('SIGKILL'); } catch (_) { /* best effort */ }
      finish({ ran: false, reason: 'timeout' });
    }, timeoutMs);

    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      finish({ ran: false, reason: 'error', error: err.message });
    });

    child.on('exit', (code) => {
      if (stderr.trim()) console.warn(`[SaleWatchRecon] zone ns universe worker stderr: ${stderr.trim()}`);
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      let summary = null;
      if (lastLine) {
        try { summary = JSON.parse(lastLine); } catch (_) { summary = null; }
      }
      if (summary) {
        console.log(`[SaleWatchRecon] zone ns universe worker summary: ${JSON.stringify(summary)}`);
        finish(summary);
      } else {
        console.warn(`[SaleWatchRecon] zone ns universe worker exited (code ${code}) with no parseable summary`);
        finish({ ran: false, reason: 'no-summary', exitCode: code });
      }
    });
  });
}

/**
 * Orchestrator: determine today (UTC), skip if today's universe row already
 * exists, persist, diff against the most recent prior day, enqueue exits,
 * prune, and return a structured summary. Never throws. Reuses the
 * server/nrd-importer.js disk-pressure guard (fail-open when unreadable).
 *
 * Stage 3: only when DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED is exactly '1'
 * (opt-in; any other value including unset is off — the old default-on
 * in-memory path crash-looped production), the bounded zone NS universe
 * worker (server/zone-ns-universe-worker.js) is spawned as a child process
 * and, when it reports ran:true, its SQLite-backed hits
 * (zone_ns_universe_hits) are unioned into the persisted day set via
 * persistUniverseDay's zoneNsHits option. A child failure/timeout never
 * fails the pass — it falls back to provider-only. opts.zoneNsUniverse /
 * opts.buildZoneUniverseDay test hooks keep working and never spawn a
 * child. The exit differ and probe waves below are untouched: an exit from
 * the union is a candidate exactly as before.
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

    let zoneNsUniverse = null;
    let zoneNsHits = null;
    const zoneNsEnabledEnv = process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED === '1';
    if (opts.zoneNsUniverse) {
      zoneNsUniverse = opts.zoneNsUniverse;
    } else if (opts.buildZoneUniverseDay) {
      const buildZoneUniverseDay = opts.buildZoneUniverseDay;
      zoneNsUniverse = zoneNsEnabledEnv ? () => buildZoneUniverseDay() : null;
    } else if (zoneNsEnabledEnv) {
      const childResult = await spawnZoneNsUniverseWorker(day, opts);
      if (childResult && childResult.ran) {
        zoneNsHits = { database: db, day };
      } else {
        console.log(`[SaleWatchRecon] zone ns universe not run: ${(childResult && childResult.reason) || 'unknown'}`);
      }
    }

    const persisted = await persistUniverseDay(db, {
      day,
      enumerate: enumerateFn,
      dir,
      zoneNsUniverse,
      zoneNsHits,
    });

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
  const nowDay = new Date(now || Date.now()).toISOString();
  const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_PROBE_WAVE_SIZE;
  return db.prepare(`
    SELECT * FROM sale_watch_candidates
    WHERE state IN ('exited', 'probing', 'parked-watch', 'detected', 'transferring')
      AND next_probe_at IS NOT NULL
      AND next_probe_at <= ?
    ORDER BY CASE WHEN state='transferring' THEN 0 WHEN json_extract(evidence_json,'$.discovery.movement.destinationProbe.state')='built' THEN 1 WHEN json_extract(evidence_json,'$.discovery.movement.currentClass')='hosting' THEN 2 WHEN last_stream='zone-seller-departure' THEN 3 ELSE 4 END, next_probe_at ASC
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

  let previous=null;try{previous=JSON.parse(row.evidence_json||'null');}catch{}
  if(previous?.discovery?.rdap?.error || !previous?.discovery?.rdap?.registrar){
    const prior=db.prepare("SELECT observed_at,evidence_json FROM sale_watch_observations WHERE domain=? AND kind='probe' ORDER BY observed_at DESC LIMIT 40").all(row.domain).map(o=>({...o,evidence:JSON.parse(o.evidence_json)})).find(o=>o.evidence.rdap?.registrar && !o.evidence.rdap.error);
    if(prior)previous={...previous,lastObservedAt:prior.observed_at,discovery:{...previous.discovery,rdap:prior.evidence.rdap}};
  }
  const candidate = {
    domain: row.domain,
    sellerNameservers: previous?.sellerNameservers || [],
    providers: [previous?.venue || (row.last_stream === 'godaddy-closeout' ? 'GoDaddy Closeouts' : row.last_stream === 'godaddy-auction' ? 'GoDaddy Auctions' : 'Observed seller')],
    departureDate: row.exit_observed_day,
    detectionDate: row.exit_observed_day,
    sourceKind: previous?.discovery?.movement ? 'zone-movement' : previous?.sellerNameservers?.length ? 'retained-recheck' : 'stream-exit',
  };

  let result = await inspectFn(candidate, { previous: previous ? {...previous,lastObservedAt:previous.lastObservedAt||row.updated_at} : null });
  result.domain=row.domain;
  result.lastObservedAt=new Date(now||Date.now()).toISOString();
  if(previous?.discovery?.movement){result.discovery={...result.discovery,movement:previous.discovery.movement};result.sourceUrl=previous.discovery.movement.sourceUrl;}
  if(result.assessment)result=require('./sale-watch-evidence').assessSaleEntry(result,{now:new Date(now||Date.now()),previous});

  // Stream-exit limbo guard (from live specimen testing 2026-09-01): a name
  // that leaves the GoDaddy streams but still resolves only to GoDaddy's
  // default DNS (*.domaincontrol.com) is in expiry/redemption limbo — that is
  // not buyer infrastructure, however the homepage reads. Treat any would-be
  // detection there as parked-watch so the ladder re-probes it instead.
  const limboNs = (result.buyerNameservers || []).length > 0
    && (result.buyerNameservers || []).every(ns => String(ns).toLowerCase().endsWith('.domaincontrol.com'));
  if (candidate.sourceKind === 'stream-exit' && limboNs && (result.tier === 'probable' || result.tier === 'suspected')) {
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

  if (['probable','suspected','transfer'].includes(result.tier)) {
    state = result.tier === 'transfer' ? 'transferring' : result.tier === 'probable' ? 'detected' : 'probing';
    outcome = result.tier === 'probable' ? 'likely-sale' : result.tier === 'transfer' ? 'registrar-transfer' : 'unconfirmed-move';
    outcomeTier = result.tier;
    const operating = result.classification==='acquisition-candidate' || result.tier==='probable';
    const followupHours = result.discovery?.rdap?.error ? 1 : result.tier==='transfer' ? 6 : operating ? (nextProbeCount<=7?24:72) : [24,72,168,336,720][Math.min(nextProbeCount-1,4)];
    nextProbeAt = new Date(Math.max(new Date(now||Date.now()).getTime() + followupHours*3600000, Date.parse(result.discovery?.rdap?.retryAt)||0)).toISOString();
  } else if (['ruled-out','excluded'].includes(result.tier) && (result.discovery?.parkingInfrastructure || result.tier==='excluded')) {
    const scheduled = ladderNextProbeAt(probeCountBeforeThisProbe, nowDay);
    if (scheduled) {
      state = 'parked-watch';
      nextProbeAt = scheduled;
    } else {
      state = 'parked-watch';
      outcome = 'sale-or-parking-destination';
      nextProbeAt = new Date(new Date(now||Date.now()).getTime()+30*86400000).toISOString();
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

  recordObservation(db,row.domain,result.lastObservedAt,'probe',{nameservers:result.buyerNameservers||[],registrar:result.discovery?.rdap?.registrar||null,registrarId:result.discovery?.rdap?.registrarId||null,rdap:result.discovery?.rdap||null,homepage:result.discovery?.homepage||null,tier:result.tier,classification:result.classification||null});
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
    const { mapLimit } = require('./sale-watch-discovery');

    if(!opts.skipMovementImport){await ingestMovementCandidates(db,{directory:opts.movementDirectory});ingestDiscoveryCandidates(db,{file:opts.discoveryPath});}
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
function readReconstructionEntries(db, { limit, q = '' } = {}) {
  const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(1000,Math.floor(limit)) : 1000;
  const rows = db.prepare(`
    SELECT * FROM sale_watch_candidates
    WHERE evidence_json IS NOT NULL AND (probe_count>0 OR state IN ('detected','transferring') OR last_stream='historical-departure') AND state IN ('detected','transferring','probing','parked-watch','exited')
      AND (?='' OR instr(domain,?)>0 OR instr(lower(evidence_json),?)>0)
    ORDER BY CASE WHEN state='transferring' THEN 0 WHEN outcome_tier='probable' THEN 1 WHEN json_extract(evidence_json,'$.classification')='acquisition-candidate' THEN 2 ELSE 3 END, updated_at DESC
    LIMIT ?
  `).all(String(q).toLowerCase().slice(0,100),String(q).toLowerCase().slice(0,100),String(q).toLowerCase().slice(0,100),cappedLimit);

  return rows.map((row) => {
    let evidence = {};
    try {
      evidence = row.evidence_json ? JSON.parse(row.evidence_json) : {};
    } catch (_) {
      evidence = {};
    }
    return {
      domain: row.domain,
      reconstruction: { state:row.state,nextProbeAt:row.next_probe_at,observations:db.prepare('SELECT observed_at,kind,evidence_json FROM sale_watch_observations WHERE domain=? ORDER BY observed_at DESC LIMIT 8').all(row.domain).reverse().map(o=>({at:o.observed_at,kind:o.kind,...JSON.parse(o.evidence_json)})) },
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
      lastObservedAt: evidence.lastObservedAt || row.updated_at || null,
      observationCount: Number.isFinite(Number(row.probe_count)) ? Number(row.probe_count) : null,
      observationStatus: 'reconstruction',
      discovery: evidence.discovery || null,
    };
  });
}

module.exports = {
  ensureReconstructionSchema,
  ingestMovementCandidates,
  ingestDiscoveryCandidates,
  recordObservation,
  reconstructionCoverage,
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
