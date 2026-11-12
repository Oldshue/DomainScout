'use strict';

// Sale Watch day-by-day feed: days render as separate sections with their own
// header, the header counts only the tape shown (the tapes are never summed),
// the tape switch persists and refetches, and a row without a stored insight
// shows its derived fields with no pending mark.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

function loadFrontend(responses = []) {
  const elements = {};
  const el = id => elements[id] || (elements[id] = { id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, style: {}, dataset: {}, focus() {} });
  const store = { saleWatchIncludeCandidates: '1' };
  const document = {
    body: {}, activeElement: null, addEventListener() {}, getElementById: el,
    querySelector: () => ({ style: {}, contains: () => false }), querySelectorAll: () => [],
  };
  const fetches = [];
  const context = {
    URLSearchParams, AbortController, console, document,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    requestAnimationFrame() { return 0; },
    fetch: async url => {
      fetches.push(url);
      const body = responses.shift() || { days: [], pagination: { nextCursor: null } };
      return { ok: true, status: 200, json: async () => body };
    },
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  context.__state.stream = '_salewatch';
  return { app: context.__app, el, fetches, store };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

const days = [
  { day: '2026-11-12', counts: { aftermarket: 2, builder: 5, noise: 1 }, byVenue: [{ venue: 'Afternic', n: 2 }], byExtension: [{ extension: 'com', n: 2 }],
    rows: [
      { domain: 'brightpath.com', classification: 'likely-sale', derived: { tape: 'aftermarket', venue: 'Afternic', buyerTitle: 'BrightPath Health', buyerUrl: 'https://brightpath.com/', extension: 'com', lengthBand: '9-12', tier: 'likely-sale', timeline: [] }, insight: null },
      { domain: 'rivo.com', derived: { tape: 'aftermarket', venue: 'Afternic', extension: 'com', lengthBand: '4-5', registeredYear: 2004, timeline: [] }, insight: { construction: 'invented', buyerType: 'startup', category: 'fintech app', lesson: 'Short invented .com names are selling to funded startups.' } },
    ] },
  { day: '2026-11-11', counts: { aftermarket: 1, builder: 3, noise: 0 }, byVenue: [{ venue: 'Sedo', n: 1 }],
    rows: [{ domain: 'oldmill.net', derived: { tape: 'aftermarket', venue: 'Sedo', extension: 'net', timeline: [] }, insight: null }] },
];

test('day feed: one section per day, header counts only the tape shown, insight fields optional, no pending mark', () => {
  const { app, el } = loadFrontend();
  app._saleWatchDaily = { days, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  assert.equal((html.match(/class="sale-watch-day"/g) || []).length, 2);
  assert.ok(html.indexOf('2026-11-12') < html.indexOf('2026-11-11'), 'newest day first');
  assert.match(html, /<strong>2026-11-12<\/strong> <span>1 sold · 1 more candidate<\/span>/);
  assert.match(html, /<strong>2026-11-11<\/strong> <span>0 sold · 1 more candidate<\/span>/);
  const heads = html.slice(html.indexOf('<section'));
  assert.doesNotMatch(heads, /(8|7|4) more candidates/, 'tapes are never summed');
  assert.equal(el('sale-watch-subtitle').textContent, 'Loaded days: 1 sold through resellers, 2 more candidates', 'hero line sums one tape only');
  assert.doesNotMatch(html, /builders going live/i);
  assert.match(html, /left Afternic/);
  assert.match(html, /href="https:\/\/brightpath.com\/"/);
  assert.match(html, /invented/);
  assert.match(html, /Short invented \.com names/);
  assert.match(html, /reg\. 2004/);
  assert.doesNotMatch(html, /pending/i, 'no insight pending mark');
});

test('tape switch: builder is persisted, refetched with tape=builder and counted on its own', async () => {
  const { app, el, fetches, store } = loadFrontend([{ days, pagination: { nextCursor: null } }]);
  app.setSaleWatchTape('builder');
  await flush(); await flush();
  assert.equal(store.saleWatchTape, 'builder');
  assert.ok(fetches.some(u => /\/api\/sale-watch\/daily\?/.test(u) && /tape=builder/.test(u)), fetches.join('\n'));
  const html = el('sale-watch-daily').innerHTML;
  assert.match(html, /0 live · 5 more candidates/);
  assert.match(html, /0 live · 3 more candidates/);
  assert.equal(el('sale-watch-subtitle').textContent, 'Loaded days: 0 builders live, 8 more candidates');
  assert.doesNotMatch(html, /bought from resellers/i);
  app.setSaleWatchTape('noise-or-anything');
  assert.equal(store.saleWatchTape, 'builder', 'unknown tape ignored');
});

test('day feed default tape is aftermarket and the default window is 14 days', async () => {
  const { app, fetches } = loadFrontend();
  await app.loadSaleWatchDaily();
  const u = fetches.find(x => /\/api\/sale-watch\/daily/.test(x));
  assert.match(u, /tape=aftermarket/);
  const from = Date.parse(/from=(\d{4}-\d{2}-\d{2})/.exec(u)[1]);
  const to = Date.parse(/to=(\d{4}-\d{2}-\d{2})/.exec(u)[1]);
  assert.equal((to - from) / 86400000, 13);
});
