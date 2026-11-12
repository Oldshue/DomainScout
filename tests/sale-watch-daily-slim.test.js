'use strict';

// 2026-11-12 production OOM: the daily snapshot held every row's evidence
// (discovery ~2.9 KB, reconstruction ~2.3 KB, assessment ~1.1 KB). The fixture
// here is production-sized; the snapshot must hold slim rows (<= 1.2 KB of
// JSON each, no evidence blob), expanded-row evidence is read by primary key
// on demand (GET /api/sale-watch/daily/evidence, small LRU), and the three
// window snapshots together stay inside the 60 MB main-process heap budget.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

let Database = null;
let sqliteSkip = false;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch (error) { sqliteSkip = `better-sqlite3 unavailable: ${error.message.split('\n')[0]}`; }

const recon = require('../server/sale-watch-reconstruction');
const search = require('../server/sale-watch-search');
const store = require('../server/sale-watch-assessments');
const ins = require('../server/sale-watch-insights');

const NOW = new Date('2026-10-28T12:00:00Z');
const TO = '2026-10-28';
const SELLER = { ns: ['ns1.dan.com', 'ns2.dan.com'], venue: 'Dan.com' };
const SITE = { active: true, parked: false, placeholder: false, status: 200 };
const dayMinus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
const VOCAB = ['studio', 'analytics', 'platform', 'customer', 'delivery', 'pricing', 'garden', 'journal', 'harbor', 'network', 'careers', 'support', 'booking', 'clinic', 'travel'];
const pad = (seed, n) => { let out = ''; let i = 0; while (out.length < n) { out += (out ? ' ' : '') + VOCAB[(seed + i) % VOCAB.length]; i += 1; } return out.slice(0, n); };
// Production-production: about 75 feed names a day; the fixture keeps the
// per-row shape and sizes and extrapolates the counts (PROD_ROWS).
const PROD_ROWS = { 14: 1451, 30: 2264, 90: 2264 * 3 };

function insert(db, domain, day, discovery = {}, extra = {}) {
  const ev = { domain, tier: 'suspected', reportDate: day, venue: SELLER.venue, sellerNameservers: SELLER.ns, buyerNameservers: ['ns1.host.example', 'ns2.host.example'],
    discovery: { movement: { day, prevDay: dayMinus(day, 1), previousNameservers: SELLER.ns, currentNameservers: ['ns1.host.example', 'ns2.host.example'], source: 'daily-zone-delegation-diff' }, structurallyMoved: true, departureDate: day, priorSiteEvidence: { status: 'parked', title: pad(day.length, 200) }, ...discovery }, ...extra };
  db.prepare(`INSERT INTO sale_watch_candidates (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 4, ?, ?)`).run(domain, day, day, day, day, JSON.stringify(ev), `${day}T06:00:00Z`);
}

function fixture(spanDays = 95) {
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  for (let d = 0; d < spanDays; d += 1) {
    const day = dayMinus(TO, d);
    for (let i = 0; i < 2; i += 1) {
      const tag = `d${d}n${i}`;
      const hp = url => ({ ...SITE, title: `Built ${tag} ${pad(d + i, 150)}`, description: pad(d + i + 1, 320), brandText: pad(d + i + 2, 140), textSample: pad(d + i + 3, 1500), finalUrl: url });
      const rdap = { registrar: 'Example Registrar, LLC', statuses: ['client transfer prohibited', 'server update prohibited', 'client delete prohibited'], lastChangedAt: `${day}T04:00:00Z`, checkedAt: `${day}T05:00:00Z`, remarks: pad(d, 300) };
      insert(db, `built${tag}.com`, day, { buyerUse: 1, homepage: hp(`https://built${tag}.com/`), rdap }, { classification: 'likely-sale', buyerTitle: `Built ${tag} ${pad(d, 120)}` });
      insert(db, `reg${tag}.com`, day, { transferEvidence: { registrarChanged: true, observedAt: `${day}T05:00:00Z` }, rdap, homepage: { ...hp(`https://reg${tag}.com/`), active: false, status: 404 } });
    }
  }
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  store.storeAssessmentsSync(db, { now: NOW });
  // Assessment blobs of production size (~1.1 KB): longer signal and counter-evidence lists.
  const up = db.prepare('UPDATE sale_watch_assessments SET assessment_json = ? WHERE domain = ?');
  for (const a of db.prepare('SELECT domain, assessment_json FROM sale_watch_assessments').all()) {
    let v = {}; try { v = JSON.parse(a.assessment_json) || {}; } catch (_) { v = {}; }
    const signals = [...(v.signals || [])]; const counter = [...(v.counterEvidence || [])];
    let k = 0; while (JSON.stringify({ ...v, signals, counterEvidence: counter }).length < 1100) { (k % 2 ? counter : signals).push(pad(k, 90)); k += 1; }
    up.run(JSON.stringify({ ...v, signals, counterEvidence: counter }), a.domain);
  }
  // Reconstruction of production size (~2.3 KB): four probe observations each.
  const obs = db.prepare('INSERT OR IGNORE INTO sale_watch_observations(domain, observed_at, kind, digest, evidence_json) VALUES (?, ?, ?, ?, ?)');
  for (const c of db.prepare('SELECT domain, exit_observed_day AS day FROM sale_watch_candidates').all()) {
    for (let j = 0; j < 4; j += 1) obs.run(c.domain, `${c.day}T0${j + 1}:00:00Z`, 'probe', `${c.domain}-${j}`, JSON.stringify({ registrar: 'Example Registrar, LLC', rdap: { statuses: ['client transfer prohibited'] }, homepage: { finalUrl: `https://${c.domain}/`, title: pad(j, 260) }, classification: 'likely-sale', notes: pad(j + 3, 160) }));
  }
  ins.ensureInsightSchema(db);
  return db;
}


