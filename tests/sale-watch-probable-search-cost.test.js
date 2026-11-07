'use strict';

// Sale Watch q search cost follows the size of the view being searched: a
// small strong view (probable) walks its own rows against their search
// documents instead of driving from the FTS index across every candidate;
// results equal the index-driven search; a large view still drives from the
// index (chosen by a bounded count); and the page never dead-ends on a 503.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');

const recon = require('../server/sale-watch-reconstruction');
const store = require('../server/sale-watch-assessments');
const search = require('../server/sale-watch-search');

const NOW = new Date('2026-10-28T12:00:00Z');
const DAYS = ['2026-10-27', '2026-10-26', '2026-10-24', '2026-10-21', '2026-10-05'];
const SELLER = ['ns1.dan.com', 'ns2.dan.com'];

function insertRow(stmt, domain, day, { probeCount = 1, discovery = {}, extra = {} } = {}) {
  const destination = ['ns1.host.example'];
  const ev = {
    domain, tier: 'suspected', reportDate: day, sellerNameservers: SELLER, buyerNameservers: destination,
    discovery: { movement: { day, prevDay: day, previousNameservers: SELLER, currentNameservers: destination, source: 'daily-zone-delegation-diff' }, structurallyMoved: true, departureDate: day, ...discovery },
    ...extra,
  };
  stmt.run(domain, day, day, day, 'exited', day, probeCount, JSON.stringify(ev), `${day}T06:00:00Z`);
}

const INSERT_SQL = `INSERT INTO sale_watch_candidates
  (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
  VALUES (?, ?, ?, 'zone-seller-departure', ?, ?, ?, ?, ?, ?)`;

// A probable-shaped row: marketplace departure + dated registrar transfer.
function probable(day, title) {
  return { discovery: { transferEvidence: { registrarChanged: true, observedAt: `${day}T05:00:00Z` },
    ...(title ? { homepage: { active: true, parked: false, placeholder: false, status: 200, title, description: title } } : {}) } };
}

