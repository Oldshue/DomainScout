'use strict';

// Sale Watch daily feed over a populated stored ledger: tapes kept apart,
// probably-sold first within a day, the whole-window summary equals a direct
// count, paging reaches the end, the pending-queue order, the window cursor
// bound (after {date: to, rank: -1} keeps report_date <= to), q filtering,
// unknown venues in diagnostics, and the query plan of the window read.

const test = require('node:test');
const assert = require('node:assert/strict');

let Database = null;
let sqliteSkip = false;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch (error) { sqliteSkip = `better-sqlite3 unavailable: ${error.message.split('\n')[0]}`; }

const recon = require('../server/sale-watch-reconstruction');
const search = require('../server/sale-watch-search');
const store = require('../server/sale-watch-assessments');
const ins = require('../server/sale-watch-insights');

const NOW = new Date('2026-10-28T12:00:00Z');
const TO = '2026-10-28';
const FROM = '2026-10-15';
const SELLERS = [
  { ns: ['ns1.dan.com', 'ns2.dan.com'], venue: 'Dan.com' },
  { ns: ['ns1.domaincontrol.com', 'ns2.domaincontrol.com'], venue: 'GoDaddy parking' },
  { ns: ['ns1.weirdmarket.example', 'ns2.weirdmarket.example'], venue: 'Weird Market' },
];
const SITE = { active: true, parked: false, placeholder: false, status: 200, description: 'Plan your work together' };

function dayMinus(day, n) { return new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10); }

function insert(db, domain, day, seller, { probeCount = 1, destination = ['ns1.host.example'], discovery = {}, extra = {} } = {}) {
  const ev = {
    domain, tier: 'suspected', reportDate: day, venue: seller.venue, sellerNameservers: seller.ns, buyerNameservers: destination,
    discovery: { movement: { day, prevDay: day, previousNameservers: seller.ns, currentNameservers: destination, source: 'daily-zone-delegation-diff' }, structurallyMoved: true, departureDate: day, priorSiteEvidence: { status: 'parked' }, ...discovery },
    ...extra,
  };
  db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, ?, ?, ?)`)
    .run(domain, day, day, day, day, probeCount, JSON.stringify(ev), `${day}T06:00:00Z`);
}

function buildLedger() {
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  for (let d = 0; d < 16; d += 1) {
    const day = dayMinus(TO, d);
    SELLERS.forEach((seller, s) => {
      for (let i = 0; i < 4; i += 1) {
        const tag = `${String.fromCharCode(97 + d)}${String.fromCharCode(97 + s)}${String.fromCharCode(97 + i)}`;
        insert(db, `built${tag}.com`, day, seller, { discovery: { buyerUse: 1, homepage: { ...SITE, title: `Built${tag} team planning`, finalUrl: `https://built${tag}.com/` } }, extra: { classification: 'likely-sale', buyerTitle: `Built${tag}` } });
        insert(db, `reg${tag}.com`, day, seller, { discovery: { transferEvidence: { registrarChanged: true, observedAt: `${day}T05:00:00Z` } } });
        insert(db, `move${tag}.com`, day, seller, { discovery: { rdap: { pendingTransfer: 1, statuses: ['pending transfer'] } } });
      }
    });
  }
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  store.storeAssessmentsSync(db, { now: NOW });
  ins.ensureInsightSchema(db);
  return db;
}

function allPages(db, query) {
  const pages = [];
  let cursor = null;
  for (let n = 0; n < 100; n += 1) {
    const page = ins.readDaily(db, { from: FROM, to: TO, now: NOW, ...query, cursor });
    pages.push(page);
    cursor = page.pagination.nextCursor;
    if (!cursor) break;
  }
  return pages;
}
const rowsOf = pages => pages.flatMap(p => p.days.flatMap(d => d.rows));

let shared = null;
function ledger() { if (!shared) shared = buildLedger(); return shared; }

