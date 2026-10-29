'use strict';

// Sale Watch UI never dead-ends on a transient 503 (read-lane timeout) or 202
// (stored assessment still being built): rows stay on screen, the status says
// "Still computing, retrying…", and the retry honours retryAfterMs with a
// ~2 minute total budget before an error. Background refreshes never mutate
// the visible list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

function loadFrontend(responses) {
  const timers = [];
  const elements = {};
  const el = id => elements[id] || (elements[id] = { id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, style: {}, focus() {} });
  const document = {
    body: {},
    activeElement: null,
    addEventListener() {},
    getElementById: el,
    querySelector: () => ({ style: {}, contains: () => false }),
    querySelectorAll: () => [],
  };
  const fetches = [];
  const context = {
    URLSearchParams, AbortController, console, document,
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval() {}, clearInterval() {},
    requestAnimationFrame() { return 0; },
    fetch: async url => {
      fetches.push(url);
      const next = responses.shift() || { status: 200, body: { entries: [], excludedEntries: [], pagination: {} } };
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
    },
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  const app = context.__app;
  let renders = 0;
  app.renderSaleWatch = () => { renders += 1; };
  context.__state.stream = '_salewatch';
  return { app, el, timers, fetches, renders: () => renders };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('loadSaleWatch: 503 and 202 keep rows on screen, say "Still computing, retrying…", and retry with backoff honouring retryAfterMs', async () => {
  const ui = loadFrontend([
    { status: 503, body: { error: 'Sale Watch ledger is temporarily unavailable', detail: 'db-read-worker-timeout', retryAfterMs: 4000 } },
    { status: 202, body: { status: 'pending', retryAfterMs: 5000 } },
    { status: 200, body: { entries: [{ domain: 'fresh.com', classification: 'likely-sale', tier: 'probable' }], excludedEntries: [], pagination: { nextCursor: null } } },
  ]);
  const { app, el, timers } = ui;
  app._saleWatchRows = [{ domain: 'kept.com', classification: 'likely-sale' }];
  el('sale-watch-list').innerHTML = '<div>kept.com</div>';

  await app.loadSaleWatch(true);
  assert.equal(el('sale-watch-status').textContent, 'Still computing, retrying…');
  assert.equal(el('sale-watch-list').innerHTML, '<div>kept.com</div>', 'current rows stay on screen');
  assert.doesNotMatch(el('sale-watch-list').innerHTML, /could not load/);
  assert.equal(app._saleWatchRows[0].domain, 'kept.com');
  assert.ok(timers.at(-1).ms >= 4000, `retry honours retryAfterMs (${timers.at(-1).ms})`);

  await timers.at(-1).fn();
  await flush();
  assert.equal(el('sale-watch-status').textContent, 'Still computing, retrying…', '202 pending also retries');
  assert.ok(timers.at(-1).ms >= 5000);

  await timers.at(-1).fn();
  await flush();
  assert.equal(ui.fetches.length, 3);
  assert.ok(app._saleWatchRows.some(row => row.domain === 'fresh.com'), 'the eventual 200 renders');
  assert.ok(ui.renders() >= 1);
  assert.equal(app._saleWatchPending, false);
});

test('retry budget: backoff doubles, honours retryAfterMs, and gives up after about 2 minutes', () => {
  const { app } = loadFrontend([]);
  const t0 = 1_000_000;
  assert.equal(app._retryDelay('ledger', 'k', 0, t0), 2000);
  assert.equal(app._retryDelay('ledger', 'k', 0, t0 + 2000), 4000);
  assert.equal(app._retryDelay('ledger', 'k', 9000, t0 + 6000), 9000, 'retryAfterMs is a minimum');
  assert.ok(app._retryDelay('ledger', 'k', 0, t0 + 115000) <= 5000, 'never past the budget');
  assert.equal(app._retryDelay('ledger', 'k', 0, t0 + 121000), null, 'budget spent -> caller shows the error');
  assert.equal(app._retryDelay('ledger', 'other', 0, t0 + 121000), 2000, 'a new request key starts a fresh budget');
});

test('loadSaleWatch shows the error only once the retry budget is spent, and keeps existing rows', async () => {
  const ui = loadFrontend([{ status: 503, body: { error: 'Sale Watch ledger is temporarily unavailable' } }]);
  const { app, el } = ui;
  app._saleWatchRows = [{ domain: 'kept.com' }];
  el('sale-watch-list').innerHTML = '<div>kept.com</div>';
  app._retryLanes = { ledger: { key: '|probable|7|', startedAt: Date.now() - 130000, attempt: 6 } };
  await app.loadSaleWatch(true);
  assert.match(el('sale-watch-status').textContent, /Ledger unavailable/);
  assert.equal(el('sale-watch-list').innerHTML, '<div>kept.com</div>', 'rows on screen are never replaced by the error card');
});

test('background Sale Watch success checks freshness without replacing rows or rendering', async () => {
  const ui = loadFrontend([{ status: 200, body: {
    entries: [{ domain: 'newer.com', classification: 'likely-sale', tier: 'probable', reportDate: '2026-10-29' }],
    excludedEntries: [], pagination: { nextCursor: null },
  } }]);
  const { app, el } = ui;
  app._saleWatchRows = [{ domain: 'reader-position.com', classification: 'likely-sale', reportDate: '2026-10-20' }];
  app._saleWatchLedger = { entries: app._saleWatchRows };
  await app.loadSaleWatch(true, false, true);
  assert.deepEqual(app._saleWatchRows.map(row => row.domain), ['reader-position.com']);
  assert.deepEqual(app._saleWatchLedger.entries.map(row => row.domain), ['reader-position.com']);
  assert.equal(ui.renders(), 0);
  assert.match(el('sale-watch-status').textContent, /refresh to apply any list changes/);
});