test('production-sized fixture: slim snapshot rows <= 1.2 KB, no evidence blob; 14/30/90 measured; three windows inside the 60 MB heap budget', { skip: sqliteSkip }, () => {
  const db = fixture();
  ins._clearWindowCache();
  const fat = ins.readWindowLedger(db, { from: dayMinus(TO, 13), to: TO, now: NOW }).entries;
  const fatPerRow = Math.round(Buffer.byteLength(JSON.stringify(fat)) / fat.length);
  const sizes = e => ({ discovery: JSON.stringify(e.discovery || {}).length, reconstruction: JSON.stringify(e.reconstruction || {}).length, assessment: JSON.stringify(e.assessment || {}).length });
  const s0 = sizes(fat[0]);
  assert.ok(s0.discovery >= 2500 && s0.reconstruction >= 2000 && s0.assessment >= 1000, `fixture rows are production-sized: ${JSON.stringify(s0)}`);
  const report = { fatBytesPerRow: fatPerRow, fixtureBlobBytes: s0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-slim-'));
  const files = [];
  for (const days of ins.DAILY_WINDOWS) {
    ins._clearWindowCache();
    const t0 = process.hrtime.bigint();
    const s = ins.buildDailySnapshot(db, { now: NOW, days });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(s.status, 'ready');
    assert.ok(s.rows.length >= days, `${days}: rows`);
    for (const r of s.rows) {
      for (const k of ins.EVIDENCE_KEYS) assert.equal(r[k], undefined, `${r.domain}: ${k} is evidence, never in the snapshot`);
      assert.equal(r.derived.timeline, undefined);
    }
    const json = JSON.stringify(s);
    // No long site text (titles, description, textSample) survives: every string in the snapshot is short.
    let longest = 0; JSON.parse(json, (k, v) => { if (typeof v === 'string' && v.length > longest) longest = v.length; return v; });
    assert.ok(longest <= 300, `longest string in the ${days}-day snapshot is ${longest} characters`);
    const perRow = Math.round(Buffer.byteLength(JSON.stringify(s.rows)) / s.rows.length);
    assert.ok(perRow <= 1200, `${days}-day slim row is ${perRow} bytes of JSON`);
    // Production row count: the fixture's slim rows repeated under distinct names.
    const rows = Array.from({ length: PROD_ROWS[days] }, (_, i) => ({ ...s.rows[i % s.rows.length], domain: `p${i}${s.rows[i % s.rows.length].domain}` }));
    const prod = JSON.stringify({ ...s, rows });
    const file = path.join(dir, `${days}.json`);
    fs.writeFileSync(file, prod);
    files.push(file);
    report[days] = { fixtureRows: s.rows.length, slimBytesPerRow: perRow, fixtureBuildMs: Math.round(ms), fixtureMsPerRow: +(ms / s.rows.length).toFixed(2), prodRows: rows.length, prodJsonBytes: Buffer.byteLength(prod) };
  }
  // Main-process heap with all three loaded, measured in a clean process with gc.
  const script = `const fs=require('fs');global.gc();const b=process.memoryUsage().heapUsed;const keep=process.argv.slice(1).map(f=>JSON.parse(fs.readFileSync(f,'utf8')));global.gc();const each=[];let prev=b;
    for(const k of keep){each.push(k.rows.length);}const a=process.memoryUsage().heapUsed;console.log(JSON.stringify({heapBytes:a-b,rows:each}));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '-e', script, ...files], { encoding: 'utf8' }).trim().split('\n').pop());
  for (const [i, days] of ins.DAILY_WINDOWS.entries()) {
    const one = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '-e', script, files[i]], { encoding: 'utf8' }).trim().split('\n').pop());
    report[days].prodHeapBytes = one.heapBytes;
  }
  report.allThreeHeapBytes = out.heapBytes;
  console.log(`[slim-snapshots] ${JSON.stringify(report)}`);
  assert.ok(out.heapBytes < 60 * 1024 * 1024, `three windows hold ${out.heapBytes} bytes of heap`);
  fs.rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('evidence reads are primary-key lookups (query plans) and return what the expanded row shows', { skip: sqliteSkip }, () => {
  const db = fixture(2);
  for (const [name, sql] of Object.entries(ins.EVIDENCE_SQL)) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ domain: 'regd0n0.com' }).map(r => r.detail).join(' | ');
    assert.match(plan, /SEARCH \S+ USING (?:INDEX|PRIMARY KEY|COVERING INDEX)[^|]*\(domain=\?/, `${name}: ${plan}`);
    assert.doesNotMatch(plan, /\bSCAN\b/, `${name}: ${plan}`);
  }
  const out = ins.readDailyEvidence(db, { domain: 'regd0n0.com' });
  assert.equal(out.found, true);
  const ev = out.evidence;
  assert.ok(ev.assessment.signals.length > 0);
  assert.ok(ev.assessment.counterEvidence.length > 0);
  assert.equal(typeof ev.rationale, 'string');
  assert.deepEqual(ev.sellerNameservers, SELLER.ns);
  assert.equal(ev.discovery.rdap.registrar, 'Example Registrar, LLC');
  assert.ok(ev.discovery.movement && ev.discovery.movement.day);
  assert.equal(ev.reconstruction.observations.length, 4);
  assert.equal(ins.readDailyEvidence(db, { domain: 'nothere.com' }).found, false);
  assert.throws(() => ins.readDailyEvidence(db, { domain: 'Not A Domain' }), ins.InsightQueryError);
  db.close();
});

test('GET /api/sale-watch/daily/evidence: one read per domain (LRU), 400 bad name, 404 unknown, 503 on a read failure', async () => {
  const routes = {};
  const app = { get(p, fn) { routes[p] = fn; } };
  let calls = 0; let fail = false;
  ins.registerSaleWatchInsightRoutes(app, { dailyEvidenceLoader: async ({ domain }) => { calls += 1; if (fail) throw new Error('db-read-worker-timeout'); return domain === 'gone.com' ? { found: false } : { schema: ins.EVIDENCE_SCHEMA, domain, found: true, evidence: { domain, rationale: 'r' } }; } });
  const call = async domain => { const res = { code: 200, headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await routes['/api/sale-watch/daily/evidence']({ query: { domain } }, res); return res; };
  assert.equal((await call('a.com')).code, 200);
  assert.equal((await call('a.com')).body.evidence.rationale, 'r');
  assert.equal(calls, 1, 'second open served from the LRU');
  assert.equal((await call('bad name')).code, 400);
  assert.equal((await call('gone.com')).code, 404);
  fail = true;
  assert.equal((await call('b.com')).code, 503);
  fail = false;
  for (let i = 0; i < ins.EVIDENCE_CACHE_MAX + 5; i += 1) await call(`n${i}.com`);
  const before = calls;
  await call('a.com');
  assert.equal(calls, before + 1, 'the LRU is bounded: the oldest entry was evicted');
});

test('screen: evidence is fetched when a row is opened, never for the page; loading line, retry line on failure, kept for the session', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const els = {}; const el = id => els[id] || (els[id] = { id, textContent: '', innerHTML: '', style: {}, dataset: {}, focus() {} });
  const kv = { saleWatchIncludeCandidates: '1' };
  const urls = []; let mode = 'fail';
  const ctx = { URLSearchParams, AbortController, console,
    document: { body: {}, addEventListener() {}, getElementById: el, querySelector: () => ({ style: {}, contains: () => false }), querySelectorAll: () => [] },
    localStorage: { getItem: k => (k in kv ? kv[k] : null), setItem: (k, v) => { kv[k] = String(v); } },
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame() { return 0; },
    fetch: async url => { urls.push(String(url)); if (mode === 'fail') return { ok: false, status: 503, json: async () => ({ error: 'busy' }) };
      return { ok: true, status: 200, json: async () => ({ evidence: { rationale: 'Left Dan.com and changed registrar', assessment: { signals: ['sig-one'], counterEvidence: ['ce-one'] }, sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['ns1.host.example'], discovery: { rdap: { registrar: 'RegX', statuses: [] } } } }) }; } };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, ctx);
  const app = ctx.__app;
  const row = { domain: 'regd0n0.com', reportDate: '2026-11-12', classification: 'likely-sale', evidenceRank: 0, derived: { tape: 'aftermarket', sold: true, soldReason: 'registrar transfer', words: [], wordPairs: [] } };
  app._saleWatchDaily = { window: null, days: [{ day: '2026-11-12', counts: { aftermarket: 1, builder: 0, noise: 0 }, rows: [row] }], pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  assert.equal(urls.filter(u => u.includes('/daily/evidence')).length, 0, 'no evidence prefetch for the page');
  assert.match(el('sale-watch-daily').innerHTML, /ontoggle="app.openSaleWatchEvidence\(this\)"/);
  const slot = { innerHTML: '' };
  const details = { open: true, dataset: { domain: 'regd0n0.com' }, querySelector: () => slot };
  const p = app.openSaleWatchEvidence(details);
  assert.match(slot.innerHTML, /loading evidence…/);
  await p;
  assert.match(slot.innerHTML, /sale-watch-evidence-error/);
  assert.match(slot.innerHTML, /Retry/);
  assert.doesNotMatch(el('sale-watch-daily').innerHTML, /could not load/i, 'never an error for the feed');
  mode = 'ok';
  await app.openSaleWatchEvidence(details);
  for (const t of ['Left Dan.com and changed registrar', 'sig-one', 'ce-one', 'ns1.dan.com', 'RegX']) assert.ok(slot.innerHTML.includes(t), t);
  const n = urls.length;
  slot.innerHTML = '';
  await app.openSaleWatchEvidence(details);
  assert.equal(urls.length, n, 'opened evidence is kept for the session');
  assert.ok(slot.innerHTML.includes('RegX'));
  app.renderSaleWatchDaily();
  assert.ok(el('sale-watch-daily').innerHTML.includes('RegX'), 'a re-render keeps opened evidence');
});

test('a snapshot file written before slim rows is slimmed on load', () => {
  const snap = require('../server/sale-watch-daily-snapshot');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-fat-'));
  const file = path.join(dir, snap.SNAPSHOT_FILE);
  const fat = { domain: 'cloudkitchen.com', reportDate: '2026-11-12', classification: 'likely-sale', evidenceRank: 0, rationale: 'x'.repeat(500), assessment: { signals: ['a'] }, reconstruction: { observations: [] },
    discovery: { homepage: { title: 'Cloud Kitchen', textSample: 'y'.repeat(2000) } }, derived: { tape: 'aftermarket', sold: true, soldReason: 'registrar transfer', timeline: [{ at: 'x' }], words: ['cloud', 'kitchen'] } };
  fs.writeFileSync(file, JSON.stringify({ schema: ins.SNAPSHOT_SCHEMA, status: 'ready', generatedAt: new Date().toISOString(), ledgerVersion: 'v', from: '2026-10-30', to: '2026-11-12', rows: [fat] }));
  const s = snap.readSnapshotFile(file);
  for (const k of ins.EVIDENCE_KEYS) assert.equal(s.rows[0][k], undefined, k);
  assert.equal(s.rows[0].derived.timeline, undefined);
  assert.deepEqual(s.rows[0].derived.words, ['cloud', 'kitchen']);
  assert.ok(JSON.stringify(s.rows[0]).length <= 1200);
  fs.rmSync(dir, { recursive: true, force: true });
});