test('the daily route keeps the tapes apart over a populated ledger and orders probably sold first', { skip: sqliteSkip }, () => {
  const db = ledger();
  const sets = {};
  for (const tape of ['aftermarket', 'builder', 'noise']) {
    const rows = rowsOf(allPages(db, { tape }));
    assert.ok(rows.length > 0, `${tape} has rows`);
    for (const r of rows) assert.equal(r.derived.tape, tape);
    sets[tape] = new Set(rows.map(r => r.domain));
  }
  for (const a of Object.keys(sets)) for (const b of Object.keys(sets)) if (a < b) for (const d of sets[a]) assert.ok(!sets[b].has(d), `${d} in ${a} and ${b}`);
  let sawMixedDay = false;
  for (const page of allPages(db, { tape: 'all' })) {
    for (const day of page.days) {
      const flags = day.rows.map(r => r.derived.probablySold);
      const firstNot = flags.indexOf(false);
      if (firstNot >= 0) assert.ok(!flags.slice(firstNot).includes(true), `${day.day}: probably sold rows come first`);
      if (flags.includes(true) && flags.includes(false)) sawMixedDay = true;
      for (let i = 1; i < day.rows.length; i += 1) {
        const a = day.rows[i - 1]; const b = day.rows[i];
        const order = ['likely-sale', 'transfer-completed', 'transfer-in-progress'];
        const rank = r => { const i = order.indexOf(r.classification || r.derived.classification); return i === -1 ? order.length : i; };
        assert.ok(rank(a) <= rank(b), `${day.day}: likely-sale, transfer completed, transfer in progress, then candidates`);
        if (rank(a) === rank(b)) assert.ok(a.evidenceRank <= b.evidenceRank, `${day.day}: evidence strength order`);
      }
      assert.equal(day.probable.aftermarket + day.probable.builder + day.probable.noise, day.rows.filter(r => r.derived.probablySold).length);
    }
  }
  assert.ok(sawMixedDay, 'the fixture has days mixing probably sold and further candidates');
});

test('paging reaches the end with no duplicates; only the first page carries the window', { skip: sqliteSkip }, () => {
  const db = ledger();
  const pages = allPages(db, { tape: 'all' });
  assert.ok(pages.length >= 2, `more than one page (${pages.length})`);
  assert.ok(pages[0].window, 'first page has window');
  for (const p of pages.slice(1)) assert.equal(p.window, undefined);
  const rows = rowsOf(pages);
  assert.equal(new Set(rows.map(r => r.domain)).size, rows.length, 'no duplicate rows');
  const days = pages.flatMap(p => p.days.map(d => d.day));
  assert.deepEqual(days, [...days].sort().reverse(), 'days newest first');
  assert.equal(new Set(days).size, days.length, 'no day repeated across pages');
  assert.equal(rows.length, pages[0].window.names);
  for (const r of rows) assert.ok(r.reportDate.slice(0, 10) >= FROM && r.reportDate.slice(0, 10) <= TO);
});

test('the window summary equals a direct count of the stored ledger', { skip: sqliteSkip }, () => {
  const db = ledger();
  const first = ins.readDaily(db, { from: FROM, to: TO, tape: 'aftermarket', now: NOW });
  const w = first.window;
  const direct = db.prepare(`SELECT COUNT(DISTINCT v.domain) AS names,
      COUNT(DISTINCT CASE WHEN a.classification = 'likely-sale' THEN v.domain END) AS probable
    FROM sale_watch_assessment_views v JOIN sale_watch_assessments a ON a.domain = v.domain
    WHERE v.view IN ('probable', 'transfer', 'alpha') AND v.report_date BETWEEN ? AND ?`).get(FROM, TO);
  assert.ok(direct.names > 0 && direct.probable > 0);
  assert.equal(w.names, direct.names);
  assert.equal(w.probable.aftermarket + w.probable.builder + w.probable.noise, direct.probable);
  const rows = rowsOf(allPages(db, { tape: 'all' }));
  for (const t of ['aftermarket', 'builder', 'noise']) {
    const tr = rows.filter(r => r.derived.tape === t);
    assert.equal(w.tapes[t].names, tr.length, `${t} names`);
    assert.equal(w.counts[t], tr.length);
    assert.equal(w.tapes[t].probable, tr.filter(r => r.derived.probablySold).length, `${t} probable`);
    const venueTotal = w.tapes[t].byVenue.reduce((n, x) => n + x.n, 0);
    assert.equal(venueTotal, tr.length, `${t} venue breakdown`);
    for (const key of ['byExtension', 'byLengthBand', 'byHomepage', 'byTier', 'byRegisteredYear', 'byOtherExtensions']) assert.ok(Array.isArray(w.tapes[t][key]), key);
  }
  assert.equal(w.tape, 'aftermarket');
  assert.equal(w.byVenue.reduce((n, x) => n + x.n, 0), w.tapes.aftermarket.names, 'shown-tape breakdowns cover the tape shown');
});

