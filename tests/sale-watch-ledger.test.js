'use strict';

// Sale Watch ledger (server/sale-watch-ledger.js): the complete record of
// seller departures by day. Every name that left a marketplace or parking
// nameserver is one row with a verdict; nothing is dropped by a strength gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const recon = require('../server/sale-watch-reconstruction');
const store = require('../server/sale-watch-assessments');
const ledger = require('../server/sale-watch-ledger');
const evidence = require('../server/sale-watch-evidence');
const insights = require('../server/sale-watch-insights');

const NOW = new Date('2026-11-25T12:00:00Z');
const day = n => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);

function buildDb() {
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  return db;
}

// A seller departure exactly as the movement import stores it: seller
// nameservers before, an ordinary host after, no RDAP, no homepage probe.
function departure(domain, daysAgo, extra = {}) {
  const d = day(daysAgo);
  const after = extra.after || ['ns1.example-host.net', 'ns2.example-host.net'];
  return {
    domain, tier: 'suspected', sellerNameservers: extra.before || ['ns1.afternic.com', 'ns2.afternic.com'], buyerNameservers: after, reportDate: d, venue: 'Afternic',
    lastObservedAt: NOW.toISOString(),
    discovery: { structurallyMoved: true, departureDate: d, movement: { day: d, prevDay: day(daysAgo + 1), currentClass: extra.currentClass || 'other', currentNameservers: after, cohortSize: extra.cohortSize || 1 }, ...(extra.discovery || {}) },
  };
}

function insertCandidate(db, entry, { updatedAt = NOW.toISOString() } = {}) {
  db.prepare(`INSERT INTO sale_watch_candidates(domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, probe_count, evidence_json, updated_at)
    VALUES(?, ?, ?, 'zone-seller-departure', ?, 'exited', 0, ?, ?)`).run(entry.domain, entry.reportDate, entry.reportDate, entry.reportDate, JSON.stringify(entry), updatedAt);
}

function read(db, query = {}) {
  return ledger.readLedgerDaily(db, ledger.normalizeLedgerQuery({ window: '30', ...query }, { now: NOW }));
}
const names = page => page.days.flatMap(d => d.rows.map(r => r.domain));

test('reproduction: a seller departure with no transfer record and no site is in the ledger and is found by a word in its name', () => {
  const db = buildDb();
  insertCandidate(db, departure('matrixinference.com', 8));
  store.storeAssessmentsSync(db, { now: NOW });
  const stored = db.prepare('SELECT classification, views, ledger_id FROM sale_watch_assessments WHERE domain = ?').get('matrixinference.com');
  // Day 8: past the 3-day early-lead window, short of the 14-day off-market
  // rule. No transfer, no site: the lead feed's strong views do not hold it.
  assert.equal(stored.classification, 'unconfirmed-move');
  for (const view of insights.LEDGER_VIEWS) assert.ok(!String(stored.views).split(',').includes(view), `not in the feed view ${view}`);
  assert.ok(Number.isInteger(stored.ledger_id), 'it holds a ledger row');

  const all = read(db, { verdict: 'all' });
  assert.deepEqual(names(all), ['matrixinference.com']);
  const row = all.days[0].rows[0];
  assert.deepEqual({ day: row.day, verdict: row.verdict, classification: row.classification, source: row.source }, { day: day(8), verdict: 'unknown', classification: 'unconfirmed-move', source: 'assessment' });

  // The default verdicts (sold + lead) do not list it, and still count it.
  const def = read(db);
  assert.deepEqual(def.verdicts, ['sold', 'lead']);
  assert.deepEqual(names(def), []);
  assert.equal(def.days[0].counts.unknown, 1);
  assert.equal(def.window.totals.unknown, 1);

  // Found by a word in its name.
  for (const q of ['inference', 'matrix', 'Inference', 'matrixinference']) {
    const hit = read(db, { verdict: 'all', q });
    assert.deepEqual(names(hit), ['matrixinference.com'], `q=${q}`);
  }
  assert.deepEqual(names(read(db, { verdict: 'all', q: 'infer' })), [], 'whole words only');
  db.close();
});

