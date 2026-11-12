'use strict';

// Sale Watch window control (14 / 30 / 90 days): one snapshot per window, the
// 30/90-day builds follow the 14-day build and never delay it, a window with
// no snapshot yet answers from the largest existing window with a building
// note, the stored-ledger read is paged by date range (WINDOW_READ_LIMIT stays
// a loud per-chunk error), and the window query is validated.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let Database = null;
let sqliteSkip = false;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch (error) { sqliteSkip = `better-sqlite3 unavailable: ${error.message.split('\n')[0]}`; }

const recon = require('../server/sale-watch-reconstruction');
const search = require('../server/sale-watch-search');
const store = require('../server/sale-watch-assessments');
const ins = require('../server/sale-watch-insights');
const snap = require('../server/sale-watch-daily-snapshot');

const NOW = new Date('2026-10-28T12:00:00Z');
const TO = '2026-10-28';
const SELLER = { ns: ['ns1.dan.com', 'ns2.dan.com'], venue: 'Dan.com' };
const SITE = { active: true, parked: false, placeholder: false, status: 200 };
const dayMinus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
const silent = { warn() {} };

function insert(db, domain, day, discovery = {}, extra = {}) {
  const ev = { domain, tier: 'suspected', reportDate: day, venue: SELLER.venue, sellerNameservers: SELLER.ns, buyerNameservers: ['ns1.host.example'],
    discovery: { movement: { day, prevDay: day, previousNameservers: SELLER.ns, currentNameservers: ['ns1.host.example'], source: 'daily-zone-delegation-diff' }, structurallyMoved: true, departureDate: day, priorSiteEvidence: { status: 'parked' }, ...discovery }, ...extra };
  db.prepare(`INSERT INTO sale_watch_candidates (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 1, ?, ?)`).run(domain, day, day, day, day, JSON.stringify(ev), `${day}T06:00:00Z`);
}

// 95 days, 4 names a day: two built (assessed into suspected/leads, not fed) and two registrar transfers (probable view: the 2 feed names a day).
function fixture(spanDays = 95) {
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  for (let d = 0; d < spanDays; d += 1) {
    const day = dayMinus(TO, d);
    for (let i = 0; i < 2; i += 1) {
      const tag = `d${d}n${i}`;
      insert(db, `built${tag}.com`, day, { buyerUse: 1, homepage: { ...SITE, title: `Built ${tag} team`, finalUrl: `https://built${tag}.com/` } }, { classification: 'likely-sale', buyerTitle: `Built ${tag}` });
      insert(db, `reg${tag}.com`, day, { transferEvidence: { registrarChanged: true, observedAt: `${day}T05:00:00Z` } });
    }
  }
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  store.storeAssessmentsSync(db, { now: NOW });
  ins.ensureInsightSchema(db);
  return db;
}

test('windowChunks pages [from, to] by date range, newest first, covering every day once', () => {
  const chunks = ins.windowChunks(dayMinus(TO, 89), TO);
  assert.equal(chunks.length, Math.ceil(90 / ins.READ_CHUNK_DAYS));
  assert.equal(chunks[0].to, TO);
  assert.equal(chunks.at(-1).from, dayMinus(TO, 89));
  for (let i = 1; i < chunks.length; i += 1) assert.equal(chunks[i].to, dayMinus(chunks[i - 1].from, 1));
  assert.deepEqual(ins.windowChunks(TO, TO), [{ from: TO, to: TO }]);
});

test('window query: 14 default, 30 and 90 accepted, anything else rejected', () => {
  const q = w => ins.normalizeDailyQuery(w === undefined ? {} : { window: w }, { now: NOW });
  assert.equal(q().from, dayMinus(TO, 13));
  assert.equal(q('30').from, dayMinus(TO, 29));
  assert.equal(q('90').from, dayMinus(TO, 89));
  for (const bad of ['7', '91', 'abc', '-14', '14.0']) assert.throws(() => q(bad), ins.InsightQueryError, bad);
  assert.throws(() => ins.normalizeDailyQuery({ from: dayMinus(TO, 90), to: TO }), /at most 90 days/);
});

