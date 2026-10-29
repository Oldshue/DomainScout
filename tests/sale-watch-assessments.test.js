'use strict';

// Stored Sale Watch ledger: pages read straight from sale_watch_assessments /
// sale_watch_assessment_views, equivalent to the retained read-time path, with
// zero per-request assessments; a VERSION bump keeps old rows serving until the
// worker replaces them; and the worker pass drains the first-probe backlog.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const recon = require('../server/sale-watch-reconstruction');
const store = require('../server/sale-watch-assessments');
const search = require('../server/sale-watch-search');
const evidenceModule = require('../server/sale-watch-evidence');

const NOW = new Date('2026-10-28T12:00:00Z');
const DAYS = ['2026-10-27', '2026-10-26', '2026-10-24', '2026-10-21', '2026-10-05'];
const SELLER = ['ns1.dan.com', 'ns2.dan.com'];

function buildDb() {
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  return db;
}

function insert(db, domain, day, { probeCount = 1, state = 'exited', destination = ['ns1.host.example'], discovery = {}, extra = {}, nextProbeAt = day } = {}) {
  const ev = {
    domain, tier: 'suspected', reportDate: day, sellerNameservers: SELLER, buyerNameservers: destination,
    discovery: { movement: { day, prevDay: day, previousNameservers: SELLER, currentNameservers: destination, source: 'daily-zone-delegation-diff' }, structurallyMoved: true, departureDate: day, ...discovery },
    ...extra,
  };
  db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, ?, ?, ?, ?, ?)`)
    .run(domain, day, day, day, state, nextProbeAt, probeCount, JSON.stringify(ev), `${day}T06:00:00Z`);
}

const SITE = { active: true, parked: false, placeholder: false, status: 200, title: 'Team planning', description: 'Plan your work together' };

function seedEveryView(db) {
  DAYS.forEach((day, d) => {
    for (let i = 0; i < 4; i += 1) {
      const tag = `${String.fromCharCode(97 + d)}${String.fromCharCode(97 + i)}`;
      insert(db, `quiet${tag}.com`, day, { probeCount: 0 });
      insert(db, `built${tag}.com`, day, { discovery: { buyerUse: 1, homepage: { ...SITE, title: `Built${tag} team planning`, finalUrl: `https://built${tag}.com/` } }, extra: { classification: 'likely-sale', buyerTitle: `Built${tag}` } });
      insert(db, `move${tag}.net`, day, { discovery: { rdap: { pendingTransfer: 1, statuses: ['pending transfer'] } } });
      insert(db, `reg${tag}.com`, day, { discovery: { transferEvidence: { registrarChanged: true, observedAt: `${day}T05:00:00Z` } } });
      insert(db, `parked${tag}.com`, day, { destination: ['ns1.sedoparking.com'], discovery: { homepage: { active: true, parked: true, status: 200, title: 'This domain is for sale' } } });
      insert(db, `inference${tag}.com`, day, { discovery: { buyerUse: 1, homepage: { ...SITE, title: `Inference${tag} GPU inference` } }, extra: { classification: 'likely-sale' } });
    }
  });
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
}

function countAssessments(fn) {
  const original = evidenceModule.assessSaleEntry;
  let calls = 0;
  evidenceModule.assessSaleEntry = (entry, opts) => { calls += 1; return original(entry, opts); };
  try { return { value: fn(), calls }; } finally { evidenceModule.assessSaleEntry = original; }
}