test('every classification maps to exactly one verdict group; a name that never left a seller has none', () => {
  const groups = {
    sold: ['likely-sale', 'transferred-and-built', 'transfer-completed', 'reported-sale'],
    lead: ['acquisition-candidate', 'seller-departure', 'transfer-in-progress'],
    moved: ['platform-destination', 'lander-migration'],
    expired: ['expiration'],
    unknown: ['unconfirmed-move', 'registry-hold'],
    portfolio: ['portfolio-kit'],
  };
  assert.deepEqual(Object.keys(groups), ledger.VERDICTS);
  const seller = ['ns1.afternic.com', 'ns2.afternic.com'];
  for (const [verdict, list] of Object.entries(groups)) {
    for (const classification of list) {
      assert.equal(evidence.ledgerVerdict({ classification, sellerNameservers: seller }), verdict, classification);
      assert.ok(ledger.CLASSIFICATIONS.includes(classification), `${classification} has a stored code`);
    }
  }
  assert.equal(evidence.ledgerVerdict({ classification: 'likely-sale', sellerNameservers: ['ns01.domaincontrol.com'] }), null, 'registrar-default origin is not a seller departure');
  assert.equal(evidence.ledgerVerdict({ classification: 'likely-sale', sellerNameservers: [] }), null);
  assert.equal(evidence.ledgerVerdict({ classification: 'no-seller-origin', sellerNameservers: seller }), null);
  assert.equal(evidence.ledgerVerdict({ classification: 'owner-migration', sellerNameservers: seller }), null);
  assert.deepEqual(ledger.parseVerdicts(''), ['sold', 'lead'], 'default: sold + probably sold and leads');
  assert.deepEqual(ledger.parseVerdicts('expired,sold'), ['sold', 'expired']);
  assert.deepEqual(ledger.parseVerdicts('all'), ledger.VERDICTS);
  assert.throws(() => ledger.parseVerdicts('sold,nope'), ledger.LedgerQueryError);
});

