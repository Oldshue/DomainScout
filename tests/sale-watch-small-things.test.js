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

const builderRow = (domain, why) => ({ domain, classification: 'acquisition-candidate', derived: { tape: 'builder', lead: true, leadReason: why, timeline: [] } });
const resellerRow = (domain, why) => ({ domain, classification: 'likely-sale', derived: { tape: 'aftermarket', lead: true, leadReason: why, timeline: [] } });

test('the window line appears once: hero subtitle, not repeated above the list', () => {
  const { app, el } = loadFrontend();
  const win = { tape: 'aftermarket', counts: { aftermarket: 943, builder: 500, noise: 0 }, sold: { aftermarket: 888, builder: 438, noise: 0 } };
  app._saleWatchDaily = { windowDays: 14, window: win, days: [{ day: '2026-11-12', counts: { aftermarket: 1, builder: 0, noise: 0 }, leads: { aftermarket: 1, builder: 0, noise: 0 }, rows: [resellerRow('a.com', 'marketplace exit + registrar transfer')] }], pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  const line = 'Past 14 days: 888 purchase leads after seller departures';
  assert.match(el('sale-watch-subtitle').textContent, new RegExp(`^${line}`));
  assert.equal(html.split(line).length - 1, 0, 'not repeated in the list');
});

test('builder and seller-departure badges state observed evidence without claiming a sale', () => {
  const { app, el } = loadFrontend({ saleWatchTape: 'builder' });
  app._saleWatchDaily = { days: [{ day: '2026-11-12', counts: { aftermarket: 0, builder: 67, noise: 0 }, leads: { aftermarket: 0, builder: 67, noise: 0 }, rows: [builderRow('mybuild.com', 'branded site launched')] }], pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  assert.match(html, />live · branded site launched<\/span>/);
  assert.match(html, /<strong>2026-11-12<\/strong> <span>67 launches/);
  assert.equal(app._saleWatchBadge(resellerRow('r.com', 'marketplace exit + registrar transfer')), '<span class="sale-watch-tier probable">likely purchase · marketplace exit + registrar transfer</span>');
  assert.equal(app._saleWatchBadge(resellerRow('r.com', 'transfer + branded site')), '<span class="sale-watch-tier probable">likely purchase · transfer + branded site</span>');
  assert.equal(app._saleWatchBadge({ ...resellerRow('r.com', 'transfer pending'), classification: 'transfer-in-progress' }), '<span class="sale-watch-tier probable">moving · transfer pending</span>');
});