test('stored ledger pages equal the read-time pages for every view, q and cursor, with zero per-request assessments', () => {
  const db = buildDb();
  seedEveryView(db);
  store.storeAssessmentsSync(db, { now: NOW });
  const nonEmpty = [];
  for (const view of store.SALE_VIEWS) {
    for (const q of ['', 'inference']) {
      const baseline = recon.readReconstructionEntriesAssessed(db, { view, q, now: NOW }).map(e => e.domain);
      const { value, calls } = countAssessments(() => recon.readReconstructionEntries(db, { view, q, now: NOW }));
      assert.equal(calls, 0, `${view}/${q}: ${calls} per-request assessments`);
      assert.deepEqual(value.map(e => e.domain), baseline, `${view}/q=${q}: stored page equals read-time page`);
      if (!q && baseline.length) nonEmpty.push(view);
      // Cursor paging walks the same sequence.
      if (baseline.length > 3) {
        const first = recon.readReconstructionEntries(db, { view, q, limit: 3, now: NOW });
        const last = first.at(-1);
        const raw = JSON.parse(db.prepare('SELECT evidence_json FROM sale_watch_candidates WHERE domain=?').get(last.domain).evidence_json);
        const rank = { 'likely-sale': 0, 'transferred-and-built': 1, 'acquisition-candidate': 2, 'transfer-in-progress': 3, 'transfer-completed': 4, 'seller-departure': 5, 'reported-sale': 6 }[raw.classification] ?? 7;
        const after = { date: raw.reportDate, rank, domain: last.domain };
        // Expected: the next slice of the read-time display sequence. (The retained
        // read-time cursor compares domain without its length, so it can skip a
        // longer name that sorts earlier; the stored cursor follows display order.)
        assert.deepEqual(recon.readReconstructionEntries(db, { view, q, after, limit: 3, now: NOW }).map(e => e.domain),
          baseline.slice(3, 6), `${view}/q=${q} cursor`);
      }
    }
  }
  for (const view of ['all', 'leads', 'focus', 'suspected']) assert.ok(nonEmpty.includes(view), `fixture covers ${view} (covered: ${nonEmpty.join(',')})`);
  // days applies in SQL on the stored report date.
  const week = recon.readReconstructionEntries(db, { view: 'all', days: 2, now: NOW });
  assert.ok(week.length > 0 && week.every(e => e.reportDate >= '2026-10-26'));
  db.close();
});

test('a VERSION bump keeps serving the old stored assessments until the worker replaces them', async () => {
  const db = buildDb();
  seedEveryView(db);
  store.storeAssessmentsSync(db, { now: NOW });
  const before = recon.readReconstructionEntries(db, { view: 'all', now: NOW }).map(e => e.domain);
  // Simulate rows written by an older adjudicator VERSION.
  db.prepare("UPDATE sale_watch_assessments SET version = 'sale-evidence-v0'").run();
  db.prepare("UPDATE sale_watch_meta SET value = 'sale-evidence-v0' WHERE key = ?").run(store.META_READY);
  const page = recon.readReconstructionPage(db, { view: 'all', now: NOW });
  assert.equal(page.status, 'ready', 'never pending on a VERSION change');
  assert.deepEqual(page.entries.map(e => e.domain), before, 'old assessments keep serving');
  assert.ok(page.entries.every(e => e.storedAssessment === 'sale-evidence-v0'));
  // A partial rebuild replaces rows in place; the rest keep serving.
  const partial = await store.ensureStoredAssessments(db, { now: NOW, batch: 10, limit: 20 });
  assert.equal(partial.complete, false);
  const mid = recon.readReconstructionPage(db, { view: 'all', now: NOW });
  assert.equal(mid.status, 'ready');
  assert.deepEqual(mid.entries.map(e => e.domain), before);
  const versions = new Set(mid.entries.map(e => e.storedAssessment));
  assert.ok(versions.has('sale-evidence-v0') && versions.has(evidenceModule.VERSION), 'mixed versions while rebuilding');
  const done = await store.ensureStoredAssessments(db, { now: NOW });
  assert.equal(done.complete, true);
  assert.equal(store.storedAssessmentVersion(db), evidenceModule.VERSION);
  assert.ok(recon.readReconstructionEntries(db, { view: 'all', now: NOW }).every(e => e.storedAssessment === evidenceModule.VERSION));
  db.close();
});

test('marker missing: the read-time (f3c6494) path serves rows, never pending; the marker switches to the stored path', async () => {
  const db = buildDb();
  seedEveryView(db);
  assert.equal(store.storeMarker(db), null);
  for (const view of ['all', 'leads', 'focus']) {
    const page = recon.readReconstructionPage(db, { view, now: NOW });
    assert.equal(page.status, 'ready', `${view}: never pending before the first pass`);
    assert.equal(page.source, 'read-time');
    assert.ok(page.entries.length > 0, `${view}: the old path returns rows`);
    assert.deepEqual(page.entries.map(e => e.domain), recon.readReconstructionEntriesAssessed(db, { view, now: NOW }).map(e => e.domain));
    assert.ok(page.entries.every(e => !e.storedAssessment));
    assert.equal(page.ledgerStore.complete, false);
    assert.equal(page.ledgerStore.serving, 'read-time');
  }
  assert.ok(recon.readReconstructionEntries(db, { view: 'all', now: NOW }).length > 0);
  // A partial worker pass leaves no marker: still the read-time path.
  const partial = await store.ensureStoredAssessments(db, { now: NOW, batch: 10, limit: 20 });
  assert.equal(partial.complete, false);
  assert.equal(store.storeMarker(db), null);
  assert.equal(recon.readReconstructionPage(db, { view: 'all', now: NOW }).source, 'read-time');
  const coverage = store.ledgerStoreStatus(db);
  assert.equal(coverage.complete, false);
  assert.ok(coverage.assessed > 0 && coverage.assessed < coverage.total, JSON.stringify(coverage));
  await store.ensureStoredAssessments(db, { now: NOW });
  const marker = store.storeMarker(db);
  assert.equal(marker.version, evidenceModule.VERSION);
  assert.ok(marker.completeAt && marker.rows > 0, JSON.stringify(marker));
  const raw = JSON.parse(db.prepare("SELECT value FROM sale_watch_meta WHERE key = 'assessment_store'").get().value);
  assert.deepEqual(Object.keys(raw).sort(), ['completeAt', 'rows', 'version']);
  const done = store.ledgerStoreStatus(db);
  assert.equal(done.complete, true);
  assert.equal(done.assessed, done.total);
  db.close();
});

