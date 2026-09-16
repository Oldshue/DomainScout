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
const { SUFFIX_WEIGHTS, signalWeight, SIGNAL_POLICY_NOTE } = require('./domain-signal-policy');
const { delegationEvidence } = require('./sale-watch-dns');
// Apply the owner policy before SQL limits; retained observations remain untouched.
const ELIGIBLE_SIGNAL_SQL = Object.entries(SUFFIX_WEIGHTS).filter(([, weight]) => weight === 0)
  .map(([suffix]) => `lower(domain) NOT LIKE '%.${suffix.replace(/'/g, "''")}'`).join(' AND ') || '1';
const eligibleSignal = domain => signalWeight(String(domain || '').replace(/\.$/, '').split('.').at(-1)) > 0;
const DEPARTURE_ORDER_SQL = "COALESCE(NULLIF(json_extract(evidence_json,'$.reportDate'),''),exit_observed_day,'') DESC, domain ASC";
// A necessary (not sufficient) evidence gate. The full adjudicator still decides.
// SQLite maintains this small partial index whenever probe evidence changes.
const STRONG_EVIDENCE_SQL = `(json_extract(evidence_json,'$.discovery.buyerUse')=1
  OR json_extract(evidence_json,'$.discovery.rdap.pendingTransfer')=1
  OR json_extract(evidence_json,'$.discovery.rdap.transferAt') IS NOT NULL
  OR json_extract(evidence_json,'$.discovery.transferEvidence.registrarChanged')=1
  OR lower(json_extract(evidence_json,'$.discovery.rdap.statuses')) LIKE '%pending%'
  OR lower(json_extract(evidence_json,'$.discovery.rdap.events')) LIKE '%transfer%')`;


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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sale_watch_departure ON sale_watch_candidates (${DEPARTURE_ORDER_SQL}) WHERE evidence_json IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sale_watch_strong_departure ON sale_watch_candidates (${DEPARTURE_ORDER_SQL}) WHERE evidence_json IS NOT NULL AND ${STRONG_EVIDENCE_SQL};`);
  const candidateColumns = db.prepare('PRAGMA table_info(sale_watch_candidates)').all();
  if (!candidateColumns.some((col) => col.name === 'probe_priority')) {
    db.exec('ALTER TABLE sale_watch_candidates ADD COLUMN probe_priority INTEGER');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_sale_watch_priority ON sale_watch_candidates (probe_priority, next_probe_at)');
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
  let followUps = 0;
  const LIVE_MOVEMENT_STATES = new Set(['exited','probing','parked-watch','detected','transferring']);
  for (const day of days) {
    const tape = path.join(directory,day,'ns','movement.jsonl');
    const summaryPath = path.join(directory,day,'ns','summary.json');
    if (!fs.existsSync(tape) || !fs.existsSync(summaryPath)) continue;
    const stat=fs.statSync(tape), signature=`${stat.size}:${stat.mtimeMs}`;
    if(db.prepare('SELECT source_signature FROM sale_watch_movement_imports WHERE day=?').get(day)?.source_signature===signature)continue;
    const summary=JSON.parse(fs.readFileSync(summaryPath,'utf8'));
    let departures=0, dayQueued=0, excludedByPolicy=0, dayFollowUps=0;
    const cohorts=new Map();
    const allCohorts=new Map();
    const followUpCohorts=new Map();
    const lines=readline.createInterface({input:fs.createReadStream(tape),crlfDelay:Infinity});
    const upsert=db.prepare(`INSERT INTO sale_watch_candidates(domain,first_seen_day,last_seen_day,last_stream,exit_observed_day,state,next_probe_at,probe_count,probe_priority,evidence_json,updated_at)
      VALUES(@domain,@before,@day,'zone-seller-departure',@day,'exited',@day,0,@probePriority,@evidence,@observed)
      ON CONFLICT(domain) DO UPDATE SET last_seen_day=excluded.last_seen_day,
      last_stream=CASE WHEN excluded.exit_observed_day>COALESCE(sale_watch_candidates.exit_observed_day,'') THEN excluded.last_stream ELSE sale_watch_candidates.last_stream END,
      evidence_json=CASE WHEN sale_watch_candidates.evidence_json IS NULL OR excluded.exit_observed_day>COALESCE(sale_watch_candidates.exit_observed_day,'') THEN excluded.evidence_json ELSE sale_watch_candidates.evidence_json END,
      probe_priority=CASE WHEN sale_watch_candidates.evidence_json IS NULL OR excluded.exit_observed_day>COALESCE(sale_watch_candidates.exit_observed_day,'') THEN excluded.probe_priority ELSE sale_watch_candidates.probe_priority END,
      next_probe_at=CASE WHEN sale_watch_candidates.next_probe_at IS NULL OR excluded.exit_observed_day>COALESCE(sale_watch_candidates.exit_observed_day,'') THEN excluded.next_probe_at ELSE sale_watch_candidates.next_probe_at END,
      state=CASE WHEN excluded.exit_observed_day>COALESCE(sale_watch_candidates.exit_observed_day,'') THEN 'exited' ELSE sale_watch_candidates.state END,
      updated_at=CASE WHEN excluded.exit_observed_day>COALESCE(sale_watch_candidates.exit_observed_day,'') THEN excluded.updated_at ELSE sale_watch_candidates.updated_at END,
      outcome=CASE WHEN excluded.exit_observed_day>COALESCE(sale_watch_candidates.exit_observed_day,'') THEN NULL ELSE sale_watch_candidates.outcome END,
      outcome_tier=CASE WHEN excluded.exit_observed_day>COALESCE(sale_watch_candidates.exit_observed_day,'') THEN NULL ELSE sale_watch_candidates.outcome_tier END,
      exit_observed_day=MAX(COALESCE(sale_watch_candidates.exit_observed_day,''),excluded.exit_observed_day)`);
    const followSelect=db.prepare('SELECT state, evidence_json FROM sale_watch_candidates WHERE domain=?');
    const followUpdate=db.prepare(`UPDATE sale_watch_candidates SET
      evidence_json=json_set(evidence_json,'$.buyerNameservers',json(@todayNs),'$.discovery.movement',json(@movement),'$.discovery.followUpMovement',json('true')),
      next_probe_at=@day,
      state=@state
      WHERE domain=@domain`);
    const save=db.transaction(batch=>{for(const item of batch){
      const row=item.row;
      const todayKey=(row.today_ns||[]).slice().sort().join(',');
      allCohorts.set(todayKey,(allCohorts.get(todayKey)||0)+1);
      if(item.type==='departure'){
        departures++;
        if(!eligibleSignal(row.domain)){excludedByPolicy++;continue;}
        const movement={day,prevDay:summary.prevDay||dateMinusDays(day,1),previousNameservers:row.prev_ns||[],currentNameservers:row.today_ns||[],previousProvider:row.prev_provider||null,currentProvider:row.today_provider||null,previousClass:row.prev_class,currentClass:row.today_class,destinationProbe:row.probe||null,source:'daily-zone-delegation-diff',sourceUrl:`/api/universe/ns-movement?day=${day}&q=${encodeURIComponent(row.domain)}`};
        const cohortKey=(movement.currentNameservers||[]).slice().sort().join(',');
        if(!cohorts.has(cohortKey))cohorts.set(cohortKey,[]);cohorts.get(cohortKey).push(row.domain);
        const initial={domain:row.domain,tier:'suspected',sellerNameservers:movement.previousNameservers,buyerNameservers:movement.currentNameservers,reportDate:day,venue:movement.previousProvider,discovery:{movement,structurallyMoved:true,departureDate:day}};
        upsert.run({domain:row.domain,before:movement.prevDay,day,evidence:JSON.stringify(initial),observed:new Date().toISOString(),probePriority:movementProbePriority(initial,'exited')});
        recordObservation(db,row.domain,day+'T00:00:00Z','movement',movement);dayQueued++;
      } else {
        const existing=followSelect.get(row.domain);
        if(!existing||!LIVE_MOVEMENT_STATES.has(existing.state))continue;
        const movement={day,prevDay:summary.prevDay||dateMinusDays(day,1),previousNameservers:row.prev_ns||[],currentNameservers:row.today_ns||[],previousProvider:row.prev_provider||null,currentProvider:row.today_provider||null,previousClass:row.prev_class,currentClass:row.today_class,destinationProbe:row.probe||null,source:'daily-zone-delegation-diff',sourceUrl:`/api/universe/ns-movement?day=${day}&q=${encodeURIComponent(row.domain)}`,hop:'follow-up',selection:row.selection};
        const newState=(existing.state==='parked-watch'||existing.state==='probing')?'exited':existing.state;
        followUpdate.run({todayNs:JSON.stringify(row.today_ns||[]),movement:JSON.stringify(movement),day,state:newState,domain:row.domain});
        recordObservation(db,row.domain,day+'T00:00:00Z','movement',movement);
        if(!followUpCohorts.has(todayKey))followUpCohorts.set(todayKey,[]);followUpCohorts.get(todayKey).push(row.domain);
        dayFollowUps++;
      }
    }});
    let batch=[];
    for await(const line of lines){
      if(!line.trim())continue;
      const row=JSON.parse(line);
      if(!row.domain)continue;
      const isDeparture=row.selection==='departures'&&['seller','parking'].includes(row.prev_class)&&Array.isArray(row.prev_ns);
      batch.push({type:isDeparture?'departure':'followUp',row});
      if(batch.length>=250){save(batch);batch=[];}
    }
    if(batch.length)save(batch);
    const cohortUpdate=db.prepare("UPDATE sale_watch_candidates SET evidence_json=json_set(evidence_json,'$.discovery.movement.cohortSize',?) WHERE domain=? AND exit_observed_day=?");
    db.transaction(()=>{for(const domains of cohorts.values())for(const domain of domains)cohortUpdate.run(domains.length,domain,day);})();
    const followCohortUpdate=db.prepare("UPDATE sale_watch_candidates SET evidence_json=json_set(evidence_json,'$.discovery.movement.cohortSize',?) WHERE domain=?");
    db.transaction(()=>{for(const [key,domains] of followUpCohorts.entries()){const size=allCohorts.get(key)||domains.length;for(const domain of domains)followCohortUpdate.run(size,domain);}})();
    db.prepare('INSERT OR REPLACE INTO sale_watch_movement_imports VALUES(?,?,?,?,?,?)').run(day,signature,new Date().toISOString(),departures,dayQueued,JSON.stringify({day,prevDay:summary.prevDay,zones:summary.zones,departures:summary.departures,totals:summary.totals,excludedByPolicy,followUps:dayFollowUps,signalPolicy:SIGNAL_POLICY_NOTE}));queued+=dayQueued;followUps+=dayFollowUps;
  }
  return {available:true,queued,followUps};
}

function ingestDiscoveryCandidates(db, { file = process.env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_PATH || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname,'../data'),'sale-watch-discovery.json') } = {}) {
  if(!fs.existsSync(file))return {queued:0};
  const ledger=JSON.parse(fs.readFileSync(file,'utf8'));
  const insert=db.prepare(`INSERT OR IGNORE INTO sale_watch_candidates(domain,first_seen_day,last_seen_day,last_stream,exit_observed_day,state,next_probe_at,probe_count,probe_priority,evidence_json,updated_at) VALUES(?,?,?,'historical-departure',?, ?, ?,0,4,?,?)`);
  let queued=0;
  db.transaction(()=>{for(const entry of [...(ledger.entries||[]),...(ledger.retiredEntries||[])]){
    if(!entry.discovery||!entry.domain||!entry.sellerNameservers?.length||!eligibleSignal(entry.domain))continue;
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
    following:db.prepare(`SELECT COUNT(*) AS count FROM sale_watch_candidates WHERE ${ELIGIBLE_SIGNAL_SQL} AND next_probe_at IS NOT NULL AND state IN('exited','probing','parked-watch','detected','transferring')`).get().count,
    due:db.prepare(`SELECT COUNT(*) AS count FROM sale_watch_candidates WHERE ${ELIGIBLE_SIGNAL_SQL} AND next_probe_at<=? AND state IN('exited','probing','parked-watch','detected','transferring')`).get(new Date().toISOString()).count};
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
function pruneUniverseDays(db, { dir, keepDays, today = todayUtc() } = {}) {
  const keep = Number.isFinite(keepDays) && keepDays > 0
    ? keepDays
    : (parseInt(process.env.DOMAINSCOUT_SALE_WATCH_UNIVERSE_KEEP_DAYS, 10) || DEFAULT_UNIVERSE_KEEP_DAYS);
  const cutoff = dateMinusDays(today, keep);
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

    const pruneResult = pruneUniverseDays(db, { dir, keepDays: opts.keepDays, today: day });

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
 * Pure priority classifier used directly (tests) and as the body of the
 * sale_watch_probe_priority SQL function registered below. `evidence` is
 * the parsed evidence_json object (or null) — never a JSON string. Lower
 * numbers probe sooner. First match wins, in this evaluation order:
 * transferring(0) > expiration/suspended/parking(5, was 4 — now sorts
 * last/worst) > operating-destination-already-seen or fresh small-cohort
 * seller/parking->hosting move(1) > fresh small-cohort ->other or
 * mid-cohort ->hosting or legacy sellerOrigin rows(2) > large-cohort bulk
 * movement(4) > everything else including unparsable evidence(3).
 */
function movementProbePriority(evidence, state) {
  if (state === 'transferring') return 0;
  const cls = evidence?.classification || evidence?.assessment?.classification;
  if (cls === 'expiration' || cls === 'registry-hold') return 5;
  if (!evidence || typeof evidence !== 'object') return 3;
  const d = delegationEvidence(evidence);
  if (d.expiration || d.suspended || d.parking) return 5;
  if (evidence.discovery?.buyerUse && !evidence.discovery?.homepage?.error) return 1;
  const movement = evidence.discovery?.movement;
  if (movement) {
    const cohort = Number(movement.cohortSize || 0);
    const currentClass = movement.currentClass;
    if (cohort < 10 && currentClass === 'hosting') return 1;
    if (cohort < 10 && currentClass === 'other') return 2;
    if (cohort >= 10 && cohort < 100 && currentClass === 'hosting') return 2;
    if (cohort >= 100) return 4;
  } else if (d.sellerOrigin && d.destinationObserved) {
    return 4;
  }
  return 3;
}

/**
 * Selects candidates due for probing: state IN ('exited','probing',
 * 'parked-watch') AND next_probe_at <= now, ordered by movementProbePriority
 * (newest exit_observed_day first within priorities 0-2, oldest-first for
 * 3-5), LIMIT limit.
 */
/**
 * Backfills rows written before probe_priority existed (bounded per call,
 * default 20000) on the caller's `db` handle. Must be called with a
 * writable connection — selectDueCandidates below never calls this itself
 * because it may run on a readonly worker connection in production; an
 * UPDATE attempted there caused "attempt to write a readonly database" and
 * silently failed every probe wave.
 */
function backfillProbePriority(db, { limit = 20000 } = {}) {
  const staleRows = db.prepare('SELECT domain, state, evidence_json FROM sale_watch_candidates WHERE probe_priority IS NULL LIMIT ?').all(limit);
  if (!staleRows.length) return { backfilled: 0 };
  const setPriority = db.prepare('UPDATE sale_watch_candidates SET probe_priority = ? WHERE domain = ?');
  const backfill = db.transaction((rows) => {
    for (const row of rows) {
      let evidence = null;
      try { evidence = JSON.parse(row.evidence_json || 'null'); } catch { evidence = null; }
      let priority = 3;
      try { priority = movementProbePriority(evidence, row.state); } catch { priority = 3; }
      setPriority.run(priority, row.domain);
    }
  });
  backfill(staleRows);
  return { backfilled: staleRows.length };
}

function selectDueCandidates(db, { now, limit } = {}) {
  const nowDay = new Date(now || Date.now()).toISOString();
  const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_PROBE_WAVE_SIZE;
  db.function('sale_watch_probe_priority', (json, state) => {
    let evidence = null;
    try { evidence = JSON.parse(json || 'null'); } catch { evidence = null; }
    try { return movementProbePriority(evidence, state); } catch { return 3; }
  });
  // No write here — this must be safe on a readonly connection. Rows not
  // yet backfilled still rank correctly via the COALESCE fallback to the JS
  // priority function below; backfillProbePriority (called separately on a
  // writable handle, e.g. by runProbeWave) is what stops it being
  // re-evaluated on every subsequent wave.
  const eligible = `state IN ('exited','probing','parked-watch','detected','transferring') AND ${ELIGIBLE_SIGNAL_SQL} AND next_probe_at IS NOT NULL AND next_probe_at <= ?`;
  const priorityExpr = `COALESCE(probe_priority, sale_watch_probe_priority(evidence_json,state))`;
  // Reserve 10% for the oldest due records: a low priority never ends follow-up.
  const priorityLimit = Math.max(1, Math.ceil(cappedLimit * 0.9));
  const prioritized = db.prepare(`SELECT * FROM sale_watch_candidates WHERE ${eligible}
    ORDER BY ${priorityExpr}, CASE WHEN ${priorityExpr} <= 2 THEN exit_observed_day ELSE '' END DESC, next_probe_at, domain LIMIT ?`).all(nowDay,priorityLimit);
  if (prioritized.length >= cappedLimit) return prioritized;
  const remainder = db.prepare(`SELECT * FROM sale_watch_candidates WHERE ${eligible}
    AND domain NOT IN (SELECT value FROM json_each(?)) ORDER BY next_probe_at,domain LIMIT ?`)
    .all(nowDay,JSON.stringify(prioritized.map(row=>row.domain)),cappedLimit-prioritized.length);
  return [...prioritized,...remainder];
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
  } else if (result.classification === 'expiration' || result.classification === 'registry-hold') {
    // Expirations and registry holds are not sales: one long recheck, not the
    // ladder — a later re-registration is a new owner, not this candidate selling.
    state = 'parked-watch';
    outcome = result.classification;
    outcomeTier = null;
    nextProbeAt = new Date(new Date(now||Date.now()).getTime() + 45*86400000).toISOString();
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
        probe_priority = @probePriority,
        updated_at = datetime('now')
    WHERE domain = @domain
  `).run({
    state,
    outcome,
    outcomeTier,
    evidenceJson,
    nextProbeAt,
    probeCount: nextProbeCount,
    probePriority: movementProbePriority(result, state),
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

    // RDAP sweep runs every wave, immediately after movement/discovery import and
    // before selectDueCandidates, so any row the sweep promotes (near-departure
    // transfer / pendingTransfer) is probed in this same wave rather than the next.
    let rdapSweepResult = null;
    if (!opts.skipRdapSweep) {
      try {
        const sweep = opts.rdapSweep || require('./sale-watch-rdap-sweep').rdapSweep;
        rdapSweepResult = await sweep(db, {
          limit: parseInt(process.env.DOMAINSCOUT_SALE_WATCH_RDAP_SWEEP, 10) || 20000,
          now: opts.now,
          inspectRdap: opts.inspectRdap,
        });
      } catch (err) {
        console.warn(`[SaleWatchRecon] rdap sweep failed: ${err.message}`);
      }
    }

    let transferScreenResult = null;
    if (!opts.skipTransferScreen) {
      try {
        const screen = opts.screenWentLiveTransfers || require('./sale-watch-transfer-screen').screenWentLiveTransfers;
        const latestImport = db.prepare('SELECT day FROM sale_watch_movement_imports ORDER BY day DESC LIMIT 1').get();
        if (latestImport && latestImport.day) {
          transferScreenResult = await screen(db, {
            directory: opts.movementDirectory || process.env.DOMAINSCOUT_UNIVERSE_DIR,
            day: latestImport.day,
            limit: parseInt(process.env.DOMAINSCOUT_SALE_WATCH_TRANSFER_SCREEN_LIMIT, 10) || 4000,
            now: opts.now,
            inspectRdap: opts.inspectRdap,
          });
        }
      } catch (err) {
        console.warn(`[SaleWatchRecon] transfer screen failed: ${err.message}`);
      }
    }

    if (opts.reassess) {
      try {
        const reassessResult = (opts.reassessStoredEvidence || reassessStoredEvidence)(db, { sinceDays: 30, now: opts.now });
        console.log(`[SaleWatchRecon] reassess: ${JSON.stringify(reassessResult)}`);
      } catch (err) {
        console.warn(`[SaleWatchRecon] reassess failed: ${err.message}`);
      }
    }

    let backfilled = 0;
    try {
      backfilled = backfillProbePriority(db).backfilled;
    } catch (err) {
      console.warn(`[SaleWatchRecon] priority backfill failed: ${err.message}`);
    }

    const due = await (opts.selectDueCandidates || selectDueCandidates)(db, { now: opts.now, limit: waveSize });

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
    summary.backfilled = backfilled;
    summary.rdapSweep = rdapSweepResult;

    let kits = null;
    try {
      kits = markAdoptionKits(db, { now: opts.now });
    } catch (err) {
      console.warn(`[SaleWatchRecon] markAdoptionKits failed: ${err.message}`);
    }
    summary.kits = kits;
    summary.transferScreen = transferScreenResult;

    console.log(`[SaleWatchRecon] wave: ${summary.probed} probed, ${summary.detected} detected, ${summary.parkedWatch} parked-watch, ${summary.dropped} dropped, ${summary.rescheduled} rescheduled, ${summary.kits?.members ?? 0} kit members, ${summary.transferScreen?.admitted ?? 0} transfer-screen admits, ${summary.rdapSweep?.checked ?? 0} rdap-swept (${summary.rdapSweep?.transfers ?? 0} transfers)`);
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
function readReconstructionEntries(db, { limit, q = '', offset = 0, view = 'all', after = null } = {}) {
  const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(1000,Math.floor(limit)) : 1000;
  // The same adjudicator filters before LIMIT, so noise cannot consume a page.
  // No observations are rewritten when the evidence rules change.
  const { assessSaleEntry, matchesSaleView } = require('./sale-watch-evidence');
  const assessedAt = new Date();
  db.function('sale_watch_matches_view', (json, updatedAt) => {
    try {
      const evidence = JSON.parse(json);
      return Number(matchesSaleView(assessSaleEntry({ ...evidence, lastObservedAt: evidence.lastObservedAt || updatedAt }, { now: assessedAt }), view));
    } catch { return 0; }
  });
  const strongView = ['focus','probable','transfer'].includes(view);
  const rows = db.prepare(`
    SELECT * FROM sale_watch_candidates INDEXED BY ${strongView ? 'idx_sale_watch_strong_departure' : 'idx_sale_watch_departure'}
    WHERE evidence_json IS NOT NULL AND (probe_count>0 OR state IN ('detected','transferring') OR last_stream IN ('historical-departure','zone-seller-departure')) AND state IN ('detected','transferring','probing','parked-watch','exited')
      AND ${ELIGIBLE_SIGNAL_SQL}
      ${strongView ? `AND ${STRONG_EVIDENCE_SQL}` : ''}
      AND (?='' OR instr(domain,?)>0 OR instr(lower(evidence_json),?)>0)
      AND (?='' OR COALESCE(NULLIF(json_extract(evidence_json,'$.reportDate'),''),exit_observed_day,'') < ? OR (COALESCE(NULLIF(json_extract(evidence_json,'$.reportDate'),''),exit_observed_day,'') = ? AND domain > ?))
      AND (?='all' OR sale_watch_matches_view(evidence_json,updated_at)=1)
    ORDER BY COALESCE(NULLIF(json_extract(evidence_json,'$.reportDate'),''),exit_observed_day,'') DESC, domain ASC
    LIMIT ? OFFSET ?
  `).all(String(q).toLowerCase().slice(0,100),String(q).toLowerCase().slice(0,100),String(q).toLowerCase().slice(0,100),after ? 'cursor' : '',after?.date || '',after?.date || '',after?.domain || '',view,cappedLimit,Math.max(0,Math.floor(Number(offset)||0)));

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

const KIT_KEY_ENTITY_MAP = {
  '&ndash;': '–',
  '&mdash;': '—',
  '&amp;': '&',
  '&nbsp;': ' ',
  '&#8211;': '–',
  '&#8212;': '—',
  '&#39;': "'",
  '&quot;': '"',
};
const KIT_KEY_ENTITY_PATTERN = /&(?:ndash|mdash|amp|nbsp|#8211|#8212|#39|quot);/g;
const KIT_KEY_EDGE_SEPARATORS = /^[-–—|:·•~/\\,.\s]+|[-–—|:·•~/\\,.\s]+$/g;
const KIT_KEY_ONLY_PUNCTUATION = /^[^a-z0-9]*$/;
const KIT_KEY_GENERIC_RESIDUES = new Set([
  'home', 'homepage', 'welcome', 'index', 'official site', 'official website',
  'coming soon', 'under construction', 'untitled', 'new site', 'my site', 'site',
]);

/**
 * Derives the adoption-kit grouping key for one candidate: the buyer-facing
 * title (evidence.buyerTitle, falling back to evidence.discovery.homepage
 * .title), lowercased, with every occurrence of the row's own domain and of
 * its label (part before the first dot, only when 4+ characters) removed, a
 * leading "www." stripped, common HTML entities decoded, leading/trailing
 * separator runs stripped, whitespace collapsed, and trimmed. Returns null
 * when there is no title, the residual key is under 6 characters, is only
 * punctuation, or is one of a fixed set of generic page residues (home,
 * welcome, coming soon, ...) that would otherwise wrongly group unrelated
 * genuine buyers as a portfolio kit.
 */
function deriveKitKey(domain, evidence) {
  const title = evidence?.buyerTitle || evidence?.discovery?.homepage?.title;
  if (!title) return null;
  const domainLower = String(domain || '').toLowerCase();
  const label = domainLower.split('.')[0] || '';
  let key = String(title).toLowerCase();
  if (domainLower) key = key.split(domainLower).join(' ');
  if (label.length >= 4) key = key.split(label).join(' ');
  key = key.replace(KIT_KEY_ENTITY_PATTERN, (match) => KIT_KEY_ENTITY_MAP[match] || match);
  key = key.replace(/^www\./, '');
  key = key.replace(KIT_KEY_EDGE_SEPARATORS, '');
  key = key.replace(/\s+/g, ' ').trim();
  if (key.length < 6) return null;
  if (KIT_KEY_ONLY_PUNCTUATION.test(key)) return null;
  if (KIT_KEY_GENERIC_RESIDUES.has(key)) return null;
  return key;
}

/**
 * Marks adoption kits: after every probe wave, tags candidates whose
 * buyer-facing title matches 3+ other distinct domains (a portfolio /
 * storefront title template) so the adjudicator (server/sale-watch-evidence
 * .js, sale-evidence-v8) treats evidence.discovery.kit as portfolio
 * counter-evidence. Population: acquisition-candidate/likely-sale rows
 * whose exit_observed_day falls within the last 30 days (relative to
 * `now`). Never touches outcome/state/next_probe_at — the adjudicator
 * re-reads evidence at page time.
 */
function markAdoptionKits(db, { now } = {}) {
  const nowIso = new Date(now || Date.now()).toISOString();
  const today = isoDay(now || new Date()) || todayUtc();
  const cutoff = dateMinusDays(today, 30);
  const rows = db.prepare(`
    SELECT domain, evidence_json FROM sale_watch_candidates
    WHERE evidence_json IS NOT NULL
      AND json_extract(evidence_json,'$.classification') IN ('acquisition-candidate','likely-sale')
      AND exit_observed_day >= ?
  `).all(cutoff);

  const parsed = [];
  const groups = new Map();
  for (const row of rows) {
    let evidence = null;
    try { evidence = JSON.parse(row.evidence_json); } catch { evidence = null; }
    const key = evidence ? deriveKitKey(row.domain, evidence) : null;
    parsed.push({ domain: row.domain, evidence, key });
    if (key) {
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(row.domain);
    }
  }

  const kitKeys = new Set([...groups.entries()].filter(([, domains]) => domains.size >= 3).map(([key]) => key));

  const setKit = db.prepare(`UPDATE sale_watch_candidates SET evidence_json = json_set(evidence_json, '$.discovery.kit', json(?)) WHERE domain = ?`);
  const clearKit = db.prepare(`UPDATE sale_watch_candidates SET evidence_json = json_remove(evidence_json, '$.discovery.kit') WHERE domain = ?`);

  let members = 0;
  let cleared = 0;

  const txn = db.transaction(() => {
    for (const entry of parsed) {
      const isKit = entry.key && kitKeys.has(entry.key);
      if (isKit) {
        const size = groups.get(entry.key).size;
        setKit.run(JSON.stringify({ basis: 'title', key: entry.key, size, markedAt: nowIso }), entry.domain);
        members += 1;
      } else if (entry.evidence?.discovery?.kit?.basis === 'title') {
        clearKit.run(entry.domain);
        cleared += 1;
      }
    }
  });
  txn();

  return { scanned: rows.length, kits: kitKeys.size, members, cleared };
}

// ---------------------------------------------------------------------------
// Stage 2b: re-scoring stored evidence when the adjudicator changes
// ---------------------------------------------------------------------------

/**
 * Re-scores previously persisted evidence when the shared adjudicator
 * (server/sale-watch-evidence.js) changes. Selects rows whose evidence_json
 * carries an older (or missing) assessment.version, re-runs assessSaleEntry
 * against the SAME stored evidence (never re-probes the network), and maps
 * the fresh classification onto outcome/outcome_tier/state exactly like
 * probeCandidate does for a live probe result. next_probe_at, probe_count
 * and first/last seen days are never touched here — only the stored verdict
 * catches up to the current rules. Rows whose evidence has no `discovery`
 * object (curated/seed rows probed outside this pipeline) are skipped:
 * there is nothing here for the adjudicator to re-score.
 */
const REASSESS_LEAVE_STATE_CLASSIFICATIONS = new Set(['expiration', 'registry-hold', 'lander-migration', 'portfolio-kit']);

function reassessStoredEvidence(db, { sinceDays = 30, batch = 2000, now = new Date() } = {}) {
  const start = Date.now();
  const { VERSION, assessSaleEntry } = require('./sale-watch-evidence');
  const today = isoDay(now) || todayUtc();
  const cutoff = dateMinusDays(today, sinceDays);

  const rows = db.prepare(`
    SELECT domain, state, evidence_json, updated_at FROM sale_watch_candidates
    WHERE evidence_json IS NOT NULL
      AND exit_observed_day >= ?
      AND (json_extract(evidence_json,'$.assessment.version') IS NULL OR json_extract(evidence_json,'$.assessment.version') != ?)
  `).all(cutoff, VERSION);

  let scanned = 0;
  let rewritten = 0;
  const byClassification = {};

  const update = db.prepare(`
    UPDATE sale_watch_candidates
    SET evidence_json = @evidenceJson, outcome = @outcome, outcome_tier = @outcomeTier, state = @state, probe_priority = @probePriority
    WHERE domain = @domain
  `);

  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const txn = db.transaction((chunkRows) => {
      for (const row of chunkRows) {
        scanned += 1;
        let evidence;
        try { evidence = JSON.parse(row.evidence_json); } catch (_) { continue; }
        if (!evidence || !evidence.discovery) continue;

        const assessed = assessSaleEntry({ ...evidence, lastObservedAt: evidence.lastObservedAt || row.updated_at }, { now });
        const cls = assessed.classification;
        const tier = assessed.tier;
        let outcome;
        let outcomeTier;
        let state;
        if (REASSESS_LEAVE_STATE_CLASSIFICATIONS.has(cls)) {
          outcome = cls;
          outcomeTier = null;
          state = row.state;
        } else if (tier === 'probable') {
          outcome = 'likely-sale';
          outcomeTier = 'probable';
          state = 'detected';
        } else if (tier === 'transfer') {
          outcome = 'registrar-transfer';
          outcomeTier = 'transfer';
          state = 'transferring';
        } else if (tier === 'suspected') {
          outcome = 'unconfirmed-move';
          outcomeTier = 'suspected';
          state = (row.state === 'exited' || row.state === 'parked-watch') ? row.state : 'probing';
        } else {
          outcome = cls || null;
          outcomeTier = null;
          state = row.state;
        }

        update.run({
          evidenceJson: JSON.stringify(assessed),
          outcome,
          outcomeTier,
          state,
          probePriority: movementProbePriority(assessed, state),
          domain: row.domain,
        });
        rewritten += 1;
        byClassification[cls] = (byClassification[cls] || 0) + 1;
      }
    });
    txn(chunk);
  }

  return { scanned, rewritten, byClassification, ms: Date.now() - start };
}

/**
 * Runs reassessStoredEvidence once per adjudicator version change: keeps a
 * tiny sale_watch_meta(key,value) table, and when the stored
 * 'assessment_version' differs from the current VERSION exported by
 * ./sale-watch-evidence, re-scores the trailing 30 days of stored evidence
 * and records the new version. No-op (ran:false) once the version matches.
 */
function ensureAssessmentVersion(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sale_watch_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const { VERSION } = require('./sale-watch-evidence');
  const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get('assessment_version');
  if (row && row.value === VERSION) {
    return { ran: false, version: VERSION };
  }
  const result = reassessStoredEvidence(db, { sinceDays: 30 });
  db.prepare(`
    INSERT INTO sale_watch_meta(key,value) VALUES('assessment_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(VERSION);
  return { ran: true, version: VERSION, ...result };
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
  backfillProbePriority,
  movementProbePriority,
  probeCandidate,
  runProbeWave,
  readReconstructionEntries,
  markAdoptionKits,
  deriveKitKey,
  reassessStoredEvidence,
  ensureAssessmentVersion,
};