test('the ledger holds every stored verdict at once: sold, lead, unknown, portfolio, expired; one row per name', () => {
  const db = buildDb();
  insertCandidate(db, departure('modalinference.com', 20, { currentClass: 'registrar', after: ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'] })); // off-market 20 days -> likely-sale
  insertCandidate(db, departure('obsidianinference.com', 1)); // fresh departure -> seller-departure (lead)
  insertCandidate(db, departure('inferencesoc.com', 8)); // unconfirmed
  insertCandidate(db, departure('batchinference.com', 8, { cohortSize: 40 })); // portfolio-kit
  insertCandidate(db, departure('lapsedinference.com', 8, { after: ['ns1.pendingrenewaldeletion.com', 'ns2.pendingrenewaldeletion.com'] })); // expiry host
  insertCandidate(db, { domain: 'ownermove.com', tier: 'suspected', sellerNameservers: ['ns01.domaincontrol.com'], buyerNameservers: ['a.ns.example.net'], reportDate: day(8), lastObservedAt: NOW.toISOString(), discovery: { structurallyMoved: true, departureDate: day(8), movement: { day: day(8), currentClass: 'other', currentNameservers: ['a.ns.example.net'] } } });
  store.storeAssessmentsSync(db, { now: NOW });
  const all = read(db, { verdict: 'all' });
  const byName = Object.fromEntries(all.days.flatMap(d => d.rows).map(r => [r.domain, r.verdict]));
  assert.deepEqual(byName, {
    'modalinference.com': 'sold', 'obsidianinference.com': 'lead', 'inferencesoc.com': 'unknown', 'batchinference.com': 'portfolio', 'lapsedinference.com': 'expired',
  });
  assert.equal(byName['ownermove.com'], undefined, 'a registrar-default origin never left a seller');
  assert.deepEqual(all.window.totals, { sold: 1, lead: 1, moved: 0, expired: 1, unknown: 1, portfolio: 1 });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n, 5);

  // verdict= filters the rows; the counts stay whole.
  const sold = read(db, { verdict: 'sold' });
  assert.deepEqual(names(sold), ['modalinference.com']);
  assert.deepEqual(sold.window.totals, all.window.totals);

  // q=inference: names with the word, never site wording, sold first within a day.
  const found = read(db, { verdict: 'all', q: 'inference' });
  assert.deepEqual(names(found).sort(), ['batchinference.com', 'inferencesoc.com', 'lapsedinference.com', 'modalinference.com', 'obsidianinference.com']);
  assert.deepEqual(found.search.matchCounts, { sold: 1, lead: 1, moved: 0, expired: 1, unknown: 1, portfolio: 1 });
  assert.equal(found.search.matches, 5);
  db.close();
});

test('name-word search matches the name only: a site about inference under another name is not returned', () => {
  const db = buildDb();
  for (const name of ['matrixinference.com', 'modalinference.com', 'obsidianinference.com', 'inferencesoc.com']) insertCandidate(db, departure(name, 8));
  insertCandidate(db, departure('bluewidget.com', 8, { discovery: { homepage: { title: 'Inference platform for AI inference', status: 200 }, buyerUse: true } }));
  insertCandidate(db, departure('interference.com', 8));
  store.storeAssessmentsSync(db, { now: NOW });
  const hit = read(db, { verdict: 'all', q: 'inference' });
  assert.deepEqual(names(hit).sort(), ['inferencesoc.com', 'matrixinference.com', 'modalinference.com', 'obsidianinference.com']);
  assert.deepEqual(hit.search.words, ['inference']);
  // Two words: both must be in the name.
  assert.deepEqual(names(read(db, { verdict: 'all', q: 'matrix inference' })), ['matrixinference.com']);
  db.close();
});

test('a verdict change moves the row; a deleted candidate leaves the ledger; counts and words follow', () => {
  const db = buildDb();
  insertCandidate(db, departure('modalinference.com', 13, { currentClass: 'registrar', after: ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'] }));
  store.storeAssessmentsSync(db, { now: NOW });
  const dayn = ledger.dayNumber(day(13));
  assert.deepEqual(names(read(db, { verdict: 'unknown' })), ['modalinference.com'], 'day 13: not yet off-market for 14 days');
  const firstId = db.prepare('SELECT ledger_id AS id FROM sale_watch_assessments').get().id;

  // Two days later the 14-day off-market rule makes it a likely sale.
  const later = new Date(NOW.getTime() + 2 * 86400000);
  store.storeAssessmentsSync(db, { now: later });
  const rows = db.prepare(`SELECT id, verdict FROM ${ledger.TABLE}`).all();
  assert.equal(rows.length, 1, 'one row per name');
  assert.equal(ledger.VERDICTS[rows[0].verdict], 'sold');
  assert.notEqual(rows[0].id, firstId);
  assert.deepEqual(db.prepare(`SELECT n0, n4 FROM ${ledger.DAYS_TABLE} WHERE dayn = ?`).get(dayn), { n0: 1, n4: 0 });
  assert.deepEqual(db.prepare(`SELECT word, n0, n4 FROM ${ledger.WORDS_TABLE} ORDER BY word`).all(), [{ word: 'inference', n0: 1, n4: 0 }, { word: 'modal', n0: 1, n4: 0 }]);

  // Re-assessing with nothing changed writes nothing new.
  db.prepare("UPDATE sale_watch_assessments SET dirty = 1").run();
  store.storeAssessmentsSync(db, { now: later });
  assert.equal(db.prepare(`SELECT id FROM ${ledger.TABLE}`).get().id, rows[0].id);

  db.prepare('DELETE FROM sale_watch_candidates WHERE domain = ?').run('modalinference.com');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.DAYS_TABLE}`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.WORDS_TABLE}`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.FTS_TABLE} WHERE ${ledger.FTS_TABLE} MATCH 'inference'`).get().n, 0);
  db.close();
});

test('paging: every row is returned once across cursors, days newest first, shortest names first inside a verdict', () => {
  const db = buildDb();
  ledger.ensureLedgerSchema(db);
  const total = ledger.PAGE_ROWS * 2 + 37;
  db.transaction(() => {
    for (let i = 0; i < total; i += 1) {
      ledger.writeLedgerRow(db, { domain: `${'x'.repeat(3 + (i % 9))}${i}moved.com`, day: day(1 + (i % 3)), verdict: i % 5 === 0 ? 'sold' : 'moved', classification: i % 5 === 0 ? 'likely-sale' : 'platform-destination', src: ledger.SRC_IMPORT, now: NOW });
    }
  })();
  const seen = [];
  let cursor = '';
  let pages = 0;
  for (;;) {
    const page = read(db, { verdict: 'sold,moved', ...(cursor ? { cursor } : {}) });
    pages += 1;
    const rows = page.days.flatMap(d => d.rows);
    assert.ok(rows.length <= ledger.PAGE_ROWS);
    for (const d of page.days) {
      // Sold before moved inside a day, shortest names first inside a verdict.
      const order = d.rows.map(r => ledger.VERDICTS.indexOf(r.verdict) * 1000 + r.domain.length);
      assert.deepEqual(order, order.slice().sort((a, b) => a - b), `order within ${d.day}`);
    }
    seen.push(...rows.map(r => `${r.day}|${r.domain}`));
    cursor = page.pagination.nextCursor;
    if (!cursor) break;
    assert.ok(pages < 10);
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total, 'no row twice');
  const days = seen.map(s => s.split('|')[0]);
  assert.deepEqual(days, days.slice().sort().reverse(), 'days newest first');
  assert.throws(() => ledger.normalizeLedgerQuery({ window: '30', verdict: 'sold', cursor: read(db, { verdict: 'sold,moved' }).pagination.nextCursor }, { now: NOW }), /different query/);
  db.close();
});

test('trend: per-day and per-week counts of names holding a word, by verdict; rising words need a minimum count', () => {
  const db = buildDb();
  ledger.ensureLedgerSchema(db);
  const add = (domain, daysAgo, verdict) => ledger.writeLedgerRow(db, { domain, day: day(daysAgo), verdict, classification: verdict === 'sold' ? 'likely-sale' : verdict === 'moved' ? 'platform-destination' : 'unconfirmed-move', now: NOW });
  // "inference": 4 sold in the last 7 days, 1 sold in the 21 before; plus other verdicts.
  ['matrixinference.com', 'modalinference.com', 'obsidianinference.com', 'inferencesoc.com'].forEach((d, i) => add(d, 1 + i, 'sold'));
  add('oldinference.com', 20, 'sold');
  add('parkedinference.com', 2, 'moved');
  add('quietinference.com', 30, 'unknown');
  // "solar": steady (3 recent, 9 prior -> no rise). "widget": 2 recent only (below the minimum).
  for (let i = 0; i < 3; i += 1) add(`solar${['panel', 'roof', 'farm'][i]}.com`, 1 + i, 'sold');
  for (let i = 0; i < 9; i += 1) add(`solar${['home', 'kit', 'grid', 'city', 'bank', 'lab', 'hub', 'box', 'ray'][i]}.com`, 8 + i * 2, 'sold');
  add('widgetshop.com', 1, 'sold'); add('widgetbox.com', 2, 'sold');

  const trend = ledger.readLedgerTrend(db, { q: 'Inference', days: '35', now: NOW });
  assert.equal(trend.q, 'inference');
  assert.equal(trend.byDay.length, 35);
  assert.deepEqual(trend.totals, { sold: 5, lead: 0, moved: 1, expired: 0, unknown: 1, portfolio: 0 });
  const dayRow = trend.byDay.find(d => d.day === day(2));
  assert.deepEqual({ sold: dayRow.sold, moved: dayRow.moved, total: dayRow.total }, { sold: 1, moved: 1, total: 2 });
  assert.equal(trend.byWeek.reduce((n, w) => n + w.sold, 0), 5);
  assert.equal(trend.byWeek.reduce((n, w) => n + w.days, 0), 35);
  for (const w of trend.byWeek) assert.equal(new Date(`${w.week}T00:00:00Z`).getUTCDay(), 1, 'weeks start on Monday');
  assert.throws(() => ledger.normalizeTrendQuery({ q: 'two words' }), ledger.LedgerQueryError);
  assert.throws(() => ledger.normalizeTrendQuery({ q: 'inference', days: '91' }), ledger.LedgerQueryError);

  const rising = ledger.computeRising(db, { now: NOW });
  assert.deepEqual({ days: rising.days, recentDays: rising.recentDays, priorDays: rising.priorDays, minCount: rising.minCount }, { days: 28, recentDays: 7, priorDays: 21, minCount: 3 });
  assert.equal(rising.words[0].word, 'inference');
  assert.deepEqual({ recent: rising.words[0].recent, prior: rising.words[0].prior }, { recent: 4, prior: 1 });
  const listed = rising.words.map(w => w.word);
  assert.ok(!listed.includes('solar'), 'a steady word is not rising');
  assert.ok(!listed.includes('widget'), 'below the minimum count');
  assert.ok(!listed.includes('parked'), 'only sold + probably sold names count');

  // The worker stores the list; the route reads the stored row.
  ledger.storeRising(db, { now: NOW });
  const served = ledger.readLedgerRising(db, { now: NOW });
  assert.equal(served.source, 'stored');
  assert.equal(served.words[0].word, 'inference');
  assert.equal(ledger.readLedgerRising(db, { days: '56', now: NOW }).source, 'live');
  db.close();
});

test('completeness: each day carries the import\'s recorded departures and the ledger rows, and a mismatch is visible', () => {
  const db = buildDb();
  ledger.ensureLedgerSchema(db);
  const put = (d, departures, summary) => db.prepare('INSERT INTO sale_watch_movement_imports VALUES(?,?,?,?,?,?)').run(d, 'sig', NOW.toISOString(), departures, summary.eligible || 0, JSON.stringify(summary));
  put(day(1), 5, { zones: 1069, eligible: 2, platformExcluded: 1, expiryExcluded: 1, excludedByPolicy: 1 });
  put(day(2), 3, { zones: 1069, eligible: 3, platformExcluded: 0, expiryExcluded: 0, excludedByPolicy: 0 });
  // Day 1: all four expected rows are in the ledger. Day 2: one of three is missing.
  ['a1one.com', 'a2two.com'].forEach(d => ledger.writeLedgerRow(db, { domain: d, day: day(1), verdict: 'unknown', classification: 'unconfirmed-move', now: NOW }));
  ledger.recordImportDeparture(db, { domain: 'a3three.com', day: day(1), verdict: 'moved', classification: 'platform-destination', dest: 'Sedo', now: NOW });
  ledger.recordImportDeparture(db, { domain: 'a4four.com', day: day(1), verdict: 'expired', classification: 'expiration', now: NOW });
  ['b1one.com', 'b2two.com'].forEach(d => ledger.writeLedgerRow(db, { domain: d, day: day(2), verdict: 'unknown', classification: 'unconfirmed-move', now: NOW }));
  const page = read(db, { verdict: 'all' });
  const d1 = page.days.find(d => d.day === day(1));
  const d2 = page.days.find(d => d.day === day(2));
  assert.deepEqual({ recorded: d1.completeness.recorded, policyExcluded: d1.completeness.policyExcluded, expected: d1.completeness.expected, ledger: d1.completeness.ledger, difference: d1.completeness.difference },
    { recorded: 5, policyExcluded: 1, expected: 4, ledger: 4, difference: 0 });
  assert.equal(d1.ledgerRows, 4);
  assert.deepEqual({ recorded: d2.completeness.recorded, ledger: d2.completeness.ledger, difference: d2.completeness.difference }, { recorded: 3, ledger: 2, difference: 1 });
  // No complete stored-assessment pass yet on this database: the missing row reads as not assessed yet.
  assert.deepEqual(page.window.completeness, { recorded: 8, policyExcluded: 1, expected: 7, ledger: 6, difference: 1, daysWithImport: 2, daysMismatched: 1, daysWithoutImport: 0,
    waiting: 0, notYetAssessed: 1, missing: 0, daysNotReadmitted: 2, daysWithoutTape: 0 });
  assert.equal(d2.completeness.notYetAssessed, 1);
  // Once the stored assessments are complete on the current rules, the same difference is a missing row.
  db.prepare("INSERT INTO sale_watch_meta(key, value) VALUES('assessment_store', ?)").run(JSON.stringify({ version: evidence.VERSION, completeAt: NOW.toISOString(), rows: 4 }));
  const settled = read(db, { verdict: 'all' });
  assert.deepEqual([settled.window.completeness.notYetAssessed, settled.window.completeness.missing], [0, 1]);
  assert.equal(settled.window.assessment.rebuilding, false);
  assert.equal(d1.rows.find(r => r.domain === 'a3three.com').dest, 'Sedo');
  assert.equal(d1.rows.find(r => r.domain === 'a3three.com').source, 'import');
  db.close();
});

function writeTape(dir, d, rows) {
  const folder = path.join(dir, d, 'ns');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'movement.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ day: d, prevDay: day(99), zones: 1069, departures: rows.length }));
}
const tapeRows = () => [
  { domain: 'boughtinference.com', selection: 'departures', prev_class: 'seller', today_class: 'hosting', prev_provider: 'Afternic', prev_ns: ['ns1.afternic.com', 'ns2.afternic.com'], today_ns: ['ns1.buyer-host.net', 'ns2.buyer-host.net'] },
  { domain: 'relistedinference.com', selection: 'departures', prev_class: 'seller', today_class: 'seller', prev_provider: 'Afternic', prev_ns: ['ns1.afternic.com', 'ns2.afternic.com'], today_ns: ['ns1.sedoparking.com', 'ns2.sedoparking.com'] },
  { domain: 'lapsedinference.com', selection: 'departures', prev_class: 'seller', today_class: 'other', prev_provider: 'Afternic', prev_ns: ['ns1.afternic.com', 'ns2.afternic.com'], today_ns: ['ns1.pendingrenewaldeletion.com', 'ns2.pendingrenewaldeletion.com'] },
];

test('movement import: departures it does not admit (platform, expiry) are recorded in the ledger; re-import adds nothing', async () => {
  const db = buildDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ledger-'));
  const d = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  writeTape(dir, d, tapeRows());
  await recon.ingestMovementCandidates(db, { directory: dir, indexSearch: false });
  const rows = db.prepare(`SELECT domain, verdict, src, dest FROM ${ledger.TABLE} ORDER BY domain`).all().map(r => ({ ...r, verdict: ledger.VERDICTS[r.verdict] }));
  // Every departure of the day is in the ledger when the import ends: the two it
  // does not admit, and the admitted one as 'unknown', waiting for its assessment.
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => [r.domain, r.verdict, r.src]), [['boughtinference.com', 'unknown', ledger.SRC_IMPORT], ['lapsedinference.com', 'expired', ledger.SRC_IMPORT], ['relistedinference.com', 'moved', ledger.SRC_IMPORT]]);
  assert.match(String(rows[2].dest), /sedo/i);
  assert.equal(rows[0].dest, 'buyer-host.net');
  assert.equal(db.prepare(`SELECT w FROM ${ledger.DAYS_TABLE}`).get().w, 1, 'one row waits for its assessment');
  assert.ok(ledger.importDayMarked(db, d));
  // The admitted departure becomes a candidate; its ledger row comes with its assessment.
  assert.ok(db.prepare('SELECT 1 FROM sale_watch_candidates WHERE domain = ?').get('boughtinference.com'));
  store.storeAssessmentsSync(db);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n, 3);
  assert.equal(db.prepare(`SELECT w FROM ${ledger.DAYS_TABLE}`).get().w, 0, 'the assessment took the waiting row over');
  assert.deepEqual(db.prepare(`SELECT src, dest FROM ${ledger.TABLE} WHERE domain = 'boughtinference.com'`).get(), { src: ledger.SRC_ASSESSMENT, dest: 'buyer-host.net' });
  const imported = db.prepare('SELECT departures, summary_json FROM sale_watch_movement_imports WHERE day = ?').get(d);
  const page = ledger.readLedgerDaily(db, ledger.normalizeLedgerQuery({ verdict: 'all', window: '14' }));
  const dayRow = page.days.find(x => x.day === d);
  assert.equal(imported.departures, 3);
  assert.equal(dayRow.completeness.recorded, 3);
  assert.equal(dayRow.completeness.difference, 0, 'every recorded departure is in the ledger');

  // A re-import (a later zone fragment changes the day's signature) is idempotent.
  fs.utimesSync(path.join(dir, d, 'ns', 'movement.jsonl'), new Date(), new Date(Date.now() + 5000));
  await recon.ingestMovementCandidates(db, { directory: dir, indexSearch: false });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n, 3);
  assert.equal(db.prepare(`SELECT n2 + n3 AS n FROM ${ledger.DAYS_TABLE}`).get().n, 2);
  fs.rmSync(dir, { recursive: true });
  db.close();
});

test('backfill: a day imported before the ledger existed gets its platform and expiry departures from the tape still on disk', async () => {
  const db = buildDb();
  ledger.ensureLedgerSchema(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ledger-'));
  const onDisk = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const gone = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  writeTape(dir, onDisk, tapeRows());
  for (const d of [onDisk, gone]) db.prepare('INSERT INTO sale_watch_movement_imports VALUES(?,?,?,?,?,?)').run(d, 'old', new Date().toISOString(), 3, 1, '{}');
  const result = await ledger.maintainLedger(db, { directory: dir, log: null });
  assert.deepEqual(result.backfill, { days: 1, rows: 2, missingTapes: 1 });
  assert.deepEqual(db.prepare(`SELECT domain FROM ${ledger.TABLE} ORDER BY domain`).all().map(r => r.domain), ['lapsedinference.com', 'relistedinference.com']);
  // Marked: the next pass does not read the tape again.
  assert.deepEqual((await ledger.maintainLedger(db, { directory: dir, log: null })).backfill, { days: 0, rows: 0, missingTapes: 0 });
  fs.rmSync(dir, { recursive: true });
  db.close();
});

test('retention: rows older than the window are pruned in batches and the derived tables follow', async () => {
  const db = buildDb();
  ledger.ensureLedgerSchema(db);
  const old = new Date(NOW.getTime() - (ledger.RETENTION_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  for (let i = 0; i < 25; i += 1) ledger.writeLedgerRow(db, { domain: `oldname${i}.com`, day: old, verdict: 'moved', classification: 'platform-destination', now: NOW });
  ledger.writeLedgerRow(db, { domain: 'freshname.com', day: day(1), verdict: 'sold', classification: 'likely-sale', now: NOW });
  assert.equal(ledger.writeLedgerRow(db, { domain: 'ancient.com', day: '2025-01-01', verdict: 'sold', classification: 'likely-sale', now: NOW }), null, 'older than retention: never written');
  const later = new Date(NOW.getTime() + 5 * 86400000);
  const pruned = await ledger.pruneLedger(db, { now: later, batch: 10 });
  assert.equal(pruned.deleted, 25);
  assert.deepEqual(db.prepare(`SELECT domain FROM ${ledger.TABLE}`).all(), [{ domain: 'freshname.com' }]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.DAYS_TABLE}`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.WORDS_TABLE} WHERE word LIKE 'oldname%' OR word = 'old'`).get().n, 0);
  db.close();
});

test('size bound: over the row budget the oldest days give up their moved and expired rows, never sold or lead rows', async () => {
  const db = buildDb();
  ledger.ensureLedgerSchema(db);
  for (let d = 2; d <= 6; d += 1) {
    for (let i = 0; i < 20; i += 1) ledger.recordImportDeparture(db, { domain: `bulk${d}x${i}.com`, day: day(d), verdict: i % 2 ? 'moved' : 'expired', classification: i % 2 ? 'platform-destination' : 'expiration', now: NOW });
    ledger.writeLedgerRow(db, { domain: `soldname${d}.com`, day: day(d), verdict: 'sold', classification: 'likely-sale', now: NOW });
    db.prepare('INSERT INTO sale_watch_movement_imports VALUES(?,?,?,?,?,?)').run(day(d), 'sig', NOW.toISOString(), 21, 1, '{}');
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n, 105);
  const pruned = await ledger.pruneLedger(db, { now: NOW, maxRows: 70, batch: 7 });
  // Two oldest days (6 and 5 days ago) lose 20 bulk rows each: 105 -> 65.
  assert.equal(pruned.trimmedDays, 2);
  assert.equal(pruned.deleted, 40);
  assert.equal(pruned.bulkFloor, ledger.dayNumber(day(4)));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n, 65);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE} WHERE verdict = 0`).get().n, 5, 'every sold row is kept');
  // A later write of a trimmed day's bulk row is refused; its sold rows are still written.
  assert.equal(ledger.recordImportDeparture(db, { domain: 'latebulk.com', day: day(6), verdict: 'moved', classification: 'platform-destination', now: NOW }), null);
  assert.ok(ledger.writeLedgerRow(db, { domain: 'latesold.com', day: day(6), verdict: 'sold', classification: 'likely-sale', now: NOW }));
  // The page says which days were trimmed instead of reporting them as a mismatch.
  const page = read(db, { verdict: 'all' });
  assert.equal(page.window.bulkKeptFrom, day(4));
  assert.equal(page.window.completeness.daysTrimmed, 2);
  assert.equal(page.window.completeness.daysMismatched, 0);
  assert.equal(page.days.find(d => d.day === day(6)).completeness.trimmed, true);
  assert.equal(page.days.find(d => d.day === day(3)).completeness.difference, 0);
  assert.equal((await ledger.pruneLedger(db, { now: NOW, maxRows: 70 })).trimmedDays, 0, 'inside the bound: nothing more is trimmed');
  db.close();
});

