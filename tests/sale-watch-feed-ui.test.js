'use strict';

// Sale Watch one-screen feed (DOM-level, app.js in a vm): chip filters, the
// "Probably sold only" toggle, persistence of tape/toggle/chips across a
// reload, the search box filtering server-side (q= combined with the tape),
// and that the old flat "Probably sold" list is gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

function loadFrontend({ store = {}, responses = [] } = {}) {
  const elements = {};
  const el = id => elements[id] || (elements[id] = { id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, style: {}, dataset: {}, focus() {} });
  const timers = [];
  const document = {
    body: {}, activeElement: null, addEventListener() {}, getElementById: el,
    querySelector: () => ({ style: {}, contains: () => false }), querySelectorAll: () => [],
  };
  const fetches = [];
  const context = {
    URLSearchParams, AbortController, console, document,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    requestAnimationFrame() { return 0; },
    fetch: async url => {
      fetches.push(url);
      const body = responses.shift() || { days: [], pagination: { nextCursor: null } };
      return { ok: true, status: 200, json: async () => body };
    },
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  context.__state.stream = '_salewatch';
  const runTimers = () => { while (timers.length) timers.shift()(); };
  return { app: context.__app, el, fetches, store, runTimers };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

const DAYS = [
  { day: '2026-11-12', counts: { aftermarket: 2, builder: 0, noise: 0 }, probable: { aftermarket: 1, builder: 0, noise: 0 },
    byVenue: [{ venue: 'Afternic', n: 2 }], byExtension: [{ extension: 'com', n: 2 }],
    rows: [
      { domain: 'brightpath.com', classification: 'likely-sale', derived: { tape: 'aftermarket', probablySold: true, classification: 'likely-sale', venue: 'Afternic', extension: 'com', lengthBand: '9-11', timeline: [] }, insight: null },
      { domain: 'rivo.com', classification: 'unconfirmed-move', derived: { tape: 'aftermarket', probablySold: false, classification: 'unconfirmed-move', venue: 'Afternic', extension: 'com', lengthBand: '1-4', timeline: [] }, insight: null },
    ] },
  { day: '2026-11-11', counts: { aftermarket: 1, builder: 0, noise: 0 }, probable: { aftermarket: 0, builder: 0, noise: 0 },
    byVenue: [{ venue: 'Sedo', n: 1 }], byExtension: [{ extension: 'net', n: 1 }],
    rows: [{ domain: 'oldmill.net', classification: 'unconfirmed-move', derived: { tape: 'aftermarket', probablySold: false, venue: 'Sedo', extension: 'net', lengthBand: '7-8', timeline: [] }, insight: null }] },
];
const feed = () => ({ days: JSON.parse(JSON.stringify(DAYS)), pagination: { nextCursor: null } });
const shownDomains = html => [...html.matchAll(/data-domain="([^"]+)"/g)].map(m => m[1]);

test('chip filters narrow the feed, persist, show Clear filters, and clear all', () => {
  const { app, el, store } = loadFrontend();
  app._saleWatchDaily = feed();
  app.renderSaleWatchDaily();
  assert.deepEqual(shownDomains(el('sale-watch-daily').innerHTML), ['brightpath.com', 'rivo.com', 'oldmill.net']);
  assert.match(el('sale-watch-daily').innerHTML, /class="sale-watch-chip[^"]*" data-k="venue" data-v="Sedo"/);
  assert.equal(el('sale-watch-clear').hidden, true);
  app.toggleSaleWatchFilter('venue', 'Sedo');
  assert.deepEqual(shownDomains(el('sale-watch-daily').innerHTML), ['oldmill.net']);
  assert.deepEqual(JSON.parse(store.saleWatchDailyFilters), { venue: 'Sedo' });
  assert.equal(el('sale-watch-clear').hidden, false);
  app.toggleSaleWatchFilter('extension', 'com');
  assert.deepEqual(shownDomains(el('sale-watch-daily').innerHTML), [], 'chips combine (AND)');
  app.toggleSaleWatchFilter('*');
  assert.deepEqual(JSON.parse(store.saleWatchDailyFilters), {});
  assert.equal(el('sale-watch-clear').hidden, true);
  assert.equal(shownDomains(el('sale-watch-daily').innerHTML).length, 3);
});

test('"Probably sold only" shows only likely-sale rows, one tap, and is saved', () => {
  const { app, el, store } = loadFrontend();
  app._saleWatchDaily = feed();
  app.renderSaleWatchDaily();
  assert.equal(el('sale-watch-probable-only').dataset.on, 'false');
  app.toggleSaleWatchProbableOnly();
  assert.equal(store.saleWatchProbableOnly, '1');
  assert.equal(el('sale-watch-probable-only').dataset.on, 'true');
  assert.deepEqual(shownDomains(el('sale-watch-daily').innerHTML), ['brightpath.com']);
  app.toggleSaleWatchProbableOnly();
  assert.equal(store.saleWatchProbableOnly, '0');
  assert.equal(shownDomains(el('sale-watch-daily').innerHTML).length, 3);
});

test('tape, toggle and chips survive a reload (same storage, fresh app)', async () => {
  const store = {};
  const first = loadFrontend({ store, responses: [feed()] });
  first.app.setSaleWatchTape('builder');
  await flush();
  first.app.toggleSaleWatchProbableOnly();
  first.app.toggleSaleWatchFilter('venue', 'Afternic');
  const second = loadFrontend({ store, responses: [feed()] });
  assert.equal(second.app._saleWatchTape(), 'builder');
  assert.equal(second.app._saleWatchProbableOnly(), true);
  assert.equal(JSON.stringify(second.app._saleWatchDailyFilters()), JSON.stringify({ venue: 'Afternic' }));
  await second.app.loadSaleWatchDaily();
  assert.ok(second.fetches.some(u => /tape=builder/.test(u)), second.fetches.join('\n'));
  second.app.renderSaleWatchDaily();
  assert.equal(second.el('sale-watch-probable-only').dataset.on, 'true');
  assert.equal(second.el('sale-watch-clear').hidden, false);
});

test('the search box filters server-side with q= and combines with the tape', async () => {
  const store = { saleWatchTape: 'builder' };
  const { app, el, fetches, runTimers } = loadFrontend({ store, responses: [feed(), feed()] });
  el('sale-watch-search').value = '  BrightPath ';
  app.searchSaleWatch();
  runTimers();
  await flush(); await flush();
  const u = fetches.find(x => /\/api\/sale-watch\/daily\?/.test(x) && /q=brightpath/.test(x));
  assert.ok(u, fetches.join('\n'));
  assert.match(u, /tape=builder/);
  assert.match(el('sale-watch-daily').innerHTML, /matching “brightpath”/);
  const n = fetches.length;
  app.searchSaleWatch();
  runTimers();
  assert.equal(fetches.length, n, 'unchanged query does not refetch');
});

test('the old flat Probably sold list, its Show more and its window select are gone', () => {
  assert.doesNotMatch(indexHtml, /id="sale-watch-list"/);
  assert.doesNotMatch(indexHtml, /id="sale-watch-window"/);
  assert.doesNotMatch(indexHtml, /sale-watch-more|loadMoreSaleWatch/);
  assert.match(indexHtml, /id="sale-watch-daily"/);
  assert.match(indexHtml, /id="sale-watch-search"/);
  assert.match(indexHtml, /class="sale-watch-method"/);
  assert.doesNotMatch(source, /\bloadSaleWatch\(/);
  assert.doesNotMatch(source, /\brenderSaleWatch\(/);
  const { app, el } = loadFrontend();
  app._saleWatchDaily = feed();
  app.renderSaleWatchDaily();
  assert.equal(el('sale-watch-list').innerHTML, '', 'nothing renders into the old list');
});
