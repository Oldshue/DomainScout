'use strict';

// Production-shaped Sale Watch fixture for the candidate-tape and ledger read
// paths (tests/sale-watch-tape-scale.test.js, scripts/bench-sale-watch-tape.js).
//
// Shape (defaults mirror the 2026-11-12 production store: ~1.4M candidates):
//   - `rows` candidates; `hotShare` of them depart inside the last `hotDays`
//     (the 1-14 day tape windows), the rest over the `coldDays` before that.
//   - ~30% evidence_json NULL (fresh departures awaiting a probe), ~5% of rows
//     search_text NULL (not yet indexed; with and without evidence).
//   - every indexed row has a search document (name-only when unprobed).
//   - 20% of rows move in bulk to one of 40 destination sets (batches); the
//     rest go to small, mostly unique destinations.
//   - zero-weight suffixes, rescored platform/expiry outcomes, terminal states
//     and expiry-origin sellers are present so every exclusion is exercised.
//   - evidence carries `pad` bytes of site text so json_extract reads overflow
//     pages as it does on the 21 GB file.
//   - stored assessments + view keys (all/leads/alpha/probable) so the ledger
//     days=31 view=alpha read runs on the stored path.
// Inserts run with the maintained-table triggers dropped (bulk speed), then
// the per-day census is rebuilt and every trigger is recreated by the real
// schema functions, so the result is exactly what the worker maintains.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULTS = Object.freeze({
  rows: 1400000,
  hotDays: 14,
  coldDays: 46,
  hotShare: 0.5,
  pad: 1200,
  analyze: false,
});

function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

