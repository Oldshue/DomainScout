'use strict';

// Narrow, trigger-maintained selection keys for sale_watch_candidates.
//
// 2026-11-07 production (21 GB sale_watch.db, ~1.3 M candidates): the first
// wave after a restart was killed ("no heartbeat for 604616ms in stage
// searchIndex") while selectDueCandidates read every due row's evidence_json
// overflow pages and parsed it in JS on a cold page cache, and the
// reassessment's assess-signal phase ran json_extract over ~1.1 M window rows
// (7 rows/s). Both selections now read this table instead: one small row per
// candidate holding only the columns selection needs, with the evidence-derived
// flags (high-signal predicate, likely-sale, portfolio-kit key) precomputed
// once when the evidence is written.
//
// Safety on a live 21 GB database:
//   * ensureCandidateKeysSchema creates an EMPTY table, its indexes and the
//     triggers: constant time, safe on any thread, no table scan, no long
//     exclusive lock.
//   * The triggers keep every row written from then on current.
//   * backfillCandidateKeys fills the pre-existing rows in rowid-range chunks
//     (small IMMEDIATE transactions), recording its position in sale_watch_meta
//     after each chunk so a restart resumes where it stopped. It runs on the
//     off-main indexer worker (runBulkPass), never on the HTTP thread.
//   * Readers use the keys only once candidateKeysReady(); until then they
//     keep the previous (unindexed) queries.
//
// The high-signal predicate is defined once here (signalEvidenceClauses) and
// sale-watch-assessments.highSignalSql is built from the same fragments, so the
// predicate and evidence boundary are unchanged.

const TABLE = 'sale_watch_candidate_keys';
const META_KEY = 'candidate_keys';
// Bump when the key columns or their derivation change: the table is rebuilt.
// v3 (2026-11-07): seller_dep / rdap_at for seller-departure-first checks.
const KEY_VERSION = '3';
const DEFAULT_CHUNK = 2000;
const LIVE_STATES_SQL = "('exited','probing','parked-watch','detected','transferring')";
const BATCH_MIN_NAMES = 10; // mirrors sale-watch-candidates.BATCH_MIN_NAMES (probeKitKey)
const COLUMNS = ['domain', 'rid', 'state', 'live', 'eligible', 'next_probe_at', 'probe_count', 'probe_priority', 'exit_observed_day',
  'last_stream', 'ev_valid', 'likely_ev', 'sig_ev', 'stored_likely', 'kit_key', 'adopt_ev', 'seller_dep', 'rdap_at'];

// A departure from marketplace / seller DNS (the zone tape's prev_class
// 'seller', or an adjudicated sellerOrigin delegation), as opposed to the far
// larger parking-departure flood that shares last_stream
// 'zone-seller-departure'. 2026-11-07: ~500/day of ~70,000/day candidates.
function sellerDepartureSql(c) {
  return `(CASE WHEN json_valid(${c}.evidence_json) AND (${jx(c, '$.discovery.movement.previousClass')} = 'seller'
      OR ${jx(c, '$.assessment.delegation.sellerOrigin')} = 1) THEN 1 ELSE 0 END)`;
}

// Last RDAP check attempt of the row (sweep attempt, else the stored RDAP
// record's checkedAt; '' for a record without a timestamp), NULL when never checked.
function rdapCheckedSql(c) {
  return `(CASE WHEN json_valid(${c}.evidence_json) THEN COALESCE(${jx(c, '$.discovery.rdapCheckedAt')}, ${jx(c, '$.discovery.rdap.checkedAt')},
      CASE WHEN json_type(${c}.evidence_json, '$.discovery.rdap') IS NOT NULL THEN '' END) END)`;
}

// Same predicate markAdoptionKits used inline: top-level classification is an
// adoption verdict (acquisition-candidate / likely-sale).
function adoptEvidenceSql(c) {
  return `(CASE WHEN json_valid(${c}.evidence_json) AND ${jx(c, '$.classification')} IN ('acquisition-candidate','likely-sale') THEN 1 ELSE 0 END)`;
}

function jx(c, path) {
  return `json_extract(${c}.evidence_json, '${path}')`;
}