test('query plans: every ledger read is a primary-key range or point read, never a table scan', () => {
  const db = buildDb();
  store.ensureAssessmentSchema(db);
  const params = { after: 0, hi: 10, take: 5, from: 1, to: 2, // from / to also bind the meta key range
    match: '"inference"', lo: 0, cap: 10, ids: '[1,2]', word: 'inference' };
  const plan = sql => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(Object.fromEntries([...sql.matchAll(/@(\w+)/g)].map(m => [m[1], params[m[1]]]))).map(r => r.detail);
  const expected = {
    bucketPage: /^SEARCH sale_watch_ledger USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)$/,
    dayCounts: /^SEARCH sale_watch_ledger_days USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)$/,
    imports: /^SEARCH sale_watch_movement_imports USING INDEX sqlite_autoindex_sale_watch_movement_imports_1 \(day>\? AND day<\?\)$/,
    rowsById: /^SEARCH sale_watch_ledger USING INTEGER PRIMARY KEY \(rowid=\?\)$/,
    wordDays: /^SEARCH sale_watch_ledger_words USING PRIMARY KEY \(word=\? AND dayn>\? AND dayn<\?\)$/,
    soldWords: /^SEARCH sale_watch_ledger USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)$/,
    pruneIds: /^SEARCH sale_watch_ledger USING INTEGER PRIMARY KEY \(rowid<\?\)$/,
    readmitDays: /^SEARCH sale_watch_meta USING INDEX sqlite_autoindex_sale_watch_meta_1 \(key>\? AND key<\?\)$/,
  };
  for (const [name, sql] of Object.entries(ledger.SQL)) {
    const details = plan(sql);
    for (const detail of details) assert.doesNotMatch(detail, /^SCAN (?!json_each|sale_watch_ledger_names VIRTUAL TABLE INDEX)/, `${name}: ${detail}`);
    if (expected[name]) assert.match(details[0], expected[name], name);
  }
  // The name-word search is the FTS index with the rowid range and order pushed
  // down (SQLite prints every virtual-table access as SCAN ... VIRTUAL TABLE INDEX).
  const search = plan(ledger.SQL.search);
  assert.equal(search.length, 1, 'no temp b-tree: the FTS index returns rowid order');
  assert.match(search[0], /^SCAN sale_watch_ledger_names VIRTUAL TABLE INDEX \d+:M\d+[<>=]+$/);
  assert.equal(Object.keys(expected).length + 1, Object.keys(ledger.SQL).length, 'every exported query has a plan assertion');
  // The stored-assessment side: reading and clearing a candidate's ledger row is by primary key.
  const one = db.prepare('EXPLAIN QUERY PLAN SELECT ledger_id FROM sale_watch_assessments WHERE domain = ?').all('a.com').map(r => r.detail);
  assert.match(one[0], /^SEARCH sale_watch_assessments USING PRIMARY KEY \(domain=\?\)$/);
  const del = db.prepare(`EXPLAIN QUERY PLAN DELETE FROM ${ledger.TABLE} WHERE id = ?`).all(1).map(r => r.detail);
  assert.match(del[0], /^SEARCH sale_watch_ledger USING INTEGER PRIMARY KEY \(rowid=\?\)$/);
  db.close();
});