test('marker current: the stored path serves with zero assessment calls', () => {
  const db = buildDb();
  seedEveryView(db);
  store.storeAssessmentsSync(db, { now: NOW });
  const original = evidenceModule.assessSaleEntry;
  const originalAssessed = recon.readReconstructionEntriesAssessed;
  let calls = 0;
  let readTime = 0;
  evidenceModule.assessSaleEntry = (...args) => { calls += 1; return original(...args); };
  recon.readReconstructionEntriesAssessed = (...args) => { readTime += 1; return originalAssessed(...args); };
  try {
    const page = recon.readReconstructionPage(db, { view: 'all', now: NOW });
    assert.equal(page.source, 'stored');
    assert.ok(page.entries.length > 0);
    assert.ok(page.entries.every(e => e.storedAssessment === evidenceModule.VERSION));
    assert.equal(page.ledgerStore.complete, true);
  } finally {
    evidenceModule.assessSaleEntry = original;
    recon.readReconstructionEntriesAssessed = originalAssessed;
  }
  assert.equal(calls, 0, 'no per-request assessment');
  assert.equal(readTime, 0, 'read-time path not used');
  db.close();
});

test('a VERSION bump after completion keeps the stored path (no fallback) until the worker rebuilds', async () => {
  const db = buildDb();
  seedEveryView(db);
  store.storeAssessmentsSync(db, { now: NOW });
  db.prepare("UPDATE sale_watch_assessments SET version = 'sale-evidence-v0'").run();
  db.prepare("UPDATE sale_watch_meta SET value = ? WHERE key = ?").run(JSON.stringify({ version: 'sale-evidence-v0', completeAt: '2026-10-01T00:00:00.000Z', rows: 1 }), store.META_READY);
  const page = recon.readReconstructionPage(db, { view: 'all', now: NOW });
  assert.equal(page.source, 'stored', 'never falls back after a VERSION bump');
  assert.ok(page.entries.length > 0 && page.entries.every(e => e.storedAssessment === 'sale-evidence-v0'));
  assert.equal(page.ledgerStore.complete, false);
  assert.equal(page.ledgerStore.version, 'sale-evidence-v0');
  const status = store.ledgerStoreStatus(db);
  assert.equal(status.assessed, 0);
  assert.ok(status.total > 0);
  await store.ensureStoredAssessments(db, { now: NOW });
  assert.equal(store.storeMarker(db).version, evidenceModule.VERSION);
  assert.equal(recon.readReconstructionPage(db, { view: 'all', now: NOW }).ledgerStore.complete, true);
  db.close();
});

