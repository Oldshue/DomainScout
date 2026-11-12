'use strict';

// Candidate tape and ledger reads at production scale.
//
// 1. Query plans: every statement readSaleWatchCandidates (and the stored
//    ledger page/count) runs is captured on a small production-shaped
//    fixture and EXPLAINed. None may SCAN sale_watch_candidates, the search
//    documents table or the views table, and the tape statements must name
//    their intended index.
// 2. Timing: on a generated 1.4M-row database every page (limit 500, 1-14
//    day windows, built/tld/q, first and cursor page) answers under 2 s.
//    Skipped only when DOMAINSCOUT_SKIP_TAPE_SCALE=1. DOMAINSCOUT_TAPE_SCALE_DB
//    may point at an already-generated fixture file to reuse it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { buildTapeFixture } = require('../scripts/lib/sale-watch-tape-fixture');
const cands = require('../server/sale-watch-candidates');
const store = require('../server/sale-watch-assessments');
const search = require('../server/sale-watch-search');

const TODAY = '2026-11-12';
const NOW = `${TODAY}T12:00:00.000Z`;
const CASES = [
  { days: 1 }, { days: 7 }, { days: 14 },
  { days: 3, built: 'true' }, { days: 7, built: 'true' }, { days: 7, built: 'false' },
  { days: 7, tld: 'io' }, { days: 7, q: 'inference' }, { days: 14, q: 'payroll' },
  { from: '2026-10-30', to: '2026-11-01' },
];

function forbiddenScan(line) {
  // A SCAN of a LIMIT-capped subquery result walks at most the cap, not a table.
  return /^SCAN /.test(line) && !/VIRTUAL TABLE|CONSTANT ROW|sqlite_master|^SCAN \(subquery-\d+\)$/.test(line);
}

// `SELECT 1 FROM <table> LIMIT 1` is an existence probe: it stops at the first row.
function existenceProbe(sql) {
  return /^\s*SELECT 1 FROM \S+ LIMIT 1\s*$/i.test(sql);
}