test('size: a ledger row and everything derived from it stays near 100 bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ledger-size-'));
  const file = path.join(dir, 'size.db');
  const db = new Database(file);
  ledger.ensureLedgerSchema(db);
  const before = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  const words = ['matrix', 'modal', 'obsidian', 'inference', 'compute', 'solar', 'cloud', 'agent', 'pixel', 'harbor', 'north', 'vector', 'tensor', 'bright', 'path', 'river', 'stone', 'labs', 'hub', 'works'];
  const n = 20000;
  db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const a = words[i % words.length]; const b = words[(i * 7 + 3) % words.length];
      ledger.writeLedgerRow(db, { domain: `${a}${b}${i % 997}.com`, day: day(i % 30), verdict: ledger.VERDICTS[i % 4 === 0 ? 4 : 2], classification: 'platform-destination', dest: i % 4 === 0 ? null : 'Sedo', src: ledger.SRC_IMPORT, now: NOW });
    }
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n;
  const bytes = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true }) - before;
  const perRow = bytes / rows;
  assert.ok(rows > n * 0.9);
  assert.ok(perRow < 130, `measured ${perRow.toFixed(1)} bytes per ledger row (table + day counts + word counts + name index)`);
  db.close();
  fs.rmSync(dir, { recursive: true });
});

