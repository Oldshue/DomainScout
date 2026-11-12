'use strict';

// Sale Watch daily pages carry verified whole-root extension counts from the
// same receipts the Research extension-count column uses: verified shown,
// unverified shows nothing (and is queued), one bounded batch per page, a
// per-domain cache, and index-driven reads (query plan asserted).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const ec = require('../server/sale-watch-extension-counts');

const UNIVERSE = { id: 'iana-root-tlds', version: 'v1:delegation-v3', count: 3, tlds: ['com', 'net', 'io'] };

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE base_tld_counts (base_name TEXT PRIMARY KEY, tld_count INTEGER NOT NULL DEFAULT 0, source TEXT, updated_at TEXT);
    CREATE INDEX idx_base_tld_counts_count ON base_tld_counts(tld_count DESC, base_name);
    CREATE TABLE tld_check_cache (base_name TEXT PRIMARY KEY, count INTEGER NOT NULL, taken_json TEXT NOT NULL, all_count INTEGER NOT NULL, source TEXT, checked_at TEXT,
      universe_id TEXT, universe_version TEXT, checked_count INTEGER NOT NULL DEFAULT 0, total_count INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
      coverage_status TEXT NOT NULL DEFAULT 'partial', evidence_json TEXT NOT NULL DEFAULT '[]', failures_json TEXT NOT NULL DEFAULT '[]', checked_waves_json TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX idx_tld_check_cache_count ON tld_check_cache(count);
  `);
  const now = new Date().toISOString();
  const ev = tlds => JSON.stringify(tlds.map(tld => ({ tld, status: 'taken', source: 'dns', checkedAt: now })));
  const putCount = db.prepare('INSERT INTO base_tld_counts(base_name, tld_count, source) VALUES (?, ?, ?)');
  const putReceipt = db.prepare(`INSERT INTO tld_check_cache(base_name, count, taken_json, all_count, universe_id, universe_version, checked_count, total_count, completed_at, coverage_status, evidence_json)
    VALUES (?, ?, '[]', 3, ?, ?, ?, 3, ?, ?, ?)`);
  // Verified: complete current receipt.
  putCount.run('brightpath', 2, 'nameverse-complete');
  putReceipt.run('brightpath', 2, UNIVERSE.id, UNIVERSE.version, 3, now, 'complete', ev(['com', 'io']));
  // Partial receipt (a lower bound): never a count.
  putCount.run('rivo', 1, 'nameverse-complete');
  putReceipt.run('rivo', 1, UNIVERSE.id, UNIVERSE.version, 2, now, 'partial', ev(['com']));
  // Zone-index observation only: no receipt at all.
  putCount.run('oldmill', 5, 'zone-index');
  return db;
}

test('reader: a verified whole-root receipt yields its count; partial or zone-only yields nothing', () => {
  const db = fixtureDb();
  const { counts } = ec.readVerifiedExtensionCounts(db, { bases: ['brightpath', 'rivo', 'oldmill', 'nothere'], universe: UNIVERSE });
  assert.deepEqual(JSON.parse(JSON.stringify(counts)), { brightpath: 2 });
  const wrongVersion = ec.readVerifiedExtensionCounts(db, { bases: ['brightpath'], universe: { ...UNIVERSE, version: 'old' } });
  assert.deepEqual(JSON.parse(JSON.stringify(wrongVersion.counts)), {});
});

test('reader: both statements are driven by the primary-key indexes, never a table scan', () => {
  const db = fixtureDb();
  const plan = (sql, args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(args).map(r => r.detail).join('\n');
  const a = plan(ec.SQL.receiptCandidates, { bases: '["a"]', source: 'nameverse:x' });
  const b = plan(ec.SQL.receipts, { bases: '["a"]', universeId: 'u', universeVersion: 'v', totalCount: 1 });
  for (const p of [a, b]) {
    assert.match(p, /USING (?:INDEX sqlite_autoindex_\w+_1|PRIMARY KEY) \(base_name=\?\)/, p);
    assert.doesNotMatch(p, /SCAN (?:base_tld_counts|tld_check_cache)\b/, p);
  }
  assert.ok(ec.MAX_BATCH <= 200, 'bounded batch');
});

const page = () => ({ days: [
  { day: '2026-11-12', rows: [{ domain: 'brightpath.com', derived: { tape: 'aftermarket' } }, { domain: 'rivo.com', derived: { tape: 'aftermarket' } }] },
  { day: '2026-11-11', rows: [{ domain: 'oldmill.net', derived: { tape: 'aftermarket' } }, { domain: 'brightpath.io', derived: { tape: 'aftermarket' } }] },
] });

test('enricher: one batch per page, verified shown, unverified nothing and queued, cache reused', async () => {
  const db = fixtureDb();
  const calls = [];
  const queued = [];
  const enricher = ec.createDailyExtensionEnricher({
    readCounts: async bases => { calls.push(bases); return ec.readVerifiedExtensionCounts(db, { bases, universe: UNIVERSE }); },
    enqueue: bases => queued.push(...bases),
  });
  const first = await enricher.enrich(page());
  assert.equal(calls.length, 1, 'one batch for the whole page');
  assert.deepEqual(calls[0].slice().sort(), ['brightpath', 'oldmill', 'rivo']);
  const rows = first.days.flatMap(d => d.rows);
  const by = Object.fromEntries(rows.map(r => [r.domain, r.derived.otherExtensions]));
  assert.deepEqual(by, { 'brightpath.com': 2, 'rivo.com': null, 'oldmill.net': null, 'brightpath.io': 2 });
  assert.deepEqual(queued.slice().sort(), ['oldmill', 'rivo'], 'unverified names go to the whole-root queue');
  await enricher.enrich(page());
  assert.equal(calls.length, 1, 'per-domain cache: no second read for the same names');
});

test('enricher: a busy reader leaves rows without a count, never an estimate', async () => {
  const enricher = ec.createDailyExtensionEnricher({ readCounts: async () => { throw new Error('db-read-worker-timeout'); } });
  const out = await enricher.enrich(page());
  for (const r of out.days.flatMap(d => d.rows)) assert.equal(r.derived.otherExtensions, null);
});

test('row: "taken in N extensions" only for a verified count', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const elements = {};
  const el = id => elements[id] || (elements[id] = { id, textContent: '', innerHTML: '', value: '', hidden: false, style: {}, dataset: {}, focus() {} });
  const context = {
    URLSearchParams, AbortController, console,
    document: { body: {}, addEventListener() {}, getElementById: el, querySelector: () => ({ style: {}, contains: () => false }), querySelectorAll: () => [] },
    localStorage: { getItem: k => (k === 'saleWatchIncludeCandidates' ? '1' : null), setItem() {} },
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame() { return 0; },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ days: [] }) }),
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app;`, context);
  const app = context.__app;
  app._saleWatchDaily = { days: [{ day: '2026-11-12', rows: [
    { domain: 'brightpath.com', derived: { tape: 'aftermarket', otherExtensions: 12, otherExtensionsVerified: true } },
    { domain: 'rivo.com', derived: { tape: 'aftermarket', otherExtensions: null } },
  ] }], pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  const rowOf = d => html.slice(html.indexOf(`data-domain="${d}"`), html.indexOf('</summary>', html.indexOf(`data-domain="${d}"`)));
  assert.match(rowOf('brightpath.com'), /<span data-fact="extensions">taken in 12 extensions<\/span>/);
  assert.doesNotMatch(rowOf('rivo.com'), /data-fact="extensions"|taken in|at least|≥|~/i);
});