test('after {date: to, rank: -1} keeps report_date <= to and every row dated to', { skip: sqliteSkip }, () => {
  const db = ledger();
  const mid = dayMinus(TO, 5);
  const page = store.readStoredLedgerEntries(db, { view: 'suspected', days: 14, after: { date: mid, rank: -1, domain: '' }, limit: 5000, now: NOW });
  assert.equal(page.status, 'ready');
  const dates = page.entries.map(e => String(e.reportDate).slice(0, 10));
  assert.ok(dates.length > 0);
  assert.ok(dates.every(d => d <= mid), 'no row after to');
  const direct = db.prepare(`SELECT COUNT(*) AS n FROM sale_watch_assessment_views v WHERE v.view = 'suspected' AND v.report_date = ?`).get(mid).n;
  assert.ok(direct > 0);
  assert.equal(dates.filter(d => d === mid).length, direct, 'every row dated to is kept');
});

test('q filters the feed through the indexed search and combines with the tape', { skip: sqliteSkip }, () => {
  const db = ledger();
  const all = new Set(rowsOf(allPages(db, { tape: 'all' })).map(r => r.domain));
  const hits = rowsOf(allPages(db, { tape: 'all', q: 'regaaa' }));
  assert.ok(hits.length >= 1);
  assert.ok(hits.length < all.size);
  for (const r of hits) assert.ok(all.has(r.domain));
  assert.ok(hits.some(r => r.domain === 'regaaa.com'));
  const tapeHits = rowsOf(allPages(db, { tape: 'builder', q: 'regaaa' }));
  for (const r of tapeHits) assert.equal(r.derived.tape, 'builder');
  assert.ok(!tapeHits.some(r => r.domain === 'regaaa.com'), 'the aftermarket name is not on the builder tape');
});

test('unknown venues are listed in diagnostics and their rows are on the noise tape', { skip: sqliteSkip }, () => {
  const db = ledger();
  const page = ins.readDaily(db, { from: FROM, to: TO, tape: 'noise', now: NOW });
  assert.ok(page.diagnostics.unknownVenues.some(v => v.venue === 'Weird Market'));
  assert.ok(!page.diagnostics.unknownVenues.some(v => /dan\.com|godaddy/i.test(v.venue)));
});

test('the pending queue is ordered date desc, likely-sale first, then domain, and pages to the end', { skip: sqliteSkip }, () => {
  const db = ledger();
  const seen = [];
  let cursor = null;
  let total = null;
  for (let n = 0; n < 500; n += 1) {
    const page = ins.readPendingQueue(db, { days: 14, limit: 25, cursor, now: NOW });
    total = page.pagination.totalPending;
    seen.push(...page.rows);
    cursor = page.pagination.nextCursor;
    if (!cursor) break;
  }
  assert.ok(total > 25);
  assert.equal(seen.length, total, 'paging reaches the end');
  assert.equal(new Set(seen.map(r => r.domain)).size, seen.length, 'no duplicates');
  const pr = r => (r.classification === 'likely-sale' ? 0 : r.tier === 'verified' || r.tier === 'probable' ? 1 : r.tier === 'suspected' ? 2 : 3);
  for (let i = 1; i < seen.length; i += 1) {
    const a = seen[i - 1]; const b = seen[i];
    const da = a.reportDate.slice(0, 10); const dbb = b.reportDate.slice(0, 10);
    assert.ok(da > dbb || (da === dbb && (pr(a) < pr(b) || (pr(a) === pr(b) && a.domain < b.domain))), `${a.domain} before ${b.domain}`);
  }
});