function fakeApp() {
  const routes = new Map();
  return { routes, get: (p, h) => routes.set(p, h) };
}
async function call(handler, query) {
  let status = 200; let body = null; const headers = {};
  const res = { set: (k, v) => { headers[k] = v; return res; }, status: c => { status = c; return res; }, json: b => { body = b; return res; } };
  await handler({ query }, res);
  return { status, body, headers };
}

test('routes: scope=ledger reads the ledger loader, the default scope still answers from the feed snapshot, trend routes validate', async () => {
  const db = buildDb();
  insertCandidate(db, departure('matrixinference.com', 8));
  store.storeAssessmentsSync(db, { now: NOW });
  const app = fakeApp();
  const seen = [];
  insights.registerSaleWatchInsightRoutes(app, {
    dailySnapshot: { serve: () => ({ schema: insights.DAILY_SCHEMA, days: [], pagination: { nextCursor: null }, source: 'snapshot' }) },
    ledgerLoader: async q => { seen.push(q); return ledger.readLedgerDaily(db, q); },
    ledgerTrendLoader: async q => ledger.readLedgerTrend(db, q),
    ledgerRisingLoader: async q => ledger.readLedgerRising(db, q),
  });
  const daily = app.routes.get('/api/sale-watch/daily');
  const leads = await call(daily, {});
  assert.equal(leads.body.source, 'snapshot', 'existing scope unchanged');
  assert.equal((await call(daily, { scope: 'leads' })).body.source, 'snapshot');
  const led = await call(daily, { scope: 'ledger', verdict: 'all', window: '30', q: 'inference' });
  assert.equal(led.status, 200);
  assert.equal(led.body.schema, ledger.LEDGER_SCHEMA);
  assert.deepEqual(led.body.days.flatMap(d => d.rows.map(r => r.domain)), ['matrixinference.com']);
  assert.deepEqual(seen[0].verdicts, ledger.VERDICTS);
  assert.equal((await call(daily, { scope: 'ledger', verdict: 'bogus' })).status, 400);
  assert.equal((await call(daily, { scope: 'everything' })).status, 400);
  assert.equal((await call(daily, { scope: 'ledger', window: '91' })).status, 400);
  const trend = await call(app.routes.get('/api/sale-watch/trend'), { q: 'inference', days: '30' });
  assert.equal(trend.status, 200);
  assert.equal(trend.body.totals.unknown, 1);
  assert.equal((await call(app.routes.get('/api/sale-watch/trend'), { q: '' })).status, 400);
  const rising = await call(app.routes.get('/api/sale-watch/trend/rising'), { days: '28' });
  assert.equal(rising.status, 200);
  assert.ok(Array.isArray(rising.body.words));
  assert.equal((await call(app.routes.get('/api/sale-watch/trend/rising'), { days: '5' })).status, 400);
  // Before the indexer has created the tables the ledger answers pending (202), never an error.
  const empty = new Database(':memory:');
  const app2 = fakeApp();
  insights.registerSaleWatchInsightRoutes(app2, { ledgerLoader: async q => ledger.readLedgerDaily(empty, q) });
  assert.equal((await call(app2.routes.get('/api/sale-watch/daily'), { scope: 'ledger' })).status, 202);
  empty.close();
  db.close();
});

