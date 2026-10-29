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
      // The stored base page (before the leads+q tape merge) equals the read-time page;
      // the tape merge only adds rows (leads ⊇ candidates for q).
      const base = opts => recon.readLedgerPageBase(db, opts).entries;
      const { value, calls } = countAssessments(() => base({ view, q, now: NOW }));
      const merged = recon.readReconstructionEntries(db, { view, q, now: NOW }).map(e => e.domain);
      for (const d of baseline) assert.ok(merged.includes(d), `${view}/q=${q}: merged page keeps ${d}`);
      assert.equal(calls, 0, `${view}/${q}: ${calls} per-request assessments`);
      assert.deepEqual(value.map(e => e.domain), baseline, `${view}/q=${q}: stored page equals read-time page`);
      if (!q && baseline.length) nonEmpty.push(view);
      // Cursor paging walks the same sequence.
      if (baseline.length > 3) {
        const first = base({ view, q, limit: 3, now: NOW });
        const last = first.at(-1);
        const raw = JSON.parse(db.prepare('SELECT evidence_json FROM sale_watch_candidates WHERE domain=?').get(last.domain).evidence_json);
        const rank = { 'likely-sale': 0, 'transferred-and-built': 1, 'acquisition-candidate': 2, 'transfer-in-progress': 3, 'transfer-completed': 4, 'seller-departure': 5, 'reported-sale': 6 }[raw.classification] ?? 7;
        const after = { date: raw.reportDate, rank, domain: last.domain };
        // Expected: the next slice of the read-time display sequence. (The retained
        // read-time cursor compares domain without its length, so it can skip a
        // longer name that sorts earlier; the stored cursor follows display order.)
        assert.deepEqual(base({ view, q, after, limit: 3, now: NOW }).map(e => e.domain),
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
    // The window-first stage (30 days, newest first) rebuilds before the full pass.
    const rebuilt = (Number(result.assessmentsWindow && result.assessmentsWindow.assessed) || 0) + (Number(result.assessments.assessed) || 0);
    assert.ok(rebuilt >= N, `rebuilt ${rebuilt}`);
    assert.ok(ticks >= 5, `interval ticked ${ticks} times`);
    assert.ok(maxGap < 100, `main event loop stalled ${maxGap} ms while the worker rebuilt`);
    assert.equal(store.storedAssessmentVersion(db), evidenceModule.VERSION);
    assert.deepEqual(recon.readReconstructionEntries(db, { view: 'leads', limit: 50, now: NOW }).map(e => e.domain), before);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── worker order, dirty clearing and the cheap due-only probe-priority stage ──

test('the assessment stage clears dirty = 0 on every row it writes, including rows re-dirtied by an evidence change', async () => {
  const db = buildDb();
  seedEveryView(db);
  const result = await store.ensureStoredAssessments(db, { now: NOW });
  assert.equal(result.complete, true, JSON.stringify(result));
  const counts = () => db.prepare('SELECT SUM(dirty = 1) AS dirty, SUM(dirty = 0) AS clean, COUNT(*) AS n FROM sale_watch_assessments').get();
  const after = counts();
  assert.equal(after.dirty, 0, 'no dirty rows remain');
  assert.equal(after.clean, after.n, 'every written row is clean');
  assert.ok(after.n > 0);
  db.prepare("UPDATE sale_watch_candidates SET evidence_json = json_set(evidence_json, '$.buyerTitle', 'Changed') WHERE domain LIKE 'quiet%'").run();
  assert.ok(counts().dirty > 0, 'evidence change marks rows dirty');
  await store.ensureStoredAssessments(db, { now: NOW });
  assert.equal(counts().dirty, 0, 'the next pass writes them back clean');
  db.close();
});

test('runBulkPass stores current-window assessments FIRST (newest day first), before the search and probe-priority stages', async () => {
  const db = buildDb();
  for (const day of DAYS) for (let i = 0; i < 5; i += 1) insert(db, `win${day.replace(/-/g, '')}${i}.com`, day, { probeCount: 0 });
  for (let i = 0; i < 5; i += 1) insert(db, `old${i}.com`, '2026-09-01');
  const { runBulkPass } = require('../server/sale-watch-search-indexer');
  const result = await runBulkPass(db, { now: NOW.toISOString() });
  const stages = result.stages.map(s => s.stage);
  assert.equal(stages[0], 'assess-window', stages.join(','));
  assert.ok(stages.indexOf('assess-window') < stages.indexOf('search'));
  assert.ok(stages.indexOf('assess-window') < stages.indexOf('probe-priority'));
  assert.ok(stages.indexOf('probe-priority') < stages.indexOf('assessments'));
  for (const s of result.stages) assert.ok(Number.isFinite(s.rowsPerSec), JSON.stringify(s));
  assert.equal(result.assessmentsWindow.windowComplete, true);
  assert.equal(result.assessmentsWindow.assessed, DAYS.length * 5, 'window stage covers only the 30-day window');
  assert.equal(result.assessments.complete, true);
  db.close();
});

test('a windowed ledger read is served from the stored assessment once the window stage completes, before the full pass', async () => {
  const db = buildDb();
  seedEveryView(db);
  insert(db, 'ancient.com', '2026-08-01');
  const win = await store.ensureStoredAssessments(db, { now: NOW, windowOnly: true });
  assert.equal(win.windowComplete, true);
  assert.equal(store.storedAssessmentsReady(db), false, 'the full store is not complete yet');
  assert.equal(store.storedWindowReady(db, { days: 7, now: NOW }), true);
  assert.equal(store.storedWindowReady(db, { days: 60, now: NOW }), false, 'a wider window is not covered');
  assert.equal(store.storedWindowReady(db, { days: null, now: NOW }), false, 'an unwindowed read is not covered');
  const page = recon.readReconstructionPage(db, { view: 'leads', days: 7, now: NOW });
  assert.equal(page.source, 'stored');
  assert.equal(recon.readReconstructionPage(db, { view: 'leads', now: NOW }).source, 'read-time');
  // Newest window day assessed first.
  const order = db.prepare('SELECT c.exit_observed_day AS day FROM sale_watch_assessments a JOIN sale_watch_candidates c ON c.domain = a.domain WHERE a.dirty = 0 ORDER BY a.assessed_at').all();
  assert.ok(order.length > 0);
  db.close();
});

test('probe-priority backfill touches only rows due within 7 days and never rebuilds a search document', async () => {
  const db = buildDb();
  insert(db, 'accessgpu.com', '2026-10-27', { probeCount: 0 });
  insert(db, 'laterow.com', '2026-10-20', { probeCount: 1, nextProbeAt: '2026-12-30' });
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  db.prepare('UPDATE sale_watch_candidates SET probe_priority = 3 WHERE domain = ?').run('accessgpu.com');
  db.prepare('UPDATE sale_watch_candidates SET probe_priority = NULL WHERE domain = ?').run('laterow.com');
  const original = search.buildSearchDocument;
  let calls = 0;
  search.buildSearchDocument = (...args) => { calls += 1; return original(...args); };
  try {
    const result = await recon.drainProbeBacklog(db, { now: NOW.toISOString() });
    assert.equal(calls, 0, 'no per-row buildSearchDocument');
    assert.equal(result.remaining, 0);
    assert.ok(Number.isFinite(result.rowsPerSec));
  } finally {
    search.buildSearchDocument = original;
  }
  const p = d => db.prepare('SELECT probe_priority AS p FROM sale_watch_candidates WHERE domain = ?').get(d).p;
  assert.ok(p('accessgpu.com') < recon.KIT_FIRST_PROBE_PRIORITY, 'due first probe scored into tier 1 from the stored document');
  assert.equal(p('laterow.com'), null, 'a row not due within 7 days is left for a later pass');
  db.close();
});

// ── leads recall: leads q results ⊇ candidate tape q results (same window) ──
test('leads q results are a superset of the candidate tape q results for the same window, minus excluded rows', () => {
  const cands = require('../server/sale-watch-candidates');
  const db = buildDb();
  seedEveryView(db);
  // Fresh, unprobed departures still being probed: on the tape, not yet classified as leads.
  insert(db, 'pilotcompute.com', '2026-10-28', { probeCount: 0, state: 'probing' });
  insert(db, 'queuecompute.com', '2026-10-28', { probeCount: 0, state: 'probing' });
  // Older in-window departures the stored classification does not mark as leads
  // (unconfirmed-move): only the tape merge brings them into leads.
  insert(db, 'routecompute.com', '2026-10-24', { probeCount: 1, state: 'probing' });
  insert(db, 'meshcompute.com', '2026-10-24', { probeCount: 0, state: 'probing' });
  for (const d of ['pilotcompute.com', 'queuecompute.com', 'routecompute.com', 'meshcompute.com']) {
    search.writeSearchDocument(db, d, db.prepare('SELECT evidence_json FROM sale_watch_candidates WHERE domain=?').get(d).evidence_json);
  }
  store.storeAssessmentsSync(db, { now: NOW });
  const tape = cands.readSaleWatchCandidates(db, { q: 'compute', days: 7, limit: cands.MAX_LIMIT, now: NOW }).rows.map(r => r.domain);
  assert.ok(tape.includes('pilotcompute.com') && tape.includes('queuecompute.com'), `fixture on the tape: ${tape.join(',')}`);
  assert.ok(tape.includes('routecompute.com') && tape.includes('meshcompute.com'), `older fixture on the tape: ${tape.join(',')}`);
  const base = recon.readLedgerPageBase(db, { view: 'leads', q: 'compute', days: 7, now: NOW }).entries.map(e => e.domain);
  assert.ok(!base.includes('routecompute.com') && !base.includes('meshcompute.com'), 'the base stored leads page misses the older tape names (the recall gap)');
  const excluded = new Set(db.prepare(`SELECT domain FROM ${store.TABLE} WHERE tier = 'excluded'`).all().map(r => r.domain));
  const leads = recon.readReconstructionEntries(db, { view: 'leads', q: 'compute', days: 7, now: NOW }).map(e => e.domain);
  for (const d of tape) if (!excluded.has(d)) assert.ok(leads.includes(d), `leads q=compute includes tape row ${d} (leads: ${leads.join(',')})`);
  for (const d of ['pilotcompute.com', 'queuecompute.com', 'routecompute.com', 'meshcompute.com']) assert.ok(leads.includes(d), `leads includes ${d}`);
  // Paged leads keep the merged rows reachable and never duplicate a row.
  const paged = recon.readReconstructionEntries(db, { view: 'leads', q: 'compute', days: 7, limit: 2, now: NOW }).map(e => e.domain);
  assert.equal(new Set(paged).size, paged.length);
  assert.ok(paged.length <= 2);
  db.close();
});

function dirtyCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM sale_watch_assessments WHERE dirty = 1').get().n;
}

test('search document writes, the stale search rebuild and probe_priority never dirty an assessment; an evidence change does', async () => {
  const db = buildDb();
  seedEveryView(db);
  store.storeAssessmentsSync(db, { now: NOW });
  assert.equal(dirtyCount(db), 0);
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  assert.equal(dirtyCount(db), 0, 'a search document write must not dirty');
  db.prepare('UPDATE sale_watch_search_docs SET search_version = NULL').run();
  await search.indexStaleSearchDocuments(db, {});
  assert.equal(dirtyCount(db), 0, 'the stale search rebuild must not dirty');
  db.prepare("UPDATE sale_watch_candidates SET probe_priority = 2, next_probe_at = '2026-11-02', search_text = NULL").run();
  assert.equal(dirtyCount(db), 0, 'probe_priority / next_probe_at / search_text must not dirty');
  db.prepare("UPDATE sale_watch_candidates SET evidence_json = json_set(evidence_json, '$.discovery.buyerUse', 0) WHERE domain = 'builtaa.com'").run();
  assert.equal(dirtyCount(db), 1, 'an evidence change dirties exactly that row');
  assert.equal(db.prepare('SELECT dirty FROM sale_watch_assessments WHERE domain = ?').get('builtaa.com').dirty, 1);
  db.prepare("UPDATE sale_watch_candidates SET state = 'probing' WHERE domain = 'quietaa.com'").run();
  assert.equal(dirtyCount(db), 2, 'a state change dirties the row');
  db.close();
});

test('the window marker flips once dirty rows in the 30-day window are <= 0.5% of the window', async () => {
  const db = buildDb();
  for (let i = 0; i < 400; i += 1) insert(db, `winrow${i}.com`, DAYS[i % 4]);
  for (let i = 0; i < 20; i += 1) insert(db, `outside${i}.com`, '2026-08-01');
  await store.ensureStoredAssessments(db, { now: NOW, windowOnly: true });
  assert.ok(store.windowMarker(db), 'marker after the window pass');
  // Rows outside the window never block it, even while dirty / unassessed.
  assert.equal(store.windowCoverage(db, { now: NOW }).total, 400);
  db.prepare("DELETE FROM sale_watch_meta WHERE key = ?").run(store.META_WINDOW);
  const touch = d => db.prepare("UPDATE sale_watch_candidates SET evidence_json = json_set(evidence_json, '$.touched', 1) WHERE domain = ?").run(d);
  for (const d of ['winrow0.com', 'winrow1.com', 'winrow2.com']) touch(d);
  let r = store.recordWindowMarker(db, { now: NOW });
  assert.equal(r.coverage.dirty, 3);
  assert.equal(r.marker, null, '3/400 = 0.75% dirty: no marker');
  assert.equal(store.storedWindowReady(db, { days: 7, now: NOW }), false);
  db.prepare("UPDATE sale_watch_assessments SET dirty = 0 WHERE domain = 'winrow2.com'").run();
  r = store.recordWindowMarker(db, { now: NOW });
  assert.equal(r.coverage.dirty, 2);
  assert.ok(r.marker, '2/400 = 0.5% dirty: marker written');
  assert.equal(store.storedWindowReady(db, { days: 7, now: NOW }), true);
  assert.equal(recon.readReconstructionPage(db, { view: 'all', days: 7, now: NOW }).source, 'stored', 'dirty rows keep serving their stored assessment');
  db.close();
});

test('a read-time (fallback) q search assesses at most N candidate rows', () => {
  const db = buildDb();
  for (let i = 0; i < 60; i += 1) {
    const tag = `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
    insert(db, `computecloud${tag}.com`, DAYS[i % 4], { discovery: { buyerUse: 1, homepage: { ...SITE, title: `Compute cloud ${tag}`, description: 'GPU compute for teams' } }, extra: { classification: 'likely-sale' } });
  }
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  assert.equal(store.storedAssessmentsReady(db), false, 'no marker: fallback path');
  assert.equal(recon.FALLBACK_Q_MAX_CANDIDATES, 2000);
  const picked = recon.fallbackQueryCandidates(db, 'compute', { max: 10 });
  assert.ok(picked.matched > 10, `the index matched ${picked.matched}`);
  assert.equal(picked.domains.length, 10);
  assert.equal(picked.truncated, true);
  const { value, calls } = countAssessments(() => recon.readReconstructionEntriesAssessed(db, { view: 'leads', q: 'compute', now: NOW, maxCandidates: 10 }));
  assert.ok(calls <= 10, `${calls} assessments for N = 10`);
  assert.ok(value.length <= 10);
  for (const e of value) assert.ok(picked.domains.includes(e.domain));
  db.close();
});

// ── ledger population: drain and windowCoverage agree ──────────────────────
function populationFixture(db) {
  const day = '2026-10-26';
  for (let i = 0; i < 30; i += 1) insert(db, `normal${i}.com`, day);
  for (let i = 0; i < 10; i += 1) insert(db, `parkedpop${i}.com`, day, { destination: ['ns1.sedoparking.com'], discovery: { homepage: { active: true, parked: true, status: 200, title: 'This domain is for sale' } } });
  for (let i = 0; i < 10; i += 1) insert(db, `ineligible${i}.xyz`, day);
  const noev = db.prepare(`INSERT INTO sale_watch_candidates (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 0, NULL, ?)`);
  for (let i = 0; i < 2500; i += 1) noev.run(`noev${i}.com`, day, day, day, day, `${day}T06:00:00Z`);
  insert(db, 'outsidepop.com', '2026-08-01');
  return { evidence: 50, noEvidence: 2500 };
}

test('production repro: window rows with no assessment row are all examined and written, and windowCoverage becomes ready', async () => {
  const db = buildDb();
  const { evidence, noEvidence } = populationFixture(db);
  store.ensureAssessmentSchema(db);
  // Production state: window candidates with NO assessment row at all (the
  // insert trigger's placeholders removed).
  db.prepare(`DELETE FROM ${store.TABLE}`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${store.TABLE}`).get().n, 0, 'no assessment rows yet');
  const before = store.windowCoverage(db, { now: NOW });
  assert.equal(before.total, evidence + noEvidence);
  assert.equal(before.dirty, before.total, 'every unassessed window row counts as dirty');
  assert.equal(before.ready, false);
  const lines = [];
  const original = evidenceModule.assessSaleEntry;
  let calls = 0;
  evidenceModule.assessSaleEntry = (entry, opts) => { calls += 1; return original(entry, opts); };
  let result;
  try {
    result = await store.ensureStoredAssessments(db, { now: NOW, windowOnly: true, log: { log: l => lines.push(l) } });
  } finally { evidenceModule.assessSaleEntry = original; }
  assert.equal(result.examined, before.total, 'the drain examines exactly the rows coverage counts');
  assert.equal(result.assessed, before.total, 'and writes every one of them');
  assert.equal(result.bulk, noEvidence, 'evidence-free rows go through the bulk SQL path');
  assert.ok(calls < evidence + 20, `adjudicator called ${calls} times for ${evidence} evidence rows (no per-row call for evidence-free rows)`);
  const after = store.windowCoverage(db, { now: NOW });
  assert.equal(after.dirty, 0);
  assert.equal(after.stale, 0);
  assert.equal(after.ready, true);
  assert.equal(result.windowComplete, true, 'window marker flips');
  // Every window candidate has a stored row; the outside row is untouched by the window pass.
  const stored = db.prepare(`SELECT COUNT(*) AS n FROM ${store.TABLE} WHERE dirty = 0 AND version = ?`).get(evidenceModule.VERSION).n;
  assert.equal(stored, before.total);
  // Ineligible and excluded rows are stored with their tier.
  const tierOf = d => db.prepare(`SELECT tier, eligible FROM ${store.TABLE} WHERE domain = ?`).get(d);
  assert.equal(tierOf('parkedpop0.com').tier, 'excluded');
  assert.equal(tierOf('ineligible0.xyz').eligible, 0);
  assert.ok(tierOf('ineligible0.xyz').tier);
  const noevRow = db.prepare(`SELECT tier, classification, assessment_json, views FROM ${store.TABLE} WHERE domain = 'noev0.com'`).get();
  assert.ok(noevRow.tier && JSON.parse(noevRow.assessment_json).assessedBy === 'bulk-no-evidence');
  // The excluded and all views read from the store.
  const excluded = store.readStoredLedgerEntries(db, { view: 'excluded', days: 7, now: NOW, limit: 100 });
  assert.equal(excluded.status, 'ready');
  assert.ok(excluded.entries.some(e => e.domain === 'parkedpop0.com'));
  const all = store.readStoredLedgerEntries(db, { view: 'all', days: 7, now: NOW, limit: 1000 });
  assert.ok(all.entries.some(e => e.domain === 'normal0.com') && all.entries.some(e => e.domain === 'parkedpop0.com'));
  // Per-phase log line with examined / written / dropped counts.
  assert.ok(lines.some(l => /bulk-window: 2500 examined, 2500 written \(2500 bulk\).*0 dropped/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /assess-window: \d+ examined, \d+ written .*dropped/.test(l)), lines.join('\n'));
  db.close();
});

