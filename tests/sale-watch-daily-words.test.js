'use strict';

// Words that are selling: sold names are segmented with the DomainLab
// dictionary segmenter (derived.words / wordPairs / invented, built with the
// snapshot); the window serves the top 60 words and top 20 pairs over sold
// names, each day the top 10 words; a word chip filters by segmented word,
// never by substring; names that do not segment count under 'invented'.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const derive = require('../server/sale-watch-derive');
const ins = require('../server/sale-watch-insights');

const row = (domain, sold = true, day = '2026-11-12', tape = 'aftermarket') => ({ domain, reportDate: day, classification: sold ? 'likely-sale' : 'acquisition-candidate', evidenceRank: 0,
  derived: { tape, sold, soldReason: sold ? 'registrar transfer' : null, ...derive.nameWords(domain) } });

test('nameWords segments labels with the DomainLab dictionary; unsegmentable names are invented', () => {
  assert.deepEqual(derive.nameWords('cloudkitchen.com'), { words: ['cloud', 'kitchen'], wordPairs: ['cloud kitchen'], invented: false });
  assert.deepEqual(derive.nameWords('fastinference.ai').words, ['fast', 'inference']);
  assert.equal(derive.nameWords('xqzvbt.com').invented, true);
  assert.deepEqual(derive.nameWords('xqzvbt.com').words, []);
  // Each word once per name.
  assert.deepEqual(derive.nameWords('farm-farm.com').words, ['farm']);
});

test('soldWords counts each word once per sold name, invented separately, pairs, caps 60/20 and day 10', () => {
  const rows = [row('cloudkitchen.com'), row('cloudfarm.com'), row('ghostkitchen.com'), row('xqzvbt.com'), row('cloudbank.com', false)];
  const w = ins.soldWords(rows, ins.WORDS_WINDOW_MAX, ins.WORD_PAIRS_MAX);
  const n = k => (w.byWord.find(x => x.word === k) || {}).n || 0;
  assert.equal(n('cloud'), 2, 'candidates are not counted');
  assert.equal(n('kitchen'), 2);
  assert.equal(n('invented'), 1);
  assert.equal(n('bank'), 0);
  assert.ok(w.byWordPair.some(p => p.wordPair === 'cloud kitchen' && p.n === 1));
  assert.equal(ins.WORDS_WINDOW_MAX, 60); assert.equal(ins.WORD_PAIRS_MAX, 20); assert.equal(ins.WORDS_DAY_MAX, 10);
  const many = Array.from({ length: 80 }, (_, i) => ({ domain: `x${i}.com`, derived: { sold: true, words: [`w${i}`], wordPairs: [`w${i} z${i}`] } }));
  const capped = ins.soldWords(many, 60, 20);
  assert.equal(capped.byWord.length, 60); assert.equal(capped.byWordPair.length, 20);
});

test('the window summary and each day carry byWord (window also byWordPair) for the tape shown', () => {
  const rows = [row('cloudkitchen.com'), row('cloudfarm.com', true, '2026-11-11'), row('cloudbuild.com', true, '2026-11-12', 'builder')];
  const page = ins.assembleDaily({ rows }, { from: '2026-11-01', to: '2026-11-12', tape: 'aftermarket' });
  assert.deepEqual(page.window.byWord.find(x => x.word === 'cloud'), { word: 'cloud', n: 2 }, 'builder tape not counted on the aftermarket tape');
  assert.ok(Array.isArray(page.window.byWordPair));
  assert.ok(page.window.soldOnly.byWord.length > 0);
  assert.ok(page.days[0].byWord.length <= 10);
  assert.equal(page.days[0].byWordPair, undefined);
});

function loadFrontend() {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const els = {}; const el = id => els[id] || (els[id] = { id, textContent: '', innerHTML: '', style: {}, dataset: {}, focus() {} });
  const kv = { saleWatchIncludeCandidates: '1' };
  const ctx = { URLSearchParams, AbortController, console,
    document: { body: {}, addEventListener() {}, getElementById: el, querySelector: () => ({ style: {}, contains: () => false }), querySelectorAll: () => [] },
    localStorage: { getItem: k => (k in kv ? kv[k] : null), setItem: (k, v) => { kv[k] = String(v); } },
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame() { return 0; },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ days: [], pagination: { nextCursor: null } }) }) };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, ctx);
  ctx.__state.stream = '_salewatch';
  return { app: ctx.__app, el };
}

test('screen: Words is the first group in Filters and breakdown; a word chip filters by segmented word, not substring', () => {
  const { app, el } = loadFrontend();
  const rows = [row('cloudkitchen.com'), row('artboard.co'), row('cartwheel.com')];
  const page = ins.assembleDaily({ rows }, { from: '2026-11-01', to: '2026-11-12', tape: 'aftermarket' });
  app._saleWatchDaily = JSON.parse(JSON.stringify(page));
  app.renderSaleWatchDaily();
  app.toggleSaleWatchSummary({ setAttribute() {} });
  const summary = el('sale-watch-summary-groups').innerHTML;
  const labels = [...summary.matchAll(/class="sale-watch-chip-label">([^<]+)</g)].map(m => m[1]);
  assert.equal(labels[0], 'Words');
  assert.match(summary, /data-k="word" data-v="art"/);
  app.toggleSaleWatchFilter('word', 'art');
  const html = el('sale-watch-daily').innerHTML;
  assert.match(html, /data-domain="artboard.co"/);
  assert.doesNotMatch(html, /data-domain="cartwheel.com"/, 'cart does not contain the word art');
  assert.doesNotMatch(html, /data-domain="cloudkitchen.com"/);
});
