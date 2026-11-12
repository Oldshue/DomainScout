'use strict';

// Item 5: the window line appears once (hero subtitle only), the builder tape
// badge reads 'live: own site built' (reseller reasons unchanged), and the
// builder day title counts 'N live'.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

function loadFrontend(store = {}) {
  const els = {};
  const el = id => els[id] || (els[id] = { id, textContent: '', innerHTML: '', value: '', hidden: false, style: {}, dataset: {}, focus() {} });
  const kv = { saleWatchIncludeCandidates: '1', ...store };
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

const builderRow = (domain, why) => ({ domain, classification: 'acquisition-candidate', derived: { tape: 'builder', sold: true, soldReason: why, timeline: [] } });
const resellerRow = (domain, why) => ({ domain, classification: 'likely-sale', derived: { tape: 'aftermarket', sold: true, soldReason: why, timeline: [] } });

test('the window line appears once: hero subtitle, not repeated above the list', () => {
  const { app, el } = loadFrontend();
  const win = { tape: 'aftermarket', counts: { aftermarket: 943, builder: 500, noise: 0 }, sold: { aftermarket: 888, builder: 438, noise: 0 } };
  app._saleWatchDaily = { windowDays: 14, window: win, days: [{ day: '2026-11-12', counts: { aftermarket: 1, builder: 0, noise: 0 }, sold: { aftermarket: 1, builder: 0, noise: 0 }, rows: [resellerRow('a.com', 'registrar transfer')] }], pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  const line = 'Past 14 days: 888 sold through resellers';
  assert.match(el('sale-watch-subtitle').textContent, new RegExp(`^${line}`));
  assert.equal(html.split(line).length - 1, 0, 'not repeated in the list');
});

test("builder badge reads 'live: own site built'; reseller reasons stay; builder day title says 'N live'", () => {
  const { app, el } = loadFrontend({ saleWatchTape: 'builder' });
  app._saleWatchDaily = { days: [{ day: '2026-11-12', counts: { aftermarket: 0, builder: 67, noise: 0 }, sold: { aftermarket: 0, builder: 67, noise: 0 }, rows: [builderRow('mybuild.com', 'buyer site live')] }], pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  assert.match(html, />live: own site built<\/span>/);
  assert.doesNotMatch(html, /buyer site live/i);
  assert.match(html, /<strong>2026-11-12<\/strong> <span>67 live/);
  assert.equal(app._saleWatchBadge(resellerRow('r.com', 'registrar transfer')), '<span class="sale-watch-tier probable">sold: registrar transfer</span>');
  assert.equal(app._saleWatchBadge(resellerRow('r.com', 'transfer + built site')), '<span class="sale-watch-tier probable">sold: transfer + built site</span>');
  assert.equal(app._saleWatchBadge(resellerRow('r.com', 'buyer site live')), '<span class="sale-watch-tier probable">sold: buyer site live</span>', 'reseller reason unchanged');
});