// Records every statement (and its first bound arguments) the reader runs.
function capture(db) {
  const seen = new Map();
  const original = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = original(sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = target[key];
        if (key === 'all' || key === 'get' || key === 'iterate') {
          return (...args) => { if (!seen.has(sql)) seen.set(sql, args); return value.apply(target, args); };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return { seen, restore: () => { db.prepare = original; }, plan: (sql, args) => original(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail) };
}

// [statement pattern, plan line that must appear]
const INTENDED = [
  [/FROM sale_watch_destination_day\s+WHERE day >= \? AND day <= \? GROUP BY ns_key/, /SEARCH sale_watch_destination_day USING PRIMARY KEY \(day>\? AND day<\?\)/],
  [/SUM\(n - e\) AS n FROM sale_watch_destination_day/, /SEARCH sale_watch_destination_day USING PRIMARY KEY/],
  [/FROM sale_watch_tape_day/, /SEARCH sale_watch_tape_day USING PRIMARY KEY/],
  [/FROM sale_watch_tape_missing_day m/, /SEARCH m USING PRIMARY KEY \(day>\? AND day<\?\)/],
  [new RegExp(`FROM ${cands.RESCORED_DAY_TABLE}\\s+WHERE day >= @from`), new RegExp(`SEARCH ${cands.RESCORED_DAY_TABLE} USING PRIMARY KEY \\(day>\\? AND day<\\?\\)`)],
  // Keyset page rows (no q): one cohort-size group after the cursor, LIMIT-bounded,
  // either by destination key or by walking the day's domain order.
  [/FROM sale_watch_tape_doc_key k[\s\S]*k\.name > @after/, /SEARCH k USING PRIMARY KEY \(day=\? AND ns_key=\? AND name>\?\)/],
  [/INDEXED BY idx_sale_watch_search_docs_census[\s\S]*d\.domain > @after/, /SEARCH d USING COVERING INDEX idx_sale_watch_search_docs_census \(report_day=\? AND domain>\?\)/],
  [/outcome_tier AS ledgerTier/, /SEARCH sale_watch_candidates USING INDEX sqlite_autoindex_sale_watch_candidates_1 \(domain=\?\)/],
  [/FROM sale_watch_movement_imports WHERE day >= \?/, /SEARCH sale_watch_movement_imports USING INDEX/],
];

let small = null;
async function smallFixture() {
  if (small) return small;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tape-plan-'));
  const file = path.join(dir, 'tape.db');
  await buildTapeFixture({ rows: 20000, file, today: TODAY, analyze: true });
  small = { dir, file };
  return small;
}

test.after(() => { if (small) fs.rmSync(small.dir, { recursive: true, force: true }); });

test('every candidate-tape statement is index-driven: no SCAN of the candidates or documents table', async () => {
  const { file } = await smallFixture();
  const db = new Database(file, { readonly: true });
  try {
    assert.equal(cands.tapeIndexesReady(db), true);
    assert.equal(cands.tapeDaysReady(db), true);
    assert.equal(cands.destinationDaysReady(db), true);
    const cap = capture(db);
    for (const params of CASES) {
      const first = cands.readSaleWatchCandidates(db, { ...params, limit: 500, now: NOW });
      assert.equal(first.coverage.census, 'destination-day', JSON.stringify(params));
      if (first.pagination.nextCursor) cands.readSaleWatchCandidates(db, { ...params, limit: 500, now: NOW, cursor: first.pagination.nextCursor });
    }
    cap.restore();
    const matched = new Set();
    for (const [sql, args] of cap.seen) {
      if (/^\s*PRAGMA/i.test(sql)) continue;
      const plan = cap.plan(sql, args);
      const bad = plan.filter(forbiddenScan);
      assert.deepEqual(bad, [], `${sql.replace(/\s+/g, ' ').slice(0, 200)}\n${plan.join('\n')}`);
      INTENDED.forEach(([pattern, expected], index) => {
        if (!pattern.test(sql)) return;
        matched.add(index);
        assert.ok(plan.some(line => expected.test(line)), `${sql.replace(/\s+/g, ' ').slice(0, 200)}\nexpected ${expected}\n${plan.join('\n')}`);
      });
    }
    assert.deepEqual([...matched].sort((a, b) => a - b), INTENDED.map((_, i) => i), 'every tape statement on the path was exercised');
  } finally { db.close(); }
});

// Built/tld pages on the per-day census must equal the window-scan reference:
// same matched count, same remaining, same rows in the same order, on the
// first page and on cursor pages (each pass follows its own cursor).
test('built, tld and built+tld pages match the window-scan reference, first and cursor pages', async () => {
  const { file } = await smallFixture();
  const db = new Database(file, { readonly: true });
  try {
    assert.equal(cands.tapeDaysReady(db), true);
    const total = db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM ${cands.TAPE_DAY_TABLE}`).get().n;
    assert.ok(total > 0, 'the per-day tld/built census is populated');
    const cases = [
      { days: 3, built: 'true' }, { days: 7, built: 'true' }, { days: 7, built: 'false' },
      { days: 7, tld: 'io' }, { days: 14, tld: 'com' },
      { days: 7, tld: 'io', built: 'true' }, { days: 14, tld: 'com', built: 'false' },
      { from: '2026-10-30', to: '2026-11-01', built: 'false' }, { from: '2026-10-30', to: '2026-11-01', tld: 'com', built: 'false' },
    ];
    const shape = r => [r.domain, r.departureDay, r.cohortSize, r.built, r.tld];
    for (const params of cases) {
      // Page size below the reference match count so every case reaches cursor pages.
      let limit = 40;
      const read = (cursor, options) => cands.readSaleWatchCandidates(db, { ...params, limit, now: NOW, ...(cursor ? { cursor } : {}) }, options);
      let fast = read(null);
      let ref = read(null, { census: 'window-scan' });
      if (ref.matched <= limit) {
        limit = Math.max(1, Math.floor(ref.matched / 3));
        fast = read(null);
        ref = read(null, { census: 'window-scan' });
      }
      assert.equal(fast.coverage.census, 'destination-day', JSON.stringify(params));
      assert.ok(ref.matched > 0, `reference matches rows for ${JSON.stringify(params)}`);
      let pages = 0;
      for (;;) {
        const label = JSON.stringify({ params, page: pages });
        assert.equal(fast.matched, ref.matched, label);
        assert.equal(fast.pagination.remaining, ref.pagination.remaining, label);
        assert.deepEqual(fast.rows.map(shape), ref.rows.map(shape), label);
        pages += 1;
        if (!ref.pagination.nextCursor || pages >= 4) break;
        assert.ok(fast.pagination.nextCursor, label);
        fast = read(fast.pagination.nextCursor);
        ref = read(ref.pagination.nextCursor, { census: 'window-scan' });
      }
      assert.ok(pages >= 2, `cursor pages compared for ${JSON.stringify(params)}`);
    }
  } finally { db.close(); }
});

// Schema creation alone never marks the census ready; only the backfill does.
test('the tape-day census is never marked ready by schema creation and the backfill makes it exact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tape-day-'));
  const file = path.join(dir, 'tape.db');
  try {
    const recon = require('../server/sale-watch-reconstruction');
    const db = new Database(file);
    try {
      recon.ensureReconstructionSchema(db);
      search.ensureSearchSchema(db);
      assert.equal(cands.tapeDaysReady(db), false, 'a freshly created census over an empty store is not ready');
      await cands.rebuildTapeDays(db);
      assert.equal(cands.tapeDaysReady(db), true);
      assert.equal(db.prepare("SELECT value FROM sale_watch_meta WHERE key = 'tape_day_progress'").get(), undefined);
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the stale-document count runs on the version index and is capped', async () => {
  const { file } = await smallFixture();
  const db = new Database(file, { readonly: true });
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${cands.STALE_COUNT_SQL}`).all({ from: '2026-11-06', to: TODAY, version: search.SEARCH_VERSION }).map(r => r.detail);
    assert.deepEqual(plan.filter(forbiddenScan), [], plan.join('\n'));
    assert.ok(plan.some(line => /idx_sale_watch_search_docs_version/.test(line)), plan.join('\n'));
    assert.match(cands.STALE_COUNT_SQL, new RegExp(`LIMIT ${cands.STALE_CAP}`));
  } finally { db.close(); }
});

// The rescored and stale-document counts are read from trigger-maintained
// per-day tables (built by the indexer worker). Both must equal a direct
// count after inserts, updates and deletes, and both reads are PK SEARCHes.
test('rescored and stale counts come from maintained per-day tables that stay exact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tape-maint-'));
  const file = path.join(dir, 'tape.db');
  try {
    await buildTapeFixture({ rows: 5000, file, today: TODAY, analyze: false });
    const db = new Database(file);
    try {
      assert.equal(cands.rescoredDaysReady(db), true);
      assert.equal(cands.docVersionDaysReady(db), true);
      const w = { from: '2026-10-30', to: TODAY, version: search.SEARCH_VERSION };
      const DEP = "COALESCE(NULLIF(json_extract(evidence_json,'$.reportDate'),''),exit_observed_day,'')";
      const directRescored = () => db.prepare(`SELECT COUNT(*) AS n FROM sale_watch_candidates
        WHERE outcome IN ('platform-excluded','expiry-excluded') AND ${DEP} >= @from AND ${DEP} <= @to`).get(w).n;
      const directStale = () => db.prepare(`SELECT COUNT(*) AS n FROM sale_watch_search_docs
        WHERE COALESCE(search_version, '') <> @version AND report_day >= @from AND report_day <= @to`).get(w).n;
      const keptRescored = () => db.prepare(cands.RESCORED_DAY_SUM_SQL).get(w).n;
      const keptStale = () => db.prepare(cands.STALE_DAY_SUM_SQL).get(w).n;
      assert.equal(keptRescored(), directRescored());
      assert.equal(keptStale(), directStale());
      assert.equal(cands.rescoredCountSql(db), cands.RESCORED_DAY_SUM_SQL);
      const doms = db.prepare('SELECT domain FROM sale_watch_candidates LIMIT 60').all().map(r => r.domain);
      const setOutcome = db.prepare('UPDATE sale_watch_candidates SET outcome = ? WHERE domain = ?');
      doms.slice(0, 30).forEach(d => setOutcome.run('platform-excluded', d));
      doms.slice(0, 10).forEach(d => setOutcome.run(null, d));
      db.prepare('DELETE FROM sale_watch_candidates WHERE domain = ?').run(doms[15]);
      const docs = db.prepare("SELECT domain FROM sale_watch_search_docs WHERE report_day >= '2026-10-30' LIMIT 80").all().map(r => r.domain);
      const setVersion = db.prepare('UPDATE sale_watch_search_docs SET search_version = ? WHERE domain = ?');
      docs.slice(0, 40).forEach(d => setVersion.run('old-v0', d));
      docs.slice(40, 50).forEach(d => setVersion.run(null, d));
      docs.slice(0, 5).forEach(d => setVersion.run(search.SEARCH_VERSION, d));
      db.prepare("UPDATE sale_watch_search_docs SET report_day = '2026-10-01' WHERE domain = ?").run(docs[20]);
      db.prepare('DELETE FROM sale_watch_search_docs WHERE domain = ?').run(docs[30]);
      assert.ok(directRescored() > 0 && directStale() > 0);
      assert.equal(keptRescored(), directRescored());
      assert.equal(keptStale(), directStale());
      for (const sql of [cands.RESCORED_DAY_SUM_SQL, cands.STALE_DAY_SUM_SQL]) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(w).map(r => r.detail);
        assert.deepEqual(plan.filter(forbiddenScan), [], plan.join('\n'));
        assert.ok(plan.some(line => /USING PRIMARY KEY \(day>\? AND day<\?\)/.test(line)), plan.join('\n'));
      }
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// An interrupted per-day rebuild resumes after its saved day and ends exact;
// until it finishes, the version mark is absent so readers use the fallback.
test('the rescored and document-version backfills resume after an interruption and end exact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tape-resume-'));
  const file = path.join(dir, 'tape.db');
  try {
    await buildTapeFixture({ rows: 5000, file, today: TODAY, analyze: false });
    const db = new Database(file);
    try {
      const w = { from: '2026-09-01', to: TODAY, version: search.SEARCH_VERSION };
      const expected = { r: db.prepare(cands.RESCORED_DAY_SUM_SQL).get(w).n, s: db.prepare(cands.STALE_DAY_SUM_SQL).get(w).n,
        rows: db.prepare(`SELECT day, version, n FROM ${cands.DOC_VERSION_DAY_TABLE} ORDER BY 1, 2`).all() };
      for (const [table, versionKey, progressKey, version] of [
        [cands.RESCORED_DAY_TABLE, 'tape_rescored_day_version', 'tape_rescored_day_progress', cands.RESCORED_DAY_VERSION],
        [cands.DOC_VERSION_DAY_TABLE, 'tape_doc_version_day_version', 'tape_doc_version_day_progress', cands.DOC_VERSION_DAY_VERSION]]) {
        const days = db.prepare(`SELECT DISTINCT day FROM ${table} ORDER BY day`).all().map(r => r.day);
        assert.ok(days.length > 2, table);
        const mid = days[Math.floor(days.length / 2)];
        // Interrupted after `mid`: later days were never recomputed (here: emptied).
        db.prepare('DELETE FROM sale_watch_meta WHERE key = ?').run(versionKey);
        db.prepare("INSERT INTO sale_watch_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(progressKey, JSON.stringify({ version, day: mid }));
        db.prepare(`DELETE FROM ${table} WHERE day > ?`).run(mid);
      }
      assert.equal(cands.rescoredDaysReady(db), false);
      assert.equal(cands.docVersionDaysReady(db), false);
      const r = await cands.rebuildRescoredDays(db);
      const d = await cands.rebuildDocVersionDays(db);
      assert.ok(r.resumedAfter && r.rebuilt < r.days, JSON.stringify(r));
      assert.ok(d.resumedAfter && d.rebuilt < d.days, JSON.stringify(d));
      assert.equal(cands.rescoredDaysReady(db), true);
      assert.equal(cands.docVersionDaysReady(db), true);
      assert.equal(db.prepare(cands.RESCORED_DAY_SUM_SQL).get(w).n, expected.r);
      assert.equal(db.prepare(cands.STALE_DAY_SUM_SQL).get(w).n, expected.s);
      assert.deepEqual(db.prepare(`SELECT day, version, n FROM ${cands.DOC_VERSION_DAY_TABLE} ORDER BY 1, 2`).all(), expected.rows);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sale_watch_meta WHERE key IN ('tape_rescored_day_progress','tape_doc_version_day_progress')").get().n, 0);
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The missing set and the keyset table replace CREATE INDEX builds: both are
// trigger-kept, backfilled in bounded resumable chunks, and stay exact.
test('the missing-row set and keyset table are built in resumable chunks and stay exact under writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tape-sets-'));
  const file = path.join(dir, 'tape.db');
  try {
    await buildTapeFixture({ rows: 5000, file, today: TODAY, analyze: false });
    const db = new Database(file);
    try {
      const { ELIGIBLE_SIGNAL_SQL } = require('../server/sale-watch-reconstruction');
      const DEP = "COALESCE(NULLIF(json_extract(evidence_json,'$.reportDate'),''),exit_observed_day,'')";
      const directMissing = () => db.prepare(`SELECT ${DEP} AS day, domain AS name FROM sale_watch_candidates
        WHERE search_text IS NULL AND evidence_json IS NOT NULL AND state IN ('detected','transferring','probing','parked-watch','exited')
          AND (outcome IS NULL OR outcome NOT IN ('platform-excluded','expiry-excluded')) AND ${ELIGIBLE_SIGNAL_SQL} ORDER BY 1, 2`).all();
      const keptMissing = () => db.prepare(`SELECT day, name FROM ${cands.MISSING_DAY_TABLE} ORDER BY 1, 2`).all();
      const directKeys = () => db.prepare(`SELECT COALESCE(report_day, '') AS day, COALESCE(destination_key, '') AS ns_key, domain AS name FROM sale_watch_search_docs ORDER BY 1, 2, 3`).all();
      const keptKeys = () => db.prepare(`SELECT day, ns_key, name FROM ${cands.DOC_KEY_TABLE} ORDER BY 1, 2, 3`).all();
      assert.equal(cands.missingDaysReady(db), true);
      assert.equal(cands.docKeyIndexReady(db), true);
      assert.ok(directMissing().length > 0);
      assert.deepEqual(keptMissing(), directMissing());
      assert.deepEqual(keptKeys(), directKeys());
      // Interrupted backfill: not ready (readers fall back) until it resumes and finishes.
      db.prepare(`DELETE FROM ${cands.MISSING_DAY_TABLE}`).run();
      db.prepare("DELETE FROM sale_watch_meta WHERE key = 'tape_missing_day_version'").run();
      const partial = await cands.rebuildMissingDays(db, { chunk: 25, maxChunks: 3 });
      assert.equal(partial.complete, false);
      assert.equal(cands.missingDaysReady(db), false);
      assert.ok(db.prepare("SELECT value FROM sale_watch_meta WHERE key = 'tape_missing_day_progress'").get());
      const rest = await cands.rebuildMissingDays(db, { chunk: 25 });
      assert.equal(rest.complete, true);
      assert.ok(rest.resumedFrom && rest.resumedFrom.rid > 0);
      assert.equal(cands.missingDaysReady(db), true);
      assert.deepEqual(keptMissing(), directMissing());
      // Writes after the build: triggers keep both exact.
      const indexed = db.prepare('SELECT domain FROM sale_watch_candidates WHERE search_text IS NOT NULL AND evidence_json IS NOT NULL LIMIT 30').all().map(r => r.domain);
      const missing = directMissing().slice(0, 20).map(r => r.name);
      const setText = db.prepare('UPDATE sale_watch_candidates SET search_text = ? WHERE domain = ?');
      indexed.forEach(d => setText.run(null, d));
      missing.slice(0, 8).forEach(d => setText.run(d, d));
      db.prepare("UPDATE sale_watch_candidates SET evidence_json = json_set(evidence_json, '$.reportDate', '2026-11-02') WHERE domain = ?").run(missing[10]);
      db.prepare("UPDATE sale_watch_candidates SET outcome = 'platform-excluded' WHERE domain = ?").run(missing[11]);
      db.prepare('DELETE FROM sale_watch_candidates WHERE domain = ?').run(missing[12]);
      const docs = db.prepare('SELECT domain FROM sale_watch_search_docs LIMIT 40').all().map(r => r.domain);
      db.prepare("UPDATE sale_watch_search_docs SET destination_key = 'ns1.moved.example' WHERE domain = ?").run(docs[1]);
      db.prepare("UPDATE sale_watch_search_docs SET report_day = '2026-11-01' WHERE domain = ?").run(docs[2]);
      db.prepare("UPDATE sale_watch_search_docs SET report_day = NULL WHERE domain = ?").run(docs[3]);
      db.prepare('DELETE FROM sale_watch_search_docs WHERE domain = ?').run(docs[4]);
      db.prepare("INSERT INTO sale_watch_search_docs (domain, name, report_day, destination_key) VALUES ('zz-new-doc.com', 'zz', '2026-11-10', 'ns1.q.example')").run();
      assert.deepEqual(keptMissing(), directMissing());
      assert.deepEqual(keptKeys(), directKeys());
      // Each backfill chunk is a keyset SEARCH of the existing partial index: no table scan, no sort.
      for (const [sql, args, expected] of [
        [cands.MISSING_BACKFILL_SAME_DAY_SQL, { x: '2026-11-01', rid: 10, n: 10 }, /SEARCH sale_watch_candidates USING (COVERING )?INDEX idx_sale_watch_search_missing \(exit_observed_day=\? AND rowid>\?\)/],
        [cands.MISSING_BACKFILL_NEXT_DAY_SQL, { x: '2026-11-01', n: 10 }, /SEARCH sale_watch_candidates USING (COVERING )?INDEX idx_sale_watch_search_missing \(exit_observed_day>\?\)/],
      ]) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(args).map(r => r.detail);
        assert.ok(plan.some(l => expected.test(l)), plan.join('\n'));
        assert.ok(!plan.some(l => /TEMP B-TREE/.test(l)), plan.join('\n'));
      }
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stored ledger page and totalRows read the views primary-key range (alpha, days 7/14/31)', async () => {
  const { file } = await smallFixture();
  const db = new Database(file, { readonly: true });
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${store.storedLedgerCountSql({ windowed: true })}`).all({ view: 'alpha', cutoff: '2026-10-12' }).map(r => r.detail);
    assert.deepEqual(plan, ['SEARCH v USING PRIMARY KEY (view=? AND report_date>?)']);
    const cap = capture(db);
    for (const days of [7, 14, 31]) {
      const page = store.readStoredLedgerEntries(db, { view: 'alpha', days, limit: 200, now: NOW });
      assert.equal(page.status, 'ready');
      assert.ok(Number.isInteger(page.totalRows));
    }
    cap.restore();
    for (const [sql, args] of cap.seen) {
      if (/^\s*PRAGMA/i.test(sql) || existenceProbe(sql) || !/sale_watch_assessment_views|FROM \S+ v\b/.test(sql)) continue;
      const p = cap.plan(sql, args);
      assert.deepEqual(p.filter(forbiddenScan), [], `${sql.replace(/\s+/g, ' ').slice(0, 200)}\n${p.join('\n')}`);
    }
  } finally { db.close(); }
});

const skipScale = process.env.DOMAINSCOUT_SKIP_TAPE_SCALE === '1';
test('at 1.4 million candidate rows every tape page answers under 2 s, first and cursor page alike', { skip: skipScale ? 'DOMAINSCOUT_SKIP_TAPE_SCALE=1' : false, timeout: 45 * 60 * 1000 }, async () => {
  let dir = null;
  let file = process.env.DOMAINSCOUT_TAPE_SCALE_DB || '';
  if (!file || !fs.existsSync(file)) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tape-scale-'));
    file = path.join(dir, 'tape.db');
    await buildTapeFixture({ rows: 1400000, file, today: TODAY, analyze: true });
  }
  const db = new Database(file, { readonly: true });
  try {
    const total = db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates').get().n;
    assert.ok(total >= 1400000, `fixture has ${total} rows`);
    const timings = [];
    for (const params of CASES) {
      let started = Date.now();
      const first = cands.readSaleWatchCandidates(db, { ...params, limit: 500, now: NOW });
      const firstMs = Date.now() - started;
      let cursorMs = null;
      if (first.pagination.nextCursor) {
        started = Date.now();
        cands.readSaleWatchCandidates(db, { ...params, limit: 500, now: NOW, cursor: first.pagination.nextCursor });
        cursorMs = Date.now() - started;
      }
      timings.push({ params, firstMs, cursorMs });
    }
    for (const days of [7, 14, 31]) {
      for (const limit of [200, 5000]) {
        const started = Date.now();
        store.readStoredLedgerEntries(db, { view: 'alpha', days, limit, now: NOW });
        timings.push({ params: { ledger: 'alpha', days, limit }, firstMs: Date.now() - started, cursorMs: null });
      }
    }
    const slow = timings.filter(t => t.firstMs >= 2000 || (t.cursorMs !== null && t.cursorMs >= 2000));
    assert.deepEqual(slow, [], JSON.stringify(timings));
  } finally {
    db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});