async function buildTapeFixture(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const recon = require('../../server/sale-watch-reconstruction');
  const search = require('../../server/sale-watch-search');
  const store = require('../../server/sale-watch-assessments');
  const cands = require('../../server/sale-watch-candidates');
  const { VERSION } = require('../../server/sale-watch-evidence');
  const { SUFFIX_WEIGHTS } = require('../../server/domain-signal-policy');
  const zeroSuffix = (Object.entries(SUFFIX_WEIGHTS).find(([, w]) => w === 0) || ['xyz'])[0];
  const file = opts.file || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-tape-')), 'sale_watch.db');
  const today = opts.today || isoDay(Date.now());
  const N = Math.max(1000, Math.floor(Number(opts.rows)));
  // Hash-based hot selection: a parity rule (i % 2) would correlate with the
  // other i % k classes and keep whole classes (unindexed rows, .io) out of
  // the hot window.
  const hotPermille = Math.round(1000 * Math.max(0.01, Math.min(1, opts.hotShare)));
  const t0 = Date.now();
  const db = new Database(file);
  if (typeof recon.configureSaleWatchDb === 'function') recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  // Pause the maintained-table triggers for the bulk load (kept: FTS sync).
  const paused = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'
    AND tbl_name IN ('sale_watch_candidates', '${search.DOCS_TABLE}') AND name NOT LIKE '${search.DOCS_TABLE}_a%'`).all().map(r => r.name);
  for (const name of paused) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);

  db.exec(`DROP TABLE IF EXISTS temp.fx; CREATE TEMP TABLE fx AS
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${N})
    SELECT i,
      'n' || i || CASE WHEN i % 50 = 0 THEN 'inference' WHEN i % 13 = 0 THEN 'payroll' ELSE 'shop' END
        || '.' || CASE ((i * 40503) % 65521) % 20 WHEN 0 THEN '${zeroSuffix}' WHEN 1 THEN 'io' WHEN 2 THEN 'ai' WHEN 3 THEN 'net' WHEN 4 THEN 'co' ELSE 'com' END AS domain,
      CASE WHEN ((i * 2654435761) % 1000003) % 1000 < ${hotPermille} THEN date('${today}', '-' || (i % ${opts.hotDays}) || ' day')
        ELSE date('${today}', '-' || (${opts.hotDays} + i % ${opts.coldDays}) || ' day') END AS day,
      CASE WHEN i % 10 < 3 THEN 0 ELSE 1 END AS has_ev,
      CASE WHEN i % 20 = 7 THEN 0 ELSE 1 END AS indexed,
      CASE WHEN i % 5 = 0 THEN 'ns1.bulk' || (i % 40) || '.net' ELSE 'ns1.host' || (i % 200000) || '.example' END AS dest,
      CASE WHEN i % 25 = 3 THEN 1 ELSE 0 END AS expiry,
      CASE WHEN i % 33 = 0 THEN 'resolved' WHEN i % 4 = 1 THEN 'probing' ELSE 'exited' END AS state,
      CASE WHEN i % 50 = 11 THEN 'platform-excluded' WHEN i % 50 = 12 THEN 'expiry-excluded' ELSE NULL END AS outcome,
      CASE (i / 3) % 7 WHEN 0 THEN 'built' WHEN 1 THEN 'parked' WHEN 2 THEN 'inactive' ELSE NULL END AS site,
      CASE WHEN i % 10 = 9 THEN 'likely-sale' ELSE 'seller-departure' END AS cls
    FROM n`);
  const pad = Math.max(0, Math.floor(Number(opts.pad) || 0));
  db.transaction(() => {
    db.exec(`INSERT INTO sale_watch_candidates (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state,
        next_probe_at, probe_count, outcome, outcome_tier, evidence_json, updated_at, search_text)
      SELECT domain, day, day, 'zone-seller-departure', day, state, day || 'T08:00:00Z',
        CASE WHEN has_ev = 1 AND site IS NOT NULL THEN 1 ELSE 0 END, outcome, NULL,
        CASE WHEN has_ev = 0 THEN NULL ELSE json_object('tier', 'suspected', 'reportDate', day, 'classification', cls,
          'sellerNameservers', CASE WHEN expiry = 1 THEN json_array('ns1.expirednameservice.com', 'ns2.expirednameservice.com') ELSE json_array('ns1.dan.com', 'ns2.dan.com') END,
          'buyerNameservers', json_array(dest),
          'discovery', json_object('movement', json_object('day', day, 'currentNameservers', json_array(dest), 'source', 'daily-zone-delegation-diff'),
            'structurallyMoved', 1, 'departureDate', day, 'buyerUse', CASE WHEN site = 'built' THEN 1 ELSE 0 END,
            'homepage', CASE site WHEN 'built' THEN json_object('active', 1, 'status', 200, 'title', domain || ' home', 'text', substr(hex(zeroblob(${pad})), 1, ${pad}))
              WHEN 'parked' THEN json_object('parked', 1, 'status', 200, 'title', 'parked', 'text', substr(hex(zeroblob(${pad})), 1, ${pad}))
              WHEN 'inactive' THEN json_object('status', 404, 'text', substr(hex(zeroblob(${pad})), 1, ${pad})) ELSE NULL END)) END,
        day || 'T08:00:00Z', CASE WHEN indexed = 1 THEN domain ELSE NULL END
      FROM fx`);
    db.exec(`INSERT INTO ${search.DOCS_TABLE} (domain, name, site, theme, theme_terms, report_day, destination_key, expiry_origin, site_class, buyer_use, search_version, kit)
      SELECT domain, 'n ' || CASE WHEN i % 50 = 0 THEN 'inference' WHEN i % 13 = 0 THEN 'payroll' ELSE 'shop' END,
        CASE WHEN has_ev = 1 AND site = 'built' THEN 'a site we build for teams' ELSE '' END, '', '{}', day,
        CASE WHEN has_ev = 1 THEN dest ELSE '' END, CASE WHEN has_ev = 1 THEN expiry ELSE 0 END,
        CASE WHEN has_ev = 1 THEN site END, CASE WHEN has_ev = 1 AND site = 'built' THEN 1 ELSE 0 END, '${search.SEARCH_VERSION}', 0
      FROM fx WHERE indexed = 1`);
    const hot = db.prepare(`SELECT DISTINCT day FROM fx`).all().map(r => r.day);
    const imp = db.prepare('INSERT OR REPLACE INTO sale_watch_movement_imports VALUES (?, ?, ?, ?, ?, ?)');
    for (const day of hot) imp.run(day, `fx-${day}`, `${day}T09:00:00Z`, 5000, 1500, JSON.stringify({ day, departures: 5000, platformExcluded: 3000, expiryExcluded: 400, excludedByPolicy: 100, eligible: 1500, cursorComplete: true }));
    db.exec(`INSERT OR REPLACE INTO ${store.TABLE} (domain, version, assessed_at, dirty, eligible, tier, classification, report_date, evidence_rank, rationale, assessment_json, views)
      SELECT domain, '${VERSION}', day || 'T09:00:00Z', 0, 1, 'suspected', cls, day, CASE WHEN cls = 'likely-sale' THEN 0 ELSE 5 END, 'fixture',
        json_object('version', '${VERSION}', 'basis', 'fixture'), CASE WHEN cls = 'likely-sale' THEN 'all,leads,alpha,probable' ELSE 'all,leads' END
      FROM fx WHERE has_ev = 1`);
    for (const [view, where] of [['all', '1'], ['leads', '1'], ['alpha', "cls = 'likely-sale'"], ['probable', "cls = 'likely-sale'"]]) {
      db.exec(`INSERT OR REPLACE INTO ${store.VIEWS_TABLE} (view, report_date, evidence_rank, dlen, domain)
        SELECT '${view}', day, CASE WHEN cls = 'likely-sale' THEN 0 ELSE 5 END, length(domain), domain FROM fx WHERE has_ev = 1 AND ${where}`);
    }
    db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(store.META_READY, VERSION);
    db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES ('search_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(search.SEARCH_VERSION);
  })();
  db.exec('DROP TABLE temp.fx');
  const loadMs = Date.now() - t0;
  // Recreate every paused trigger through the real schema functions, then
  // build the maintained per-day census exactly as the worker does.
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  const censusStarted = Date.now();
  await cands.rebuildDestinationDays(db);
  const maintained = typeof cands.rebuildMaintainedTape === 'function' ? await cands.rebuildMaintainedTape(db) : null;
  const censusMs = Date.now() - censusStarted;
  if (opts.analyze) db.exec('ANALYZE');
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* best effort */ }
  db.close();
  return { file, rows: N, today, loadMs, censusMs, maintained, bytes: fs.statSync(file).size, ms: Date.now() - t0 };
}

module.exports = { buildTapeFixture, DEFAULTS };

if (require.main === module) {
  const rows = Number(process.argv[2]) || DEFAULTS.rows;
  const file = process.argv[3] || undefined;
  buildTapeFixture({ rows, file }).then(r => console.log(JSON.stringify(r)), e => { console.error(e); process.exitCode = 1; });
}