test('the indexer worker pass maintains the ledger; the read worker serves the three ledger operations', async () => {
  const db = buildDb();
  insertCandidate(db, departure('matrixinference.com', 8));
  const { runBulkPass } = require('../server/sale-watch-search-indexer');
  const result = await runBulkPass(db, { search: false, probeBacklog: false, candidateKeys: false, destinationDays: false, movementDirectory: null });
  assert.ok(result.stages.some(s => s.stage === 'ledger' && !s.error), 'ledger stage ran');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n, 1);
  assert.ok(db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(ledger.META_RISING), 'rising list stored');
  const worker = fs.readFileSync(path.join(__dirname, '../server/db-read-worker.js'), 'utf8');
  for (const [op, fn] of [['sale-watch.ledger', 'readLedgerDaily'], ['sale-watch.ledger-trend', 'readLedgerTrend'], ['sale-watch.ledger-rising', 'readLedgerRising']]) {
    assert.ok(worker.includes(`methods['${op}']=['./sale-watch-ledger','${fn}']`), op);
    assert.equal(typeof ledger[fn], 'function');
  }
  db.close();
});

test('the evidence VERSION is bumped so the worker rebuilds every stored row with the current rules', () => {
  assert.equal(evidence.VERSION, 'sale-evidence-v20');
  const db = buildDb();
  insertCandidate(db, departure('matrixinference.com', 8));
  store.storeAssessmentsSync(db, { now: NOW });
  // A row stored on the previous version is rebuilt in place and gains its ledger row.
  db.prepare("UPDATE sale_watch_assessments SET version = 'sale-evidence-v18', ledger_id = NULL").run();
  db.prepare(`DELETE FROM ${ledger.TABLE}`).run();
  const again = store.storeAssessmentsSync(db, { now: NOW });
  assert.equal(again.assessed, 1);
  assert.equal(db.prepare('SELECT version FROM sale_watch_assessments').get().version, 'sale-evidence-v20');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n, 1);
  db.close();
});
