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
  [new RegExp(`INDEXED BY ${cands.MISSING_DAY_INDEX}`), new RegExp(`SEARCH sale_watch_candidates USING INDEX ${cands.MISSING_DAY_INDEX} \\(<expr>>\\? AND <expr><\\?\\)`)],
  [new RegExp(`FROM ${cands.RESCORED_DAY_TABLE}\\s+WHERE day >= @from`), new RegExp(`SEARCH ${cands.RESCORED_DAY_TABLE} USING PRIMARY KEY \\(day>\\? AND day<\\?\\)`)],
  // Keyset page rows (no q): one cohort-size group after the cursor, LIMIT-bounded,
  // either by destination key or by walking the day's domain order.
  [new RegExp(`INDEXED BY ${cands.DOC_KEY_INDEX}[\\s\\S]*d\\.domain > @after`), new RegExp(`SEARCH d USING INDEX ${cands.DOC_KEY_INDEX} \\(report_day=\\? AND <expr>=\\? AND domain>\\?\\)`)],
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