/** Evidence-side clauses of the high-signal predicate (caller guarantees json_valid). */
function signalEvidenceClauses(c = 'c') {
  return [
    `${jx(c, '$.classification')} = 'likely-sale'`,
    `${jx(c, '$.assessment.classification')} = 'likely-sale'`,
    `${jx(c, '$.assessment.delegation.sellerOrigin')} = 1`,
    `${jx(c, '$.discovery.buyerUse')} = 1`,
    `${jx(c, '$.discovery.rdap.pendingTransfer')} = 1`,
    `${jx(c, '$.discovery.rdap.transferAt')} IS NOT NULL`,
    `${jx(c, '$.discovery.transferEvidence.registrarChanged')} = 1`,
    `${jx(c, '$.discovery.transferEvidence.transferAt')} IS NOT NULL`,
    `lower(COALESCE(${jx(c, '$.discovery.rdap.statuses')}, '')) LIKE '%pending%'`,
  ];
}

function populationSql(c) {
  return `(${c}.domain IS NOT NULL AND ${c}.domain <> '')`;
}

function eligibleSql(c) {
  const base = require('./sale-watch-reconstruction').ELIGIBLE_SIGNAL_SQL || '1';
  return base.replace(/lower\(domain\)/g, `lower(${c}.domain)`);
}

// Same expression as selectDueCandidates' likelySaleSql.
function likelyEvidenceSql(c) {
  return `(CASE WHEN COALESCE(CASE WHEN json_valid(${c}.evidence_json) THEN COALESCE(${jx(c, '$.classification')}, ${jx(c, '$.assessment.classification')}) END, '') = 'likely-sale' THEN 1 ELSE 0 END)`;
}

// SQL mirror of reconstruction.probeKitKey (title key, ns-set key of a large
// movement cohort, portfolio-kit classification).
function kitKeySql(c) {
  const e = `${c}.evidence_json`;
  const host = "CASE WHEN substr(lower(value), -1) = '.' THEN substr(lower(value), 1, length(value) - 1) ELSE lower(value) END";
  return `(CASE WHEN json_valid(${e}) THEN COALESCE(
      'title:' || NULLIF(${jx(c, '$.discovery.kit.key')}, ''),
      CASE WHEN CAST(${jx(c, '$.discovery.movement.cohortSize')} AS REAL) >= ${BATCH_MIN_NAMES} THEN 'ns:' || NULLIF((SELECT group_concat(h, ',') FROM (
        SELECT DISTINCT ${host} AS h FROM json_each(${e}, '$.discovery.movement.currentNameservers') WHERE h <> '' ORDER BY h)), '') END,
      CASE WHEN COALESCE(NULLIF(${jx(c, '$.classification')}, ''), ${jx(c, '$.assessment.classification')}) = 'portfolio-kit' THEN 'class:portfolio-kit' END)
    END)`;
}

// One key row's values, in COLUMNS order. `c` is the candidate alias (or
// `new` in a trigger); storedLikely is the stored-assessment fragment.
function keyValuesSql(c, storedLikely) {
  return [
    `${c}.domain`,
    `${c}.rowid`,
    `${c}.state`,
    `CASE WHEN ${c}.state IN ${LIVE_STATES_SQL} THEN 1 ELSE 0 END`,
    `CASE WHEN ${eligibleSql(c)} THEN 1 ELSE 0 END`,
    `${c}.next_probe_at`,
    `${c}.probe_count`,
    `${c}.probe_priority`,
    `${c}.exit_observed_day`,
    `${c}.last_stream`,
    `CASE WHEN json_valid(${c}.evidence_json) THEN 1 ELSE 0 END`,
    likelyEvidenceSql(c),
    `CASE WHEN json_valid(${c}.evidence_json) THEN (CASE WHEN ${signalEvidenceClauses(c).join(' OR ')} THEN 1 ELSE 0 END) ELSE 0 END`,
    storedLikely,
    kitKeySql(c),
    adoptEvidenceSql(c),
    sellerDepartureSql(c),
    rdapCheckedSql(c),
  ].join(',\n      ');
}

/** Predicate (on alias k) equal to highSignalSql for a key row. */
function keySignalSql(k = 'k') {
  return `(${k}.ev_valid = 1 AND (${k}.sig_ev = 1 OR ${k}.stored_likely = 1))`;
}

/** Predicate (on alias k) equal to the due-selection eligibility minus the clock bound. */
function keyDueSql(k = 'k') {
  return `(${k}.live = 1 AND ${k}.eligible = 1 AND ${k}.next_probe_at IS NOT NULL)`;
}

