'use strict';

// Sale Watch search relevance on the snapshot path: name word (segment or,
// for longer terms, label prefix/suffix) first, then theme, site title, site
// text; every row labelled; short terms (3 characters or fewer) match whole
// words only; the page counts matches by name versus by site.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ins = require('../server/sale-watch-insights');

const row = (domain, words, hp = {}, rank = 0) => ({ domain, reportDate: '2026-11-12', classification: 'likely-sale', evidenceRank: rank,
  discovery: { homepage: hp }, derived: { tape: 'aftermarket', sold: true, soldReason: 'registrar transfer', words, wordPairs: [], invented: false } });
const snapshot = rows => ({ schema: ins.SNAPSHOT_SCHEMA, status: 'ready', generatedAt: '2026-11-12T12:00:00Z', from: '2026-10-30', to: '2026-11-12', rows });
const serve = (s, q) => ins.serveDailyFromSnapshot(s, { from: s.from, to: s.to, tape: 'aftermarket', q });
const flat = page => page.days.flatMap(d => d.rows).map(r => [r.domain, r.matchedOn]);

test('short term "ai": whole name segments and whole site words only, never inside a longer word', () => {
  const s = snapshot([
    row('chairshop.com', ['chair', 'shop'], { title: 'Chairs for sale', textSample: 'We sell chairs and repairs' }),
    row('oakdesk.com', ['oak', 'desk'], { textSample: 'built with ai tools' }, 0),
    row('getai.com', ['get', 'ai'], {}, 5),
    row('plainsail.com', ['plain', 'sail'], { textSample: 'sailing trips' }),
  ]);
  const page = serve(s, 'ai');
  assert.deepEqual(flat(page), [['getai.com', 'name'], ['oakdesk.com', 'site text']], 'name match ranks first even with a weaker evidence rank');
  assert.deepEqual(page.matchCounts, { name: 1, theme: 0, siteTitle: 0, siteText: 1, site: 1 });
});

test('longer term: label prefix/suffix and segments are name matches, then site title, then site text', () => {
  const s = snapshot([
    row('otherco.com', ['other', 'co'], { textSample: 'my notes, organised' }),
    row('bluedesk.com', ['blue', 'desk'], { title: 'Blue Notes app' }),
    row('notesy.com', [], {}),
    row('quicknotes.io', ['quick', 'notes'], {}),
    row('denoted.com', ['de', 'noted'], { textSample: 'denotes things' }),
  ]);
  const page = serve(s, 'notes');
  assert.deepEqual(flat(page), [['notesy.com', 'name'], ['quicknotes.io', 'name'], ['bluedesk.com', 'site title'], ['otherco.com', 'site text']]);
  assert.deepEqual(page.matchCounts, { name: 2, theme: 0, siteTitle: 1, siteText: 1, site: 2 });
  assert.equal(serve(s, '').matchCounts, undefined, 'no counts without a search');
  assert.equal(s.rows[0].matchedOn, undefined, 'snapshot rows are never mutated');
});

test('screen: each search row shows its matched tag and the count line splits name versus site', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const els = {}; const el = id => els[id] || (els[id] = { id, textContent: '', innerHTML: '', style: {}, dataset: {}, focus() {} });
  const kv = { saleWatchIncludeCandidates: '1' };
  const ctx = { URLSearchParams, AbortController, console,
    document: { body: {}, addEventListener() {}, getElementById: el, querySelector: () => ({ style: {}, contains: () => false }), querySelectorAll: () => [] },
    localStorage: { getItem: k => (k in kv ? kv[k] : null), setItem: (k, v) => { kv[k] = String(v); } },
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame() { return 0; },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ days: [] }) }) };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, ctx);
  const app = ctx.__app;
  const s = snapshot([row('oakdesk.com', ['oak', 'desk'], { textSample: 'built with ai tools' }), row('getai.com', ['get', 'ai'], {}, 5)]);
  app._saleWatchQuery = 'ai';
  app._saleWatchDaily = serve(s, 'ai');
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  assert.match(html, /matched: name/);
  assert.match(html, /matched: site text/);
  assert.ok(html.indexOf('getai.com') < html.indexOf('oakdesk.com'), 'name match first on screen');
  assert.match(html, /id="sale-watch-match-count">1 matched by name · 0 by theme · 1 by site \(0 title, 1 text\)</);
});