test('14/30/90-day snapshots each cover their own window with their own generatedAt; sizes and build times measured', { skip: sqliteSkip }, () => {
  const db = fixture();
  const report = {};
  for (const days of ins.DAILY_WINDOWS) {
    ins._clearWindowCache();
    const t0 = process.hrtime.bigint();
    const s = ins.buildDailySnapshot(db, { now: NOW, days });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(s.status, 'ready');
    assert.equal(s.windowDays, days);
    assert.equal(s.from, dayMinus(TO, days - 1));
    assert.equal(s.to, TO);
    assert.ok(Number.isFinite(Date.parse(s.generatedAt)));
    assert.equal(s.rows.length, days * 2, `${days}-day window holds every feed name in range`);
    assert.deepEqual(s.readErrors, []);
    const bytes = Buffer.byteLength(JSON.stringify(s));
    report[days] = { rows: s.rows.length, bytes, bytesPerRow: Math.round(bytes / s.rows.length), buildMs: Math.round(ms) };
  }
  console.log(`[window-snapshots] ${JSON.stringify(report)}`);
  assert.ok(() => assert.throws(() => ins.buildDailySnapshot(db, { now: NOW, days: 60 })));
  assert.throws(() => ins.buildDailySnapshot(db, { now: NOW, days: 60 }), /days: must be one of/);
  db.close();
});

test('WINDOW_READ_LIMIT stays loud per date chunk: a chunk at the limit is a readError, never silent', { skip: sqliteSkip }, () => {
  const db = fixture(20);
  const orig = store.readStoredLedgerEntries;
  const calls = [];
  store.readStoredLedgerEntries = (d, opts) => {
    calls.push({ view: opts.view, days: opts.days, to: opts.after.date });
    const page = orig(d, opts);
    if (opts.view === 'alpha' && opts.after.date === TO) return { ...page, entries: Array.from({ length: ins.WINDOW_READ_LIMIT }, () => page.entries[0]) };
    return page;
  };
  try {
    ins._clearWindowCache();
    const out = ins.readWindowLedger(db, { from: dayMinus(TO, 89), to: TO, now: NOW });
    assert.equal(out.truncated, true);
    const err = out.readErrors.find(e => e.code === 'WINDOW_READ_LIMIT');
    assert.equal(err.view, 'alpha');
    assert.equal(err.to, TO);
    assert.equal(err.from, dayMinus(TO, ins.READ_CHUNK_DAYS - 1));
    // Every view is read once per chunk; no read asks for more than the limit.
    assert.equal(calls.length, ins.LEDGER_VIEWS.length * Math.ceil(90 / ins.READ_CHUNK_DAYS));
  } finally { store.readStoredLedgerEntries = orig; db.close(); }
});

