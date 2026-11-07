'use strict';

// Builds a file-backed sale_watch.db with large evidence rows for the
// candidate-keys backfill rate test (tests/sale-watch-candidate-keys-backfill-rate.test.js)
// and for manual measurement: node tests/fixtures/candidate-keys-bench.js <rows>.
// Evidence values are synthetic and provider-neutral.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function bigEvidence(i, padBytes) {
  const seller = i % 50 === 0;
  return JSON.stringify({
    classification: i % 97 === 0 ? 'likely-sale' : (i % 31 === 0 ? 'portfolio-kit' : 'moved'),
    reportDate: '2026-11-0' + (1 + (i % 7)),
    assessment: { classification: i % 89 === 0 ? 'likely-sale' : null, delegation: { sellerOrigin: seller ? 1 : 0 } },
    discovery: {
      buyerUse: i % 113 === 0 ? 1 : 0,
      rdapCheckedAt: i % 3 === 0 ? '2026-11-06T00:00:00.000Z' : null,
      rdap: i % 5 === 0 ? { checkedAt: '2026-11-05T00:00:00.000Z', statuses: i % 10 === 0 ? ['client transfer prohibited', 'pending transfer'] : ['ok'] } : undefined,
      movement: { previousClass: seller ? 'seller' : 'parking', cohortSize: i % 4 === 0 ? 12 : 1, currentNameservers: ['NS1.EXAMPLE-HOST.NET.', 'ns2.example-host.net'] },
      kit: i % 7 === 0 ? { key: 'kit-' + (i % 13) } : undefined,
      page: { html: 'x'.repeat(padBytes) },
    },
  });
}

/** Creates the schema and `rows` candidates whose evidence is ~padBytes each. */
function buildCandidatesDb({ rows = 20000, padBytes = 8000, dir = null } = {}) {
  const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'sw-keys-bench-'));
  const file = path.join(root, 'sale_watch.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS sale_watch_candidates (
      domain TEXT PRIMARY KEY, first_seen_day TEXT, last_seen_day TEXT, last_stream TEXT, last_price REAL,
      exit_observed_day TEXT, state TEXT NOT NULL DEFAULT 'exited', next_probe_at TEXT, probe_count INTEGER NOT NULL DEFAULT 0,
      outcome TEXT, outcome_tier TEXT, evidence_json TEXT, updated_at TEXT, probe_priority INTEGER);
    CREATE TABLE IF NOT EXISTS sale_watch_assessments (domain TEXT PRIMARY KEY, classification TEXT) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS sale_watch_meta (key TEXT PRIMARY KEY, value TEXT);`);
  const ins = db.prepare(`INSERT INTO sale_watch_candidates(domain, last_stream, exit_observed_day, state, next_probe_at, probe_count, probe_priority, evidence_json)
    VALUES(?, 'zone-seller-departure', ?, ?, ?, ?, ?, ?)`);
  const insA = db.prepare('INSERT INTO sale_watch_assessments(domain, classification) VALUES(?, ?)');
  const fill = db.transaction((from, to) => {
    for (let i = from; i < to; i += 1) {
      const domain = `fixture-name-${i}.${['com', 'net', 'io', 'xyz'][i % 4]}`;
      ins.run(domain, '2026-11-0' + (1 + (i % 7)), i % 9 === 0 ? 'sold' : 'exited', i % 9 === 0 ? null : '2026-11-08T00:00:00.000Z', i % 3, i % 11, i % 401 === 0 ? '{not json' : bigEvidence(i, padBytes));
      if (i % 17 === 0) insA.run(domain, i % 34 === 0 ? 'likely-sale' : 'moved');
    }
  });
  for (let i = 0; i < rows; i += 5000) fill(i, Math.min(rows, i + 5000));
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { db, file, root };
}

module.exports = { buildCandidatesDb, bigEvidence };

if (require.main === module) {
  (async () => {
    const rows = Number(process.argv[2]) || 20000;
    const { db, file, root } = buildCandidatesDb({ rows });
    db.close();
    const handle = new Database(file);
    handle.pragma('busy_timeout = 15000');
    const K = require('../../server/sale-watch-candidate-keys');
    const t = Date.now();
    const result = await K.backfillCandidateKeys(handle, {});
    const ms = Date.now() - t;
    console.log(JSON.stringify({ rows, ms, rowsPerSec: Math.round(rows * 1000 / Math.max(1, ms)), result: { ...result, ms: undefined } }));
    handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  })().catch(e => { console.error(e); process.exit(1); });
}