test('the window read is index-driven (query plan of the after-clause and q read)', { skip: sqliteSkip }, () => {
  const db = ledger();
  const captured = [];
  const original = db.prepare.bind(db);
  db.prepare = sql => {
    const st = original(sql);
    if (!/FROM sale_watch_assessment_views v/.test(sql) || !/ORDER BY v.report_date DESC/.test(sql)) return st;
    return new Proxy(st, { get(target, prop) {
      if (prop === 'all') return params => { captured.push({ sql, params }); return target.all(params); };
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try {
    for (const q of ['', 'builtaaa']) store.readStoredLedgerEntries(db, { view: 'suspected', q, days: 14, after: { date: TO, rank: -1, domain: '' }, limit: 5000, now: NOW });
  } finally { db.prepare = original; }
  assert.equal(captured.length, 2);
  for (const { sql, params } of captured) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map(r => r.detail);
    if (process.env.PRINT_PLAN) console.log(plan.join('\n'));
    const vLine = plan.find(l => /\bv\b/.test(l));
    assert.ok(vLine && /USING (COVERING )?INDEX|PRIMARY KEY/.test(vLine), `views table index-driven: ${plan.join(' | ')}`);
    for (const l of plan) assert.doesNotMatch(l, /^SCAN (a|c)\b(?! USING)/, `no full scan of the joins: ${plan.join(' | ')}`);
  }
});

test('the feed reads only the probable, transfer and alpha views, never suspected (with or without q)', { skip: sqliteSkip }, () => {
  const db = ledger();
  const original = store.readStoredLedgerEntries;
  const requested = [];
  store.readStoredLedgerEntries = (handle, opts) => { requested.push(opts.view); return original(handle, opts); };
  try {
    ins.readDaily(db, { from: FROM, to: TO, now: NOW });
    ins.readDaily(db, { from: FROM, to: TO, q: 'ai', now: NOW });
  } finally { store.readStoredLedgerEntries = original; }
  assert.deepEqual([...ins.LEDGER_VIEWS], ['probable', 'transfer', 'alpha']);
  assert.ok(requested.length > 0);
  assert.ok(!requested.includes('suspected'), `requested ${requested.join(',')}`);
  assert.deepEqual([...new Set(requested)].sort(), ['alpha', 'probable', 'transfer']);
});

test('a window read that returns WINDOW_READ_LIMIT rows is a diagnostics error, not a silent truncation', { skip: sqliteSkip }, () => {
  const db = ledger();
  const original = store.readStoredLedgerEntries;
  store.readStoredLedgerEntries = (handle, opts) => (opts.view === 'transfer'
    ? { status: 'ready', entries: new Array(ins.WINDOW_READ_LIMIT).fill(null) }
    : original(handle, opts));
  let page;
  try { page = ins.readDaily(db, { from: FROM, to: TO, now: NOW }); } finally { store.readStoredLedgerEntries = original; }
  const errs = page.diagnostics.windowReadErrors;
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'WINDOW_READ_LIMIT');
  assert.equal(errs[0].view, 'transfer');
  assert.equal(page.window.truncated, true);
  const clean = ins.readDaily(db, { from: FROM, to: TO, now: NOW });
  assert.deepEqual(clean.diagnostics.windowReadErrors, []);
});

function buildLongDayLedger() {
  // One day holding more than DAILY_PAGE_ROWS names in the probable view.
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  const big = ins.DAILY_PAGE_ROWS + 10;
  for (let i = 0; i < big; i += 1) insert(db, `longday${String(i).padStart(3, '0')}x.com`.replace(/\d/g, d => String.fromCharCode(97 + Number(d))), TO, SELLERS[0], { discovery: { transferEvidence: { registrarChanged: true, observedAt: `${TO}T05:00:00Z` } } });
  for (let i = 0; i < 10; i += 1) insert(db, `prevday${String.fromCharCode(97 + i)}x.com`, dayMinus(TO, 1), SELLERS[0], { discovery: { transferEvidence: { registrarChanged: true, observedAt: `${dayMinus(TO, 1)}T05:00:00Z` } } });
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  store.storeAssessmentsSync(db, { now: NOW });
  ins.ensureInsightSchema(db);
  return db;
}

test('a daily page never exceeds DAILY_PAGE_ROWS; a long day continues on the next page with whole-day counts', { skip: sqliteSkip }, () => {
  const db = buildLongDayLedger();
  const longDay = db.prepare(`SELECT COUNT(*) AS n FROM sale_watch_assessment_views WHERE view = 'probable' AND report_date = ?`).get(TO).n;
  assert.ok(longDay > ins.DAILY_PAGE_ROWS, `fixture day holds ${longDay} probable rows`);
  const pages = allPages(db, { tape: 'all' });
  const firstSeen = new Map();
  let continued = 0;
  for (const page of pages) {
    const n = page.days.reduce((k, d) => k + d.rows.length, 0);
    assert.ok(n <= ins.DAILY_PAGE_ROWS, `page holds ${n} rows`);
    for (const d of page.days) {
      if (d.continued) {
        continued += 1;
        assert.ok(firstSeen.has(d.day), `${d.day} continues a day already shown`);
        assert.deepEqual(d.counts, firstSeen.get(d.day).counts, 'day counts cover the whole day');
        assert.deepEqual(d.classes, firstSeen.get(d.day).classes);
      } else firstSeen.set(d.day, d);
    }
  }
  assert.ok(continued >= 1, 'the fixture splits at least one day across pages');
  const w = pages[0].window;
  assert.equal(w.classes.likelySale + w.classes.transferCompleted + w.classes.transferInProgress + w.classes.candidate, w.names);
});
