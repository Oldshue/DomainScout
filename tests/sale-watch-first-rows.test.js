'use strict';

// Time to first rows when the app opens directly on Sale Watch
// (/?stream=_salewatch): the stored window renders before any network answer,
// the feed request is the first request out, and the unrelated startup
// fetches (stats, GoDaddy refresh) wait until the feed has answered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const flush = () => new Promise(r => setImmediate(r));

function boot({ cached = true } = {}) {
  const els = {};
  const mk = id => ({ id, textContent: '', innerHTML: '', value: '', checked: false, hidden: false, disabled: false, options: [],
    style: { setProperty() {} }, dataset: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, addEventListener() {}, appendChild() {}, focus() {}, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [], contains: () => false, getBoundingClientRect: () => ({ height: 40 }) });
  const el = id => els[id] || (els[id] = mk(id));
  const store = { saleWatchIncludeCandidates: '1', saleWatchWindow: '14' };
  if (cached) store['saleWatchDaily.v1.aftermarket'] = JSON.stringify({ v: 1, tape: 'aftermarket', savedAt: '2026-11-12T08:00:00Z', generatedAt: '2026-11-12T08:00:00Z',
    data: { days: [{ day: '2026-11-11', counts: { aftermarket: 1, builder: 0, noise: 0 }, rows: [{ domain: 'storedrow.com', classification: 'likely-sale', derived: { tape: 'aftermarket', sold: true, soldReason: 'registrar transfer', timeline: [] } }] }], pagination: { nextCursor: null } } });
  const log = [];
  let releaseFeed;
  const feed = new Promise(r => { releaseFeed = r; });
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const location = { protocol: 'http:', search: '?stream=_salewatch', pathname: '/' };
  const history = { state: null, pushState() {}, replaceState() {} };
  const ctx = {
    URLSearchParams, AbortController, console, location, history,
    document: { body: {}, activeElement: null, addEventListener() {}, getElementById: el, querySelector: () => mk('q'), querySelectorAll: () => [] },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    window: { location, history, addEventListener() {}, scrollTo() {}, scrollY: 0 },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame() { return 0; },
    fetch: url => {
      log.push({ fetch: String(url), rowsOnScreen: /storedrow\.com|freshrow\.com/.test(el('sale-watch-daily').innerHTML) });
      if (/\/api\/sale-watch\/daily/.test(url)) return feed.then(ok);
      return Promise.resolve(ok({}));
    },
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, ctx);
  return { app: ctx.__app, state: ctx.__state, el, log, releaseFeed };
}

test('opening /?stream=_salewatch: stored rows render first, the feed request goes out first and alone, startup fetches wait for its answer', async () => {
  const { app, el, log, releaseFeed } = boot();
  let initError = null;
  const init = app.init();
  init.catch(e => { initError = e; });
  await Promise.resolve();
  assert.equal(initError, null, `init threw: ${initError && initError.stack}`);
  // Before any network answer: stored rows on screen.
  assert.match(el('sale-watch-daily').innerHTML, /storedrow\.com/, 'stored window on screen before any network answer');
  assert.ok(log.length >= 1, 'feed requested immediately');
  assert.match(log[0].fetch, /\/api\/sale-watch\/daily\?window=14&/, 'the feed is the first request');
  assert.equal(log[0].rowsOnScreen, true, 'rows were on screen when the feed request went out');
  await flush();
  assert.deepEqual(log.map(x => x.fetch).filter(u => !/sale-watch\/daily/.test(u)), [], 'no unrelated startup fetch before the feed answers');
  releaseFeed({ days: [{ day: '2026-11-12', counts: { aftermarket: 1, builder: 0, noise: 0 }, rows: [{ domain: 'freshrow.com', classification: 'likely-sale', derived: { tape: 'aftermarket', sold: true, soldReason: 'registrar transfer', timeline: [] } }] }], pagination: { nextCursor: null } });
  for (let i = 0; i < 5; i += 1) await flush();
  assert.match(el('sale-watch-daily').innerHTML, /freshrow\.com/, 'rendered as soon as the feed answered');
  const urls = log.map(x => x.fetch);
  const feedAt = urls.findIndex(u => /sale-watch\/daily/.test(u));
  const statsAt = urls.findIndex(u => /\/api\/stats/.test(u));
  assert.ok(statsAt > feedAt, 'stats requested only after the feed answered');
  void init;
});

test('the navigation restore never blanks rows already on screen', () => {
  const nav = fs.readFileSync(path.join(__dirname, '../public/js/navigation-history.js'), 'utf8');
  assert.doesNotMatch(nav, /views\._salewatch=\{[^\n]*_saleWatchDaily=null/);
});