/** Predicate (on alias k) of the partial seller-departure index. */
function keySellerSql(k = 'k') {
  return `(${k}.seller_dep = 1 AND ${k}.live = 1 AND ${k}.eligible = 1)`;
}

function metaRow(db) {
  try {
    const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(META_KEY);
    const parsed = row ? JSON.parse(row.value) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeMeta(db, value) {
  db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(META_KEY, JSON.stringify(value));
}

/**
 * Creates the (empty on first run) key table, its partial indexes and the
 * triggers that keep it current. Constant time: no scan, safe at boot on any
 * writable handle. A KEY_VERSION change drops and recreates the table and
 * restarts the backfill. Writable handle only.
 */
function ensureCandidateKeysSchema(db) {
  const meta = metaRow(db);
  const stale = meta && meta.version !== KEY_VERSION;
  // Already current: no DDL, no write (every open would otherwise rewrite the
  // triggers, append to the WAL and invalidate other connections' statements).
  if (meta && !stale) {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE (type = 'trigger' OR type = 'index' OR type = 'table') AND name LIKE ?").all(`${TABLE}%`).map(r => r.name)
      .concat(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE ?").all(`idx_${TABLE}%`).map(r => r.name)));
    const required = [TABLE, `${TABLE}_ai`, `${TABLE}_au`, `${TABLE}_ad`, `${TABLE}_assess_ai`, `${TABLE}_assess_au`,
      `idx_${TABLE}_due`, `idx_${TABLE}_window`, `idx_${TABLE}_signal`, `idx_${TABLE}_adopt`, `idx_${TABLE}_seller`];
    if (required.every(name => names.has(name))) return;
  }
  const storedLikelyNew = `COALESCE((SELECT CASE WHEN classification = 'likely-sale' THEN 1 ELSE 0 END FROM sale_watch_assessments WHERE domain = new.domain), 0)`;
  const insertNew = `INSERT INTO ${TABLE}(${COLUMNS.join(', ')}) SELECT
      ${keyValuesSql('new', storedLikelyNew)}`;
  const assessLikely = "CASE WHEN new.classification = 'likely-sale' THEN 1 ELSE 0 END";
  const run = () => {
    db.exec('CREATE TABLE IF NOT EXISTS sale_watch_meta (key TEXT PRIMARY KEY, value TEXT)');
    if (stale) db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        domain TEXT PRIMARY KEY,
        rid INTEGER,
        state TEXT,
        live INTEGER NOT NULL DEFAULT 0,
        eligible INTEGER NOT NULL DEFAULT 0,
        next_probe_at TEXT,
        probe_count INTEGER,
        probe_priority INTEGER,
        exit_observed_day TEXT,
        last_stream TEXT,
        ev_valid INTEGER NOT NULL DEFAULT 0,
        likely_ev INTEGER NOT NULL DEFAULT 0,
        sig_ev INTEGER NOT NULL DEFAULT 0,
        stored_likely INTEGER NOT NULL DEFAULT 0,
        kit_key TEXT,
        adopt_ev INTEGER NOT NULL DEFAULT 0,
        seller_dep INTEGER NOT NULL DEFAULT 0,
        rdap_at TEXT
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_due ON ${TABLE} (next_probe_at) WHERE ${keyDueSql(TABLE)};
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_window ON ${TABLE} (exit_observed_day, rid);
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_signal ON ${TABLE} (exit_observed_day, rid) WHERE ${keySignalSql(TABLE)};
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_adopt ON ${TABLE} (exit_observed_day) WHERE adopt_ev = 1;
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_seller ON ${TABLE} (exit_observed_day, domain) WHERE ${keySellerSql(TABLE)};
      DROP TRIGGER IF EXISTS ${TABLE}_ai;
      DROP TRIGGER IF EXISTS ${TABLE}_au;
      DROP TRIGGER IF EXISTS ${TABLE}_ad;
      DROP TRIGGER IF EXISTS ${TABLE}_assess_ai;
      DROP TRIGGER IF EXISTS ${TABLE}_assess_au;
      CREATE TRIGGER ${TABLE}_ai AFTER INSERT ON sale_watch_candidates WHEN ${populationSql('new')} BEGIN
        DELETE FROM ${TABLE} WHERE domain = new.domain;
        ${insertNew};
      END;
      CREATE TRIGGER ${TABLE}_au AFTER UPDATE OF domain, state, next_probe_at, probe_count, probe_priority, exit_observed_day, last_stream, evidence_json
      ON sale_watch_candidates BEGIN
        DELETE FROM ${TABLE} WHERE domain IN (old.domain, new.domain);
        ${insertNew} WHERE ${populationSql('new')};
      END;
      CREATE TRIGGER ${TABLE}_ad AFTER DELETE ON sale_watch_candidates BEGIN
        DELETE FROM ${TABLE} WHERE domain = old.domain;
      END;
      CREATE TRIGGER ${TABLE}_assess_ai AFTER INSERT ON sale_watch_assessments BEGIN
        UPDATE ${TABLE} SET stored_likely = ${assessLikely} WHERE domain = new.domain AND stored_likely IS NOT ${assessLikely};
      END;
      CREATE TRIGGER ${TABLE}_assess_au AFTER UPDATE OF classification ON sale_watch_assessments BEGIN
        UPDATE ${TABLE} SET stored_likely = ${assessLikely} WHERE domain = new.domain AND stored_likely IS NOT ${assessLikely};
      END;
    `);
    if (!meta || stale) {
      // An empty candidates table needs no backfill: the triggers cover every
      // row from now on, so the keys are ready at once (one indexed probe).
      const empty = !db.prepare('SELECT 1 FROM sale_watch_candidates LIMIT 1').get();
      const at = new Date().toISOString();
      writeMeta(db, empty
        ? { version: KEY_VERSION, rid: 0, complete: true, startedAt: at, completeAt: at }
        : { version: KEY_VERSION, rid: 0, complete: false, startedAt: at });
    }
  };
  if (db.inTransaction) run();
  else db.transaction(run).immediate();
}

/** { version, rid, complete, ... } backfill position, or null before the schema exists. Read-only. */
function candidateKeysProgress(db) {
  return metaRow(db);
}

/** True once every pre-existing candidate has a key row (current KEY_VERSION). Read-only, one PK read. */
function candidateKeysReady(db) {
  const meta = metaRow(db);
  return Boolean(meta && meta.version === KEY_VERSION && meta.complete === true);
}

/**
 * Fills key rows for candidates that existed before the triggers, in
 * rowid-range chunks of `chunk` rows, one small IMMEDIATE transaction each,
 * yielding between them. The position is persisted after every chunk, so a
 * restart resumes there. `limit` bounds the chunks per call (tests). Writable
 * handle, off the HTTP thread (indexer worker).
 */
//
// 2026-11-07 production: the previous form ran INSERT ... SELECT (every
// json_extract over ~8-400 KB evidence overflow pages, cold cache) INSIDE the
// IMMEDIATE transaction, so each chunk held the WAL write lock for the whole
// evidence read: ~40 rows/s, and the wave's intake lost 5 of 6 lock retries.
// Now each batch is a cheap keyset read (rowid > cursor ORDER BY rowid LIMIT n)
// of only the key columns and JSON paths, run OUTSIDE any write transaction,
// followed by a short write of the small computed rows. The write is
// INSERT OR IGNORE guarded by the candidate still existing, so a row the
// triggers wrote (or deleted) after the read always wins; stored_likely is
// read at write time. The batch size adapts to keep each read short.
const BACKFILL_MIN_BATCH = 100;
const BACKFILL_TARGET_READ_MS = 250;
const BACKFILL_WRITER_GAP_MS = 120;

async function backfillCandidateKeys(db, { chunk = DEFAULT_CHUNK, maxChunks = Infinity, onBatch = null, onProgress = null, pauseMs = null, progressEvery = 10 } = {}) {
  ensureCandidateKeysSchema(db);
  const started = Date.now();
  const meta = metaRow(db);
  if (meta && meta.complete) return { complete: true, resumedFrom: meta.rid, rows: 0, chunks: 0, ms: 0, rowsPerSec: null };
  const maxSize = Math.max(1, Math.floor(Number(chunk)) || DEFAULT_CHUNK);
  let size = Math.min(maxSize, Math.max(BACKFILL_MIN_BATCH, Math.floor(maxSize / 2)));
  const resumedFrom = Number(meta && meta.rid) || 0;
  const maxRid = Number(db.prepare('SELECT MAX(rowid) AS m FROM sale_watch_candidates').get().m) || 0;
  const read = db.prepare(`SELECT ${keyValuesSql('c', '0')}
    FROM sale_watch_candidates c
    WHERE c.rowid > @lo AND c.rowid <= @maxRid AND ${populationSql('c')}
    ORDER BY c.rowid LIMIT @size`).raw(true);
  const storedIdx = COLUMNS.indexOf('stored_likely');
  const values = COLUMNS.map((name, i) => (i === storedIdx
    ? "COALESCE((SELECT CASE WHEN classification = 'likely-sale' THEN 1 ELSE 0 END FROM sale_watch_assessments WHERE domain = @c0), 0)"
    : `@c${i}`));
  const write = db.prepare(`INSERT OR IGNORE INTO ${TABLE}(${COLUMNS.join(', ')}) SELECT ${values.join(', ')}
    WHERE EXISTS (SELECT 1 FROM sale_watch_candidates WHERE rowid = @c1 AND domain = @c0)`);
  const yieldMod = require('./sale-watch-yield');
  const pause = pauseMs == null ? null : Math.max(0, Math.floor(Number(pauseMs)) || 0);
  // Fair writer sharing: after each write the backfill stays off the lock
  // for at least as long as it just held it, and (off-main, where a pause is
  // configured) never less than BACKFILL_WRITER_GAP_MS, which spans SQLite's
  // longest busy-handler sleep, so a waiting intake writer always gets in.
  const basePause = () => (pause == null ? yieldMod.transactionPause() : pause);
  const yieldNow = (heldMs = 0) => {
    const base = basePause();
    const ms = base > 0 ? Math.max(base, BACKFILL_WRITER_GAP_MS, Math.min(heldMs, 1000)) : 0;
    return ms > 0 ? new Promise(r => setTimeout(r, ms)) : new Promise(r => setImmediate(r));
  };
  const rate = examined => { const ms = Date.now() - started; return ms > 0 ? Math.round(examined * 1000 / ms) : examined; };
  let rid = resumedFrom;
  let rows = 0;
  let examined = 0;
  let chunks = 0;
  let done = rid >= maxRid;
  while (!done && chunks < maxChunks) {
    const readStarted = Date.now();
    const batch = read.all({ lo: rid, maxRid, size });
    const readMs = Date.now() - readStarted;
    const hi = batch.length ? Number(batch[batch.length - 1][1]) : maxRid;
    if (batch.length < size) done = true;
    examined += batch.length;
    const rowsPerSec = rate(examined);
    const step = db.transaction(() => {
      let n = 0;
      for (const row of batch) {
        const params = {};
        for (let i = 0; i < row.length; i += 1) if (i !== storedIdx) params[`c${i}`] = row[i];
        n += write.run(params).changes;
      }
      writeMeta(db, { ...(metaRow(db) || {}), version: KEY_VERSION, rid: hi, maxRid, complete: false, rowsPerSec, examined: (Number(meta && meta.examined) || 0) + examined });
      if (onBatch) { try { onBatch(db); } catch (_) { /* advisory */ } }
      return n;
    });
    const writeStarted = Date.now();
    rows += step.immediate();
    const writeMs = Date.now() - writeStarted;
    rid = hi;
    chunks += 1;
    // Keep each off-lock read short on a cold cache; grow back when cheap.
    if (readMs > 2 * BACKFILL_TARGET_READ_MS) size = Math.max(BACKFILL_MIN_BATCH, Math.floor(size / 2));
    else if (readMs < BACKFILL_TARGET_READ_MS / 2) size = Math.min(maxSize, size * 2);
    if (onProgress && (chunks % progressEvery === 0 || done)) {
      try { onProgress({ phase: 'candidate-keys', indexed: rows, examined, rid, maxRid, ms: Date.now() - started, rowsPerSec }); } catch (_) { /* advisory */ }
    }
    if (!done) await yieldNow(writeMs);
  }
  const complete = done;
  const rowsPerSec = rate(examined);
  if (complete) {
    db.transaction(() => writeMeta(db, { ...(metaRow(db) || {}), version: KEY_VERSION, rid: maxRid, maxRid, complete: true, rowsPerSec, completeAt: new Date().toISOString() })).immediate();
  }
  return { complete, resumedFrom, rid: complete ? maxRid : rid, maxRid, rows, examined, chunks, ms: Date.now() - started, rowsPerSec };
}

module.exports = {
  TABLE,
  KEY_VERSION,
  signalEvidenceClauses,
  keySignalSql,
  keyDueSql,
  keySellerSql,
  ensureCandidateKeysSchema,
  backfillCandidateKeys,
  candidateKeysReady,
  candidateKeysProgress,
};
