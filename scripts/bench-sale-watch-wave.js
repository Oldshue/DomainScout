'use strict';

// Write cost of the maintained tape triggers on a wave-shaped batch.
//
// Usage: node scripts/bench-sale-watch-wave.js <sale_watch.db> [rows=10000] [repeats=3]
//
// Times the same batch of `rows` candidate upserts (evidence_json changed,
// probe_count/state moving as a probe pass moves them; a fifth are new
// inserts) and the same number of search-document upserts, once with every
// trigger the branch installs and once with the branch's new tape triggers
// dropped (the master baseline). Each run happens inside one transaction
// that is rolled back, so the file is unchanged and runs are comparable;
// commit/fsync cost is excluded, which overstates the relative overhead.
const Database = require('better-sqlite3');

const NEW_TRIGGER_PREFIXES = ['sale_watch_tape_day_v1_', 'sale_watch_tape_rescored_day_v1_', 'sale_watch_tape_doc_version_day_v1_', 'sale_watch_tape_missing_day_v1_', 'sale_watch_tape_doc_key_v1_'];

function bench(file, rows = 10000, repeats = 3) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all();
  const dropped = triggers.filter(t => NEW_TRIGGER_PREFIXES.some(p => t.name.startsWith(p))).map(t => t.name);
  const existing = db.prepare(`SELECT domain FROM sale_watch_candidates WHERE rowid % 97 = 5 LIMIT ${Math.floor(rows * 0.8)}`).all().map(r => r.domain);
  const docDomains = db.prepare(`SELECT domain FROM sale_watch_search_docs WHERE id % 89 = 3 LIMIT ${rows}`).all().map(r => r.domain);
  const today = new Date().toISOString().slice(0, 10);
  const pad = 'x'.repeat(2400);
  const evidence = (domain, i) => JSON.stringify({ tier: 'suspected', reportDate: today, classification: 'seller-departure',
    sellerNameservers: ['ns1.dan.com', 'ns2.dan.com'], buyerNameservers: [`ns1.wave${i % 300}.example`],
    discovery: { movement: { day: today, currentNameservers: [`ns1.wave${i % 300}.example`], source: 'daily-zone-delegation-diff' },
      departureDate: today, buyerUse: i % 3 === 0 ? 1 : 0, homepage: { active: 1, status: 200, title: `${domain} wave`, text: pad } } });
  const upsert = db.prepare(`INSERT INTO sale_watch_candidates (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at, search_text)
    VALUES (@domain, @day, @day, 'zone-seller-departure', @day, 'exited', @day, 0, @evidence, @at, NULL)
    ON CONFLICT(domain) DO UPDATE SET evidence_json = excluded.evidence_json, updated_at = excluded.updated_at,
      probe_count = probe_count + 1, state = CASE WHEN @flip = 1 THEN 'probing' ELSE state END,
      outcome = CASE WHEN @flip = 1 THEN NULL ELSE outcome END`);
  const docUpsert = db.prepare(`INSERT INTO sale_watch_search_docs (domain, name, site, theme, theme_terms, report_day, destination_key, expiry_origin, site_class, buyer_use, search_version, kit)
    VALUES (@domain, 'wave name', @site, '', '{}', @day, @dest, 0, @siteClass, @buyerUse, @version, 0)
    ON CONFLICT(domain) DO UPDATE SET name = excluded.name, site = excluded.site, theme = excluded.theme, theme_terms = excluded.theme_terms,
      report_day = excluded.report_day, destination_key = excluded.destination_key, expiry_origin = excluded.expiry_origin,
      site_class = excluded.site_class, buyer_use = excluded.buyer_use, search_version = excluded.search_version, kit = excluded.kit`);
  const at = new Date().toISOString();
  const candidateBatch = () => {
    existing.forEach((domain, i) => upsert.run({ domain, day: today, evidence: evidence(domain, i), at, flip: i % 4 === 0 ? 1 : 0 }));
    for (let i = existing.length; i < rows; i += 1) { const domain = `wave${i}new.com`; upsert.run({ domain, day: today, evidence: evidence(domain, i), at, flip: 0 }); }
  };
  const docBatch = () => docDomains.forEach((domain, i) => docUpsert.run({ domain, day: today, site: 'wave site', dest: `ns1.wave${i % 300}.example`,
    siteClass: i % 2 ? 'built' : 'parked', buyerUse: i % 2, version: i % 5 === 0 ? 'wave-old' : 'wave-v' }));
  const timed = (fn, withoutNew) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (withoutNew) for (const name of dropped) db.exec(`DROP TRIGGER "${name}"`);
      const t = process.hrtime.bigint();
      fn();
      return Number(process.hrtime.bigint() - t) / 1e6;
    } finally { db.exec('ROLLBACK'); }
  };
  const result = { file, rows, candidateRows: rows, existingUpdated: existing.length, docRows: docDomains.length, droppedTriggers: dropped, runs: [] };
  timed(candidateBatch, false); // warm the page cache once
  for (let r = 0; r < repeats; r += 1) {
    result.runs.push({
      candidatesBaselineMs: timed(candidateBatch, true), candidatesWithTriggersMs: timed(candidateBatch, false),
      docsBaselineMs: timed(docBatch, true), docsWithTriggersMs: timed(docBatch, false),
    });
  }
  const med = k => { const v = result.runs.map(x => x[k]).sort((a, b) => a - b); return Math.round(v[Math.floor(v.length / 2)]); };
  result.median = { candidatesBaselineMs: med('candidatesBaselineMs'), candidatesWithTriggersMs: med('candidatesWithTriggersMs'), docsBaselineMs: med('docsBaselineMs'), docsWithTriggersMs: med('docsWithTriggersMs') };
  const m = result.median;
  result.overheadPct = { candidates: Math.round(1000 * (m.candidatesWithTriggersMs / m.candidatesBaselineMs - 1)) / 10, docs: Math.round(1000 * (m.docsWithTriggersMs / m.docsBaselineMs - 1)) / 10 };
  db.close();
  return result;
}

module.exports = { bench, NEW_TRIGGER_PREFIXES };

if (require.main === module) {
  console.log(JSON.stringify(bench(process.argv[2], Number(process.argv[3]) || 10000, Number(process.argv[4]) || 3), null, 1));
}