test('snapshot set: 14-day build first, 30 and 90 after it; a missing window answers from the largest existing one with a building note', { skip: sqliteSkip }, async () => {
  const db = fixture();
  const order = [];
  let gate90; const hold90 = new Promise(r => { gate90 = r; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-win-'));
  const set = snap.createDailySnapshotSet({
    dir, log: silent, setTimer: () => ({ unref() {} }), clearTimer() {},
    build: async (days) => { order.push(days); if (days === 90) await hold90; ins._clearWindowCache(); return ins.buildDailySnapshot(db, { now: NOW, days }); },
  });
  // No snapshot at all: pending, as before.
  assert.equal(set.serve({ window: '90' }).status, 'pending');
  await set.store(14)._state.running;
  assert.deepEqual(order.slice(0, 1), [14], 'the 14-day snapshot is built first');
  // 14 ready, 30 building: a 30-day request answers from the 14-day view.
  const early = set.serve({ window: '30', tape: 'aftermarket' });
  assert.equal(early.windowDays, 14);
  assert.equal(early.requestedWindow, 30);
  assert.match(early.building.note, /building 30-day view/);
  await new Promise(r => setImmediate(r));
  while (set.store(30)._state.running) await set.store(30)._state.running;
  assert.ok(set.current(30), '30-day snapshot built after the 14-day one');
  const mid = set.serve({ window: '90' });
  assert.equal(mid.windowDays, 30, 'largest existing window answers');
  assert.match(mid.building.note, /building 90-day view/);
  gate90();
  await set.refreshSecondaries('test');
  while (set.store(90)._state.running) await set.store(90)._state.running;
  const full = set.serve({ window: '90', tape: 'all' });
  assert.equal(full.windowDays, 90);
  assert.equal(full.building, undefined);
  assert.equal(full.window.names, 90 * 2);
  assert.deepEqual(order, [14, 30, 90]);
  assert.notEqual(set.current(14).generatedAt, undefined);
  // Each window persisted atomically to its own file; the 14-day file name is unchanged.
  assert.deepEqual(fs.readdirSync(dir).sort(), [snap.SNAPSHOT_FILE, snap.snapshotFileFor(30), snap.snapshotFileFor(90)].sort());
  // Search and filters run over the selected window.
  const hit = set.serve({ window: '90', q: 'regd80n0' });
  assert.ok(hit.days.some(d => d.rows.some(r => r.domain === 'regd80n0.com')), 'a name 80 days back is found in the 90-day window');
  const miss = set.serve({ window: '14', q: 'regd80n0' });
  assert.equal(miss.days.flatMap(d => d.rows).filter(r => r.domain === 'regd80n0.com').length, 0);
  assert.throws(() => set.serve({ window: '7' }), /window: must be one of/);
  // Boot: every persisted window loads before any producer run.
  const again = snap.createDailySnapshotSet({ dir, log: silent, build: async () => { throw new Error('no build at boot'); } });
  assert.deepEqual(again.loadFromFile(), { 14: true, 30: true, 90: true });
  fs.rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('a slow or failing 90-day build never blocks or delays the 14-day snapshot', async () => {
  const good = days => ({ schema: ins.SNAPSHOT_SCHEMA, status: 'ready', generatedAt: new Date().toISOString(), ledgerVersion: `v${days}`, windowDays: days, from: dayMinus(TO, days - 1), to: TO, rows: [] });
  let builds14 = 0;
  const set = snap.createDailySnapshotSet({ log: silent, setTimer: () => ({ unref() {} }), clearTimer() {}, secondaryIntervalMs: 0,
    build: (days) => { if (days === 14) { builds14 += 1; return Promise.resolve(good(14)); } if (days === 90) return new Promise(() => {}); return Promise.reject(new Error('30 failed')); } });
  assert.equal((await set.refresh('a')).ok, true);
  await new Promise(r => setImmediate(r));
  assert.ok(set.store(90)._state.running, '90-day build hangs');
  assert.equal((await set.refresh('b')).ok, true, 'next 14-day refresh completes while 90 hangs');
  assert.equal(builds14, 2);
  assert.equal(set.serve({ window: '90' }).windowDays, 14);
  assert.match(set.freshnessCheck().detail, /30d stale/);
  assert.equal(set.freshnessCheck().name, 'daily-snapshot');
});

test('screen: window buttons, saved choice, request carries window=, building note shown', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  for (const w of [14, 30, 90]) assert.match(html, new RegExp(`data-sale-watch-window="${w}"[^>]*onclick="app\\.setSaleWatchWindow\\(${w}\\)"`));
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const els = {}; const el = id => els[id] || (els[id] = { id, textContent: '', innerHTML: '', style: {}, dataset: {}, focus() {} });
  const kv = { saleWatchIncludeCandidates: '1' }; const fetches = [];
  const ctx = { URLSearchParams, AbortController, console,
    document: { body: {}, addEventListener() {}, getElementById: el, querySelector: () => ({ style: {}, contains: () => false }), querySelectorAll: () => [] },
    localStorage: { getItem: k => (k in kv ? kv[k] : null), setItem: (k, v) => { kv[k] = String(v); } },
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame() { return 0; },
    fetch: async url => { fetches.push(url); return { ok: true, status: 200, json: async () => ({ windowDays: 30, requestedWindow: 90, building: { windowDays: 90 }, days: [], pagination: { nextCursor: null } }) }; } };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, ctx);
  ctx.__state.stream = '_salewatch';
  const app = ctx.__app;
  assert.equal(app._saleWatchWindow(), 14);
  app.setSaleWatchWindow(90);
  assert.equal(kv.saleWatchWindow, '90', 'saved across reloads');
  assert.equal(app._saleWatchWindow(), 90);
  app.setSaleWatchWindow(7);
  assert.equal(app._saleWatchWindow(), 90, 'unknown window ignored');
  return new Promise(r => setImmediate(r)).then(() => {
    assert.ok(fetches.some(u => /[?&]window=90&/.test(u)));
    const out = el('sale-watch-daily').innerHTML;
    assert.match(out, /Building 90-day view; showing the past 30 days meanwhile/);
    assert.match(out, /No names in the past 30 days/);
  });
});