test('/api/sale-watch reports coverage.reconstruction.ledgerStore and serves rows before the first pass', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { registerSaleWatchRoutes } = require('../server/sale-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-ledger-store-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ entries: [] }), 'utf8');
  const db = buildDb();
  seedEveryView(db);
  const mockRes = () => { const res = { statusCode: 200, headers: {}, body: null }; res.set = (k, v) => { res.headers[k] = v; return res; }; res.status = c => { res.statusCode = c; return res; }; res.json = b => { res.body = b; return res; }; return res; };
  const serve = async () => {
    const routes = new Map();
    registerSaleWatchRoutes({ get(p, h) { routes.set(p, h); } }, {
      ledgerPath, discoveryPath: path.join(dir, 'discovery.json'),
      reconstructionLoader: query => recon.readReconstructionPage(db, { ...query, now: NOW }),
      reconstructionCoverage: () => recon.reconstructionCoverage(db),
    });
    const res = mockRes();
    await routes.get('/api/sale-watch')({ query: { view: 'all' } }, res);
    return res;
  };
  try {
    const before = await serve();
    assert.equal(before.statusCode, 200, 'no 202 blackout before the first pass');
    assert.ok(before.body.entries.length > 0);
    const ls = before.body.coverage.reconstruction.ledgerStore;
    assert.equal(ls.complete, false);
    assert.equal(ls.source, 'read-time');
    assert.ok(Number.isFinite(ls.assessed) && ls.total > 0, JSON.stringify(ls));
    store.storeAssessmentsSync(db, { now: NOW });
    const after = await serve();
    assert.equal(after.statusCode, 200);
    const done = after.body.coverage.reconstruction.ledgerStore;
    assert.equal(done.version, evidenceModule.VERSION);
    assert.equal(done.complete, true);
    assert.equal(done.source, 'stored');
    assert.equal(done.assessed, done.total);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an evidence change marks the row dirty, the page keeps serving, and the next pass restores it', async () => {
  const db = buildDb();
  seedEveryView(db);
  await store.ensureStoredAssessments(db, { now: NOW });
  assert.equal(recon.readReconstructionPage(db, { view: 'focus', now: NOW }).source, 'stored');
  db.prepare("UPDATE sale_watch_candidates SET evidence_json = json_set(evidence_json, '$.discovery.buyerUse', 0) WHERE domain = 'builtaa.com'").run();
  assert.equal(db.prepare('SELECT dirty FROM sale_watch_assessments WHERE domain = ?').get('builtaa.com').dirty, 1);
  assert.equal(recon.readReconstructionPage(db, { view: 'focus', now: NOW }).status, 'ready', 'a dirty row never makes the page pending');
  await store.ensureStoredAssessments(db, { now: NOW });
  assert.equal(db.prepare('SELECT dirty FROM sale_watch_assessments WHERE domain = ?').get('builtaa.com').dirty, 0);
  assert.deepEqual(recon.readReconstructionEntries(db, { view: 'focus', now: NOW }).map(e => e.domain),
    recon.readReconstructionEntriesAssessed(db, { view: 'focus', now: NOW }).map(e => e.domain));
  db.close();
});

test('drainProbeBacklog recomputes the whole stale backlog newest exit_observed_day first, in small transactions', async () => {
  const db = buildDb();
  const days = ['2026-10-01', '2026-10-10', '2026-10-21', '2026-10-27'];
  let n = 0;
  for (const day of days) for (let i = 0; i < 30; i += 1) { insert(db, `stale${n}.com`, day, { probeCount: 0, nextProbeAt: day }); n += 1; }
  insert(db, 'accessgpu.com', '2026-10-21', { probeCount: 0, nextProbeAt: '2026-10-21' });
  db.prepare('UPDATE sale_watch_candidates SET probe_priority = 3').run();
  const result = await recon.drainProbeBacklog(db, { batch: 7, now: NOW.toISOString() });
  assert.equal(result.remaining, 0, 'backlog empty');
  assert.ok(result.pages > 10, 'small transactions');
  const order = result.firstOrder;
  const dayOf = d => db.prepare('SELECT exit_observed_day AS day FROM sale_watch_candidates WHERE domain = ?').get(d).day;
  for (let i = 1; i < order.length; i += 1) assert.ok(dayOf(order[i - 1]) >= dayOf(order[i]), 'newest departure first');
  assert.equal(dayOf(order[0]), '2026-10-27');
  const p = db.prepare('SELECT probe_priority FROM sale_watch_candidates WHERE domain = ?').get('accessgpu.com').probe_priority;
  assert.notEqual(p, 3, 'accessgpu.com left the old priority scale');
  db.close();
});

test('worker pass: a probe_count 0 row is due within 24 h of departure whatever its state', async () => {
  const db = buildDb();
  insert(db, 'unleashllm.com', '2026-10-27', { probeCount: 0, state: 'parked-watch', nextProbeAt: '2026-12-10' });
  insert(db, 'robotinfer.com', '2026-10-26', { probeCount: 0, state: 'parked-watch', nextProbeAt: '2026-12-12' });
  insert(db, 'probed.com', '2026-10-26', { probeCount: 2, state: 'parked-watch', nextProbeAt: '2026-12-12' });
  const { runBulkPass } = require('../server/sale-watch-search-indexer');
  const result = await runBulkPass(db, { now: NOW.toISOString() });
  assert.ok(result.probeBacklog.dueCorrected >= 2);
  const due = d => db.prepare('SELECT next_probe_at FROM sale_watch_candidates WHERE domain = ?').get(d).next_probe_at;
  assert.equal(due('unleashllm.com'), '2026-10-27');
  assert.equal(due('robotinfer.com'), '2026-10-26');
  assert.equal(due('probed.com'), '2026-12-12', 'probed rows keep their ladder schedule');
  assert.equal(result.assessments.complete, true, 'the same pass stores assessments');
  db.close();
});

test('ingest: a re-observed probe_count 0 row is pulled back to due within 24 h of departure; probed rows keep their ladder', () => {
  const db = buildDb();
  insert(db, 'llmtracker.dev', '2026-10-26', { probeCount: 0, state: 'parked-watch', nextProbeAt: '2026-12-11' });
  insert(db, 'laddered.com', '2026-10-26', { probeCount: 3, state: 'parked-watch', nextProbeAt: '2026-12-11' });
  recon.enqueueExitCandidates(db, { exits: ['llmtracker.dev', 'laddered.com', 'fresh-exit.com'], day: '2026-10-27' });
  const row = d => db.prepare('SELECT state, next_probe_at, exit_observed_day FROM sale_watch_candidates WHERE domain = ?').get(d);
  assert.equal(row('llmtracker.dev').next_probe_at, '2026-10-26', 'due on its departure day');
  assert.equal(row('llmtracker.dev').state, 'parked-watch', 'state untouched');
  assert.equal(row('laddered.com').next_probe_at, '2026-12-11');
  assert.equal(row('fresh-exit.com').next_probe_at, '2026-10-27', 'new rows are due on departure');
  db.close();
});

test('the index worker rebuilds stored assessments after a VERSION bump while the main event loop never stalls > 100 ms and old rows keep serving', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const indexer = require('../server/sale-watch-search-indexer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-assess-drift-'));
  const db = new Database(path.join(dir, 'sale_watch.db'));
  try {
    db.pragma('busy_timeout = 15000');
    recon.configureSaleWatchDb(db);
    recon.ensureReconstructionSchema(db);
    search.ensureSearchSchema(db);
    const N = 3000;
    db.transaction(() => {
      for (let i = 0; i < N; i += 1) {
        const day = DAYS[i % DAYS.length];
        if (i % 3 === 0) insert(db, `builtname${i}.com`, day, { discovery: { buyerUse: 1, homepage: { ...SITE, title: `Builtname${i} team planning` } }, extra: { classification: 'likely-sale' } });
        else insert(db, `quietname${i}.com`, day);
      }
    })();
    store.storeAssessmentsSync(db, { now: NOW });
    const before = recon.readReconstructionEntries(db, { view: 'leads', limit: 50, now: NOW }).map(e => e.domain);
    assert.ok(before.length > 0);
    db.prepare("UPDATE sale_watch_assessments SET version = 'sale-evidence-v0'").run();
    db.prepare("UPDATE sale_watch_meta SET value = 'sale-evidence-v0' WHERE key = ?").run(store.META_READY);
    const PERIOD = 10;
    let last = Date.now();
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => { const t = Date.now(); maxGap = Math.max(maxGap, t - last); last = t; ticks += 1; }, PERIOD);
    const request = indexer.requestSearchIndexPass(db, { pass: 'catch-up', options: { now: NOW.toISOString() }, log: { log() {}, warn() {} } });
    assert.equal(request.inProcess, false, 'a file-backed handle is rebuilt by the worker');
    const during = recon.readReconstructionPage(db, { view: 'leads', limit: 50, now: NOW });
    assert.equal(during.status, 'ready', 'never pending while rebuilding');
    assert.deepEqual(during.entries.map(e => e.domain), before, 'old assessments keep serving during the rebuild');
    last = Date.now();
    const result = await request.promise;
    clearInterval(timer);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.worker, true);
    assert.equal(result.assessments.complete, true, JSON.stringify(result.assessments));
    assert.ok(result.assessments.assessed >= N, `rebuilt ${result.assessments.assessed}`);
    assert.ok(ticks >= 5, `interval ticked ${ticks} times`);
    assert.ok(maxGap < 100, `main event loop stalled ${maxGap} ms while the worker rebuilt`);
    assert.equal(store.storedAssessmentVersion(db), evidenceModule.VERSION);
    assert.deepEqual(recon.readReconstructionEntries(db, { view: 'leads', limit: 50, now: NOW }).map(e => e.domain), before);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
