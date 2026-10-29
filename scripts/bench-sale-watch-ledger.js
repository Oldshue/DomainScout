#!/usr/bin/env node
'use strict';

// DB-time benchmark for the stored Sale Watch ledger read.
//
// Builds a file-backed fixture of production size (default 1.2M candidates over
// 30 departure days) with bulk SQL. The stored assessment rows and view keys are
// synthesized in SQL: running the real adjudicator over 1.2M rows takes about
// 1 ms per row. This measures only the READ path. For each of alpha, focus and
// leads at days 1/2/7/30, with and without q, it opens a fresh read-only
// connection (no statement or page cache in SQLite; the OS file cache may still
// be warm) and times readReconstructionPage for one interactive page (101 rows).
//
// Usage: node scripts/bench-sale-watch-ledger.js [rows=1200000] [dbPath]
// Exit code 1 if any page takes >= 500 ms of DB time.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const recon = require('../server/sale-watch-reconstruction');
const search = require('../server/sale-watch-search');
const store = require('../server/sale-watch-assessments');
const { VERSION } = require('../server/sale-watch-evidence');

const N = Math.max(1000, Math.floor(Number(process.argv[2]) || 1200000));
const file = process.argv[3] || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-bench-')), 'sale_watch.db');
const TODAY = new Date().toISOString().slice(0, 10);

function build() {
  const t0 = Date.now();
  const db = new Database(file);
  recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  db.exec('DROP TABLE IF EXISTS bench_n; CREATE TEMP TABLE bench_n AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ' + N + ') SELECT i FROM n');
  // Every 50th name carries the word 'inference'; every 10th is buyer-built (focus/alpha).
  db.exec(`CREATE TEMP TABLE bench_rows AS SELECT i,
      'n' || i || CASE WHEN i % 50 = 0 THEN 'inference' ELSE 'shop' END || '.com' AS domain,
      date('${TODAY}', '-' || (i % 30) || ' day') AS day,
      CASE WHEN i % 10 = 0 THEN 'likely-sale' ELSE 'seller-departure' END AS cls
    FROM bench_n`);
  db.transaction(() => {
    db.exec(`INSERT INTO sale_watch_candidates (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at, search_text)
      SELECT domain, day, day, 'zone-seller-departure', day, 'exited', day, 1,
        json_object('domain', domain, 'tier', 'suspected', 'reportDate', day, 'classification', cls,
          'sellerNameservers', json_array('ns1.dan.com'), 'buyerNameservers', json_array('ns1.host.example'),
          'discovery', json_object('structurallyMoved', 1, 'departureDate', day, 'buyerUse', CASE WHEN cls = 'likely-sale' THEN 1 ELSE 0 END,
            'homepage', json_object('active', 1, 'status', 200, 'title', domain || ' home', 'description', 'A site we build for teams'))),
        day || 'T06:00:00Z', domain
      FROM bench_rows`);
    db.exec(`INSERT OR REPLACE INTO ${store.TABLE} (domain, version, assessed_at, dirty, eligible, tier, classification, report_date, evidence_rank, rationale, assessment_json, views)
      SELECT domain, '${VERSION}', day || 'T07:00:00Z', 0, 1, 'suspected', cls, day, CASE WHEN cls = 'likely-sale' THEN 0 ELSE 5 END, 'bench',
        json_object('version', '${VERSION}', 'basis', 'bench'),
        CASE WHEN cls = 'likely-sale' THEN 'all,leads,focus,alpha,suspected' ELSE 'all,leads,suspected' END
      FROM bench_rows`);
    for (const [view, where] of [['all', '1'], ['leads', '1'], ['suspected', '1'], ['focus', "cls = 'likely-sale'"], ['alpha', "cls = 'likely-sale'"]]) {
      db.exec(`INSERT OR REPLACE INTO ${store.VIEWS_TABLE} (view, report_date, evidence_rank, dlen, domain)
        SELECT '${view}', day, CASE WHEN cls = 'likely-sale' THEN 0 ELSE 5 END, length(domain), domain FROM bench_rows WHERE ${where}`);
    }
    db.exec(`INSERT INTO ${search.DOCS_TABLE} (domain, name, site, theme, theme_terms, report_day, search_version)
      SELECT domain, CASE WHEN i % 50 = 0 THEN 'n inference' ELSE 'n shop' END, 'a site we build for teams', '', '{}', day, '${search.SEARCH_VERSION}' FROM bench_rows`);
    db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(store.META_READY, VERSION);
  })();
  db.exec('ANALYZE');
  db.close();
  return Date.now() - t0;
}

function measure() {
  const results = [];
  for (const view of ['alpha', 'focus', 'leads']) {
    for (const days of [1, 2, 7, 30]) {
      for (const q of ['', 'inference']) {
        const db = new Database(file, { readonly: true });
        const t = process.hrtime.bigint();
        const page = recon.readReconstructionPage(db, { view, days, q, limit: 101 });
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        db.close();
        results.push({ view, days, q, status: page.status, rows: page.entries.length, ms: Math.round(ms * 10) / 10 });
      }
    }
  }
  return results;
}

const buildMs = fs.existsSync(file) && fs.statSync(file).size > 0 ? 0 : build();
const results = measure();
const worst = Math.max(...results.map(r => r.ms));
console.log(JSON.stringify({ rows: N, file, buildMs, worstMs: worst, targetMs: 500, pass: worst < 500, results }, null, 1));
process.exitCode = worst < 500 ? 0 : 1;