test('bulk evidence-free assessment equals the adjudicator result for the same row', async () => {
  const db = buildDb();
  const noev = db.prepare(`INSERT INTO sale_watch_candidates (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 0, NULL, ?)`);
  noev.run('freshnoev.com', '2026-10-27', '2026-10-27', '2026-10-27', '2026-10-27', '2026-10-28T06:00:00.000Z');
  noev.run('stalenoev.com', '2026-10-05', '2026-10-05', '2026-10-05', '2026-10-05', '2026-10-05T06:00:00.000Z');
  await store.ensureStoredAssessments(db, { now: NOW, windowOnly: true, log: null });
  for (const domain of ['freshnoev.com', 'stalenoev.com']) {
    const row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get(domain);
    const expected = store.assessCandidateRow({ ...row, eligible: 0, strong: 0, alpha_pre: 0 }, { now: NOW });
    const got = db.prepare(`SELECT * FROM ${store.TABLE} WHERE domain = ?`).get(domain);
    assert.equal(got.tier, expected.tier, domain);
    assert.equal(got.classification, expected.classification, domain);
    assert.equal(got.rationale, expected.rationale, domain);
    assert.equal(got.evidence_rank, expected.rank, domain);
    assert.equal(got.report_date, expected.reportDate, domain);
    assert.equal(got.refresh_at, expected.refreshAt, `${domain} refresh_at`);
    assert.equal(JSON.parse(got.assessment_json).stale, JSON.parse(expected.assessmentJson).stale, domain);
  }
  db.close();
});

test('a window batch that meets a held write lock is retried, not reported as a 0-row pass', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-busy-'));
  const file = path.join(dir, 'busy.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  for (let i = 0; i < 40; i += 1) insert(db, `busyrow${i}.com`, '2026-10-26');
  store.ensureAssessmentSchema(db);
  db.pragma('busy_timeout = 20');
  const other = new Database(file);
  other.exec('BEGIN IMMEDIATE');
  const release = setTimeout(() => other.exec('COMMIT'), 120);
  try {
    const result = await store.ensureStoredAssessments(db, { now: NOW, windowOnly: true, log: null });
    assert.ok(result.busyRetries > 0, 'the held lock forced at least one retry');
    assert.equal(result.examined, 40);
    assert.equal(result.assessed, 40);
    assert.equal(store.windowCoverage(db, { now: NOW }).ready, true);
  } finally {
    clearTimeout(release);
    try { if (other.inTransaction) other.exec('COMMIT'); } catch (_) { /* ignore */ }
    other.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