// File-backed store: `probableCount` assessed probable rows (agent, unrelated
// harbor prefix, site-only and theme names), then `crowd` extra candidates
// whose names all match q=agent but are never in the probable view.
function buildFileDb({ probableCount, crowd }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-probable-search-'));
  const file = path.join(dir, 'sale_watch.db');
  const db = new Database(file);
  recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  const stmt = db.prepare(INSERT_SQL);
  const kinds = [
    i => [`agent${i}hub.com`, null],
    i => [`harbor${i}desk.com`, null],
    i => [`acme${i}works.com`, 'Agent tools for your support team'],
    i => [`llm${i}lab.com`, null],
    i => [`plainname${i}.com`, 'Team planning'],
    i => [`regagents${i}.com`, null],
  ];
  db.transaction(() => {
    for (let i = 0; i < probableCount; i += 1) {
      const day = DAYS[i % (DAYS.length - 1)];
      const [domain, title] = kinds[i % kinds.length](i);
      insertRow(stmt, domain, day, probable(day, title));
    }
    for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  })();
  store.storeAssessmentsSync(db, { now: NOW });
  // The crowd: candidates and search documents only (never assessed into a view).
  db.transaction(() => {
    for (let i = 0; i < crowd; i += 1) {
      const domain = `agentcrowd${i}.com`;
      insertRow(stmt, domain, DAYS[i % DAYS.length], { probeCount: 0, discovery: { homepage: { active: true, parked: false, placeholder: false, status: 200, title: 'AI agent platform', description: 'agents agent' } } });
      search.writeSearchDocument(db, domain, db.prepare('SELECT evidence_json FROM sale_watch_candidates WHERE domain = ?').get(domain).evidence_json);
    }
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { db, dir, file };
}

const QUERIES = ['agent', 'agents', 'harbor', 'inference', 'planning', 'ai', 'regagents1', 'nomatchzz'];

test('probable q search walks the probable view (EXPLAIN QUERY PLAN), equals the index-driven result, and a large view drives from the index', () => {
  const { db, dir } = buildFileDb({ probableCount: 60, crowd: 6000 });
  try {
    const cutoff = '2026-09-28';
    const probableRows = db.prepare("SELECT count(*) n FROM sale_watch_assessment_views WHERE view = 'probable'").get().n;
    const candidates = db.prepare('SELECT count(*) n FROM sale_watch_candidates').get().n;
    assert.ok(probableRows >= 40 && probableRows <= 60, `small probable view (${probableRows})`);
    assert.ok(candidates > 6000, `many candidates (${candidates})`);

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${store.viewSearchWalkSql(db, { windowed: true })}`).all({ view: 'probable', cutoff });
    const details = plan.map(row => row.detail);
    assert.match(details[0], /^SEARCH v USING PRIMARY KEY \(view=\? AND report_date>\?\)/, `view drives: ${details.join(' | ')}`);
    assert.ok(details.some(d => /SEARCH d USING INDEX/.test(d)), `documents looked up per view row: ${details.join(' | ')}`);
    assert.ok(!details.some(d => /VIRTUAL TABLE|sale_watch_search\b|SCAN d\b/.test(d)), `no FTS or docs scan: ${details.join(' | ')}`);

    for (const q of QUERIES) {
      const viaView = store.readStoredLedgerEntries(db, { view: 'probable', days: 30, q, now: NOW, limit: 1000 });
      const viaIndex = store.readStoredLedgerEntries(db, { view: 'probable', days: 30, q, now: NOW, limit: 1000, searchDriving: 'index' });
      assert.equal(viaView.search.driving, 'view', `${q}: small view drives`);
      assert.equal(viaIndex.search.driving, 'index');
      assert.deepEqual(viaView.entries.map(e => e.domain), viaIndex.entries.map(e => e.domain), `q=${q}: same rows, same order`);
      const why = entries => entries.map(e => { const m = search.matchDocument(search.buildSearchDocument(e.domain, e), q, e.domain); return [e.domain, m && m.matchedOn, m && m.matchedTerm]; });
      assert.deepEqual(why(viaView.entries), why(viaIndex.entries), `q=${q}: same matchedOn`);
    }
    // Fixture covers name, unrelated prefix, site and theme matches.
    const agent = store.readStoredLedgerEntries(db, { view: 'probable', days: 30, q: 'agent', now: NOW });
    assert.ok(agent.entries.some(e => e.domain.startsWith('agent')) && agent.entries.some(e => e.domain.startsWith('acme')), 'name and site matches');
    assert.ok(agent.entries.every(e => !e.domain.startsWith('agentcrowd')), 'crowd never leaks into probable');
    assert.ok(store.readStoredLedgerEntries(db, { view: 'probable', days: 30, q: 'harbor', now: NOW }).entries.every(e => e.domain.startsWith('harbor')));
    // Cursor paging over the view-driven search equals the index-driven slice.
    const all = store.readStoredLedgerEntries(db, { view: 'probable', days: 30, q: 'agent', now: NOW, searchDriving: 'index' }).entries;
    if (all.length > 4) {
      const first = store.readStoredLedgerEntries(db, { view: 'probable', days: 30, q: 'agent', now: NOW, limit: 2 }).entries;
      const last = first.at(-1);
      const after = { date: last.reportDate, rank: 0, domain: last.domain };
      assert.deepEqual(store.readStoredLedgerEntries(db, { view: 'probable', days: 30, q: 'agent', now: NOW, limit: 2, after }).entries.map(e => e.domain),
        store.readStoredLedgerEntries(db, { view: 'probable', days: 30, q: 'agent', now: NOW, limit: 2, after, searchDriving: 'index' }).entries.map(e => e.domain));
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // A view larger than VIEW_WALK_MAX keeps the index-driven search; the count is capped.
  const big = new Database(':memory:');
  recon.ensureReconstructionSchema(big);
  store.ensureAssessmentSchema(big);
  const add = big.prepare('INSERT INTO sale_watch_assessment_views (view, report_date, evidence_rank, dlen, domain) VALUES (?, ?, 7, ?, ?)');
  big.transaction(() => { for (let i = 0; i < store.VIEW_WALK_MAX + 50; i += 1) add.run('all', DAYS[i % DAYS.length], 12, `bulk${i}.com`); })();
  const strategy = store.viewSearchStrategy(big, { view: 'all', cutoff: '2026-09-28' });
  assert.equal(strategy.driving, 'index');
  assert.equal(strategy.capped, true);
  assert.equal(store.viewSearchStrategy(big, { view: 'probable', cutoff: '2026-09-28' }).driving, 'view');
  big.close();
});

test('a q search on a 1,000-row probable view answers within a second on a freshly opened file-backed store with many matching candidates', () => {
  const { db, dir, file } = buildFileDb({ probableCount: 1000, crowd: 30000 });
  db.close();
  // Measured in a fresh process: a new read-only handle with an empty SQLite
  // page cache and none of the builder's heap, like a production reader.
  const script = `
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const store = require(${JSON.stringify(path.join(__dirname, '../server/sale-watch-assessments'))});
    const reader = new Database(${JSON.stringify(file)}, { readonly: true });
    const probable = reader.prepare("SELECT count(*) n FROM sale_watch_assessment_views WHERE view = 'probable'").get().n;
    const started = process.hrtime.bigint();
    const page = store.readStoredLedgerEntries(reader, { view: 'probable', days: 30, q: 'agent', now: new Date(${JSON.stringify(NOW.toISOString())}), limit: 1000 });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    reader.close();
    process.stdout.write('\\n' + JSON.stringify({ probable, ms, status: page.status, driving: page.search && page.search.driving, entries: page.entries.length }));
  `;
  try {
    const out = require('node:child_process').execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    const result = JSON.parse(out.trim().split('\n').at(-1));
    assert.ok(result.probable >= 900, `probable rows (${result.probable})`);
    assert.equal(result.status, 'ready');
    assert.equal(result.driving, 'view');
    assert.ok(result.entries > 100, `matches (${result.entries})`);
    assert.ok(result.ms < 1000, `probable q search took ${result.ms.toFixed(1)} ms (limit 1000 ms)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── page: a 503 on a search never dead-ends ───────────────────────────────

const appSource = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

function loadFrontend(responses) {
  const timers = [];
  const elements = {};
  const el = id => elements[id] || (elements[id] = { id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, style: {}, dataset: {}, focus() {} });
  const document = {
    body: {}, activeElement: null, addEventListener() {}, getElementById: el,
    querySelector: () => ({ style: {}, contains: () => false }), querySelectorAll: () => [],
  };
  const fetches = [];
  const context = {
    URLSearchParams, AbortController, console, document,
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval() {}, clearInterval() {}, requestAnimationFrame() { return 0; },
    fetch: async url => {
      fetches.push(url);
      const next = responses.shift() || { status: 503, body: { error: 'Sale Watch ledger is temporarily unavailable', detail: 'db-read-worker-timeout' } };
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
    },
  };
  vm.runInNewContext(`${appSource}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  context.__state.stream = '_salewatch';
  return { app: context.__app, el, timers, fetches };
}

const LOADED = [
  { domain: 'agentdesk.com', classification: 'likely-sale', tier: 'probable', reportDate: '2026-10-27' },
  { domain: 'harborloft.com', classification: 'likely-sale', tier: 'probable', reportDate: '2026-10-26' },
  { domain: 'plainname.com', classification: 'likely-sale', tier: 'probable', reportDate: '2026-10-25', buyerTitle: 'Agent console' },
];

test('a q search that meets 503s shows the loaded list filtered client-side and keeps retrying, even after the fast-retry budget', async () => {
  const ui = loadFrontend([]);
  const { app, el, timers } = ui;
  app._saleWatchRows = LOADED.map(row => ({ ...row }));
  app._saleWatchRowsQuery = '';
  app._saleWatchLoaded = true;
  app._saleWatchLedger = { entries: app._saleWatchRows, excludedEntries: [], pagination: { nextCursor: null } };
  el('sale-watch-search').value = 'agent';
  app._saleWatchQuery = 'agent';

  await app.loadSaleWatch(true);
  assert.match(el('sale-watch-status').textContent, /Still computing, retrying/);
  assert.match(el('sale-watch-list').innerHTML, /agentdesk\.com/);
  assert.match(el('sale-watch-list').innerHTML, /plainname\.com/, 'client-side filter covers the buyer title');
  assert.doesNotMatch(el('sale-watch-list').innerHTML, /harborloft\.com/);
  assert.doesNotMatch(el('sale-watch-list').innerHTML, /could not load|No names meet/);
  assert.ok(timers.length > 0, 'a retry is scheduled');

  // Fast-retry budget spent: still no error, still filtered, retry every 30 s.
  app._retryLanes = { ledger: { key: 'agent|probable|7|', startedAt: Date.now() - 130000, attempt: 6 } };
  await app.loadSaleWatch(true);
  assert.doesNotMatch(el('sale-watch-status').textContent, /Ledger unavailable/);
  assert.doesNotMatch(el('sale-watch-list').innerHTML, /could not load/);
  assert.match(el('sale-watch-list').innerHTML, /agentdesk\.com/);
  assert.equal(timers.at(-1).ms, 30000, 'keeps retrying the server search');
});

test('a successful server search replaces the client-side fallback with the server matches', async () => {
  const ui = loadFrontend([
    { status: 503, body: { error: 'busy', retryAfterMs: 2000 } },
    { status: 200, body: { entries: [{ domain: 'agentdesk.com', classification: 'likely-sale', tier: 'probable', reportDate: '2026-10-27', matchedOn: 'name', matchedTerm: 'agent' }], excludedEntries: [], pagination: { nextCursor: null } } },
  ]);
  const { app, el, timers } = ui;
  app._saleWatchRows = LOADED.map(row => ({ ...row }));
  app._saleWatchLoaded = true;
  el('sale-watch-search').value = 'agent';
  app._saleWatchQuery = 'agent';
  await app.loadSaleWatch(true);
  await timers.at(-1).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...app._saleWatchRows.map(r => r.domain)], ['agentdesk.com']);
  assert.match(el('sale-watch-list').innerHTML, /name: agent/);
  assert.equal(app._saleWatchPending, false);
});

test('phone width: the Sale Watch status line wraps and the toolbar stacks, so the busy-search notice stays readable', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.sale-watch-toolbar #sale-watch-status \{[^}]*white-space: normal;[^}]*flex-basis: 100%/);
  const phone = css.slice(css.indexOf('@media (max-width: 820px)'));
  assert.match(phone, /\.sale-watch-toolbar \{ align-items: stretch; flex-direction: column; \}/);
  assert.match(phone, /\.sale-watch-toolbar #sale-watch-status \{ white-space: normal; \}/);
  assert.match(phone, /\.sale-watch-toolbar input \{ width: 100%; min-width: 0; \}/);
});
