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
  const el = id => elements[id] || (elements[id] = { id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, style: {}, dataset: {}, focus() {} });
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
  const render = app.renderSaleWatch.bind(app);
  let renders = 0;
  app.renderSaleWatch = () => { renders += 1; };
  context.__state.stream = '_salewatch';
  return { app, el, timers, fetches, render, renders: () => renders };
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
  assert.match(el('sale-watch-status').textContent, /Could not refresh the list; showing the last loaded names\. Retrying automatically\./);
  assert.doesNotMatch(el('sale-watch-status').textContent, /Ledger|ledger/);
  assert.equal(el('sale-watch-list').innerHTML, '<div>kept.com</div>', 'rows on screen are never replaced by the error card');
});

test('a failed load with nothing on screen offers one tap to retry and keeps retrying itself; Check now is gone', async () => {
  const ui = loadFrontend([{ status: 500, body: { error: 'boom' } }]);
  const { app, el, timers } = ui;
  await app.loadSaleWatch(true);
  assert.match(el('sale-watch-status').textContent, /Could not load the list\. Retrying automatically\./);
  assert.match(el('sale-watch-list').innerHTML, /id="sale-watch-retry"[^>]*onclick="app\.loadSaleWatch\(true\)"[^>]*>Try again</);
  assert.ok(timers.some(t => t.ms === 30000), 'the page schedules its own refresh after a failure');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  assert.doesNotMatch(html, /sale-watch-refresh|Check now/);
  assert.doesNotMatch(css, /sale-watch-refresh/);
  assert.doesNotMatch(source, /sale-watch-refresh/);
});

test('an open page refreshes itself: a background success applies current verdicts without the Refresh button', async () => {
  const ui = loadFrontend([{ status: 200, body: {
    entries: [
      { domain: 'newer.com', classification: 'likely-sale', tier: 'probable', reportDate: '2026-10-29' },
      { domain: 'reader-position.com', classification: 'likely-sale', tier: 'probable', reportDate: '2026-10-20' },
    ],
    excludedEntries: [], pagination: { nextCursor: null },
  } }]);
  const { app } = ui;
  app._saleWatchRows = [
    { domain: 'reader-position.com', classification: 'likely-sale', reportDate: '2026-10-20' },
    { domain: 'relisted.com', classification: 'likely-sale', reportDate: '2026-10-19' },
  ];
  app._saleWatchLedger = { entries: app._saleWatchRows };
  app._saleWatchVisibleLimit = 100;
  await app.loadSaleWatch(true, false, true);
  assert.deepEqual([...app._saleWatchRows.map(row => row.domain)], ['newer.com', 'reader-position.com'], 'new departure arrives; a name absent from the complete current page has left');
  assert.equal(ui.renders(), 1, 'applied in place by the background poll');
  assert.equal(app._saleWatchVisibleLimit, 101, 'the visible window grows by the inserted row so nothing the reader sees is pushed out');
  assert.ok(ui.timers.some(t => t.ms === 30000), 'the next background refresh is scheduled');
});

test('search debounce and pending requests never claim there are no matching names', async () => {
  const ui = loadFrontend([{ status: 202, body: { status: 'pending' } }]);
  ui.app.renderSaleWatch = ui.render;
  ui.app._saleWatchLoaded = true;
  ui.el('sale-watch-search').value = 'inference';
  ui.render();
  assert.match(ui.el('sale-watch-list').innerHTML, /Loading matching evidence/);
  assert.doesNotMatch(ui.el('sale-watch-list').innerHTML, /No names meet/);
  assert.equal(ui.el('sale-watch-total').textContent, '—');
  await ui.timers.at(-1).fn();
  await flush();
  assert.match(ui.el('sale-watch-status').textContent, /Still computing/);
  ui.render();
  assert.match(ui.el('sale-watch-status').textContent, /Still computing/);
  assert.doesNotMatch(ui.el('sale-watch-list').innerHTML, /No names meet/);
});

test('a completed empty search may show no matches; an in-flight filter preserves existing rows', async () => {
  const ui = loadFrontend([{ status: 200, body: { entries: [], pagination: {} } }]);
  ui.app.renderSaleWatch = ui.render;
  await ui.app.loadSaleWatch(true);
  assert.match(ui.el('sale-watch-list').innerHTML, /No names meet/);
  ui.app._saleWatchRows = [{ domain: 'previous.com', classification: 'likely-sale' }];
  ui.el('sale-watch-list').innerHTML = '<details open>previous.com</details>';
  ui.el('sale-watch-search').value = 'inference';
  ui.render();
  assert.equal(ui.el('sale-watch-list').innerHTML, '<details open>previous.com</details>');
  assert.match(ui.el('sale-watch-status').textContent, /Previous results remain visible/);
});

test('a response for a superseded input cannot overwrite the visible results', async () => {
  const ui = loadFrontend([{ status: 200, body: { entries: [{ domain: 'old.com', classification: 'likely-sale' }] } }]);
  ui.el('sale-watch-search').value = 'inference';
  await ui.app.loadSaleWatch(true);
  assert.equal(ui.renders(), 0);
  assert.equal(ui.app._saleWatchLoaded, false);
  assert.equal(ui.app._saleWatchRows.length, 0);
});


test('status line: "<n> names · updated <ago>" from when evidence last landed, never a store completion marker', () => {
  const ui = loadFrontend([]);
  const { app, el } = ui;
  app._saleWatchLoaded = true;
  app._saleWatchRows = Array.from({ length: 39 }, (_, i) => ({ domain: `n${i}.com`, classification: 'likely-sale', reportDate: '2026-11-07' }));
  app._saleWatchVisibleLimit = 100;
  app._saleWatchLedger = {
    generatedAt: '2026-08-31T18:24:53Z', pagination: { nextCursor: null },
    coverage: { reconstruction: { lastProbeAt: '2026-10-29T17:46:36Z', ledgerStore: { completeAt: '2026-10-29T17:09:58Z', total: 1234 } } },
    // 4.5 minutes: generous against a slow test runner.
    freshness: { verdict: 'current', statusLine: 'Current', reader: { lastUpdateAt: new Date(Date.now() - 270000).toISOString(), behind: false } },
  };
  ui.render();
  const text = el('sale-watch-status').textContent;
  assert.equal(text, '39 names · updated 4 minutes ago');
  assert.ok(!text.includes(new Date('2026-10-29T17:09:58Z').toLocaleString()), 'no completion marker date');
  assert.equal(el('sale-watch-status').dataset.freshness, 'current');
  // Freshness not readable yet: omit the time rather than show a wrong one.
  delete app._saleWatchLedger.freshness;
  ui.render();
  assert.equal(el('sale-watch-status').textContent, '39 names');
  assert.equal(el('sale-watch-status').dataset.freshness, 'unknown');
});

test('internal vocabulary never appears; a rebuild in progress or one failed wave is not a warning', () => {
  const ui = loadFrontend([]);
  const { app, el } = ui;
  app._saleWatchLoaded = true;
  app._saleWatchRows = [{ domain: 'kept.com', classification: 'likely-sale', reportDate: '2026-11-07' }];
  app._saleWatchVisibleLimit = 100;
  const internal = /wave|assessment|version|ledger|stage|searchIndex|stale|degraded|⚠|probe|indexed/i;
  for (const freshness of [
    { verdict: 'degraded', statusLine: 'Degraded: wave: last wave failed (searchIndex)', reasons: ['wave: last wave failed (searchIndex)'], reader: { lastUpdateAt: new Date(Date.now() - 600000).toISOString(), behind: false } },
    { verdict: 'current', statusLine: 'Current', rebuild: { inProgress: true, progressing: true, toVersion: 'sale-evidence-v16' }, reader: { lastUpdateAt: new Date(Date.now() - 30000).toISOString(), behind: false } },
  ]) {
    app._saleWatchLedger = { pagination: { nextCursor: null }, coverage: { reconstruction: { ledgerStore: { total: 5 } } }, freshness };
    ui.render();
    const text = el('sale-watch-status').textContent;
    assert.match(text, /^1 name · updated /);
    assert.doesNotMatch(text, internal);
    assert.doesNotMatch(text, /delayed/);
  }
});

test('a list that really is behind says what that means in one plain sentence', () => {
  const ui = loadFrontend([]);
  const { app, el } = ui;
  app._saleWatchLoaded = true;
  app._saleWatchRows = [{ domain: 'kept.com', classification: 'likely-sale', reportDate: '2026-11-03' }, { domain: 'two.com', classification: 'likely-sale', reportDate: '2026-11-02' }];
  app._saleWatchVisibleLimit = 100;
  app._saleWatchLedger = { pagination: { nextCursor: null },
    freshness: { verdict: 'stale', statusLine: 'Stale: wave: 3 consecutive failed waves (searchIndex)', reasons: ['wave: 3 consecutive failed waves (searchIndex)'], reader: { lastUpdateAt: new Date(Date.now() - 3.5 * 3600000).toISOString(), behind: true } } };
  ui.render();
  const text = el('sale-watch-status').textContent;
  assert.equal(text, '2 names. New sales may be delayed; last update 3 hours ago. Repairing automatically.');
  assert.equal(el('sale-watch-status').dataset.freshness, 'stale');
  app._saleWatchLedger.freshness.reader.lastUpdateAt = null;
  ui.render();
  assert.equal(el('sale-watch-status').textContent, '2 names. New sales may be delayed. Repairing automatically.');
  app._saleWatchLedger.freshness.reader = { lastUpdateAt: null, behind: false, unknown: true };
  app._saleWatchLedger.delivery = { source: 'local-projection', builtAt: '2026-10-29T17:04:05Z', warning: 'Cloud evidence unavailable' };
  ui.render();
  assert.equal(el('sale-watch-status').textContent, '2 names Showing a saved copy on this computer; recent sales may be missing.'.replace('names ', 'names. ').replace('names. Showing', 'names Showing'));
});

test('relative time wording', () => {
  const { app } = loadFrontend([]);
  const now = Date.parse('2026-11-07T10:00:00Z');
  assert.equal(app._saleWatchAgo('2026-11-07T09:59:30Z', now), 'just now');
  assert.equal(app._saleWatchAgo('2026-11-07T09:59:00Z', now), '1 minute ago');
  assert.equal(app._saleWatchAgo('2026-11-07T07:00:00Z', now), '3 hours ago');
  assert.equal(app._saleWatchAgo('2026-11-04T10:00:00Z', now), '3 days ago');
  assert.equal(app._saleWatchAgo(null, now), null);
});

test('empty windowed search offers one tap to widen when a longer window has matches', () => {
  const ui = loadFrontend([]);
  const { app, el } = ui;
  app._saleWatchLoaded = true;
  app._saleWatchDays = 7;
  app._saleWatchQuery = 'orchard';
  el('sale-watch-search').value = 'orchard';
  app._saleWatchRows = [];
  app._saleWatchRowsQuery = 'orchard';
  app._saleWatchLedger = { pagination: { nextCursor: null }, widerMatches: [{ days: 30, count: 41 }] };
  ui.render();
  const html = el('sale-watch-list').innerHTML;
  assert.match(html, /No matches in the past week · <button[^>]*id="sale-watch-widen"[^>]*onclick="app\.setSaleWatchWindow\(30\)"[^>]*>41 in the past 30 days<\/button>/);
  app._saleWatchLedger = { pagination: { nextCursor: null }, widerMatches: [{ days: 30, count: 0 }] };
  ui.render();
  assert.equal(el('sale-watch-list').innerHTML, '<div class="sale-watch-empty">No matches in the past week.</div>');
  app._saleWatchLedger = { pagination: { nextCursor: null } };
  ui.render();
  assert.doesNotMatch(el('sale-watch-list').innerHTML, /sale-watch-widen/);
});

test('desktop and phone (375 px): the status sentence is readable text and empty-card actions are full-width tap targets', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.sale-watch-toolbar #sale-watch-status \{[^}]*font: 12px var\(--font-sans\);[^}]*white-space: normal;[^}]*flex-basis: 100%/);
  assert.match(css, /\.sale-watch-empty \.btn \{[^}]*opacity: 1;/);
  const phone = css.slice(css.indexOf('@media (max-width: 820px)'), css.indexOf('@media (max-width: 600px)'));
  assert.match(phone, /\.sale-watch-empty \.btn \{[^}]*width: 100%;[^}]*min-height: 40px;/);
  assert.doesNotMatch(css, /#sale-watch-refresh/);
  // The status text itself never carries internal vocabulary at either width.
  const ui = loadFrontend([]);
  const text = ui.app._saleWatchStatusText(39, { freshness: { verdict: 'stale', reader: { lastUpdateAt: new Date(Date.now() - 3 * 3600000 - 60000).toISOString(), behind: true } } });
  assert.equal(text, '39 names. New sales may be delayed; last update 3 hours ago. Repairing automatically.');
  assert.doesNotMatch(text, /wave|assessment|version|ledger|searchIndex|stale/i);
});

test('status line says plainly when more names are available on the next page', () => {
  const ui = loadFrontend([]);
  const at = new Date(Date.now() - 270000).toISOString();
  assert.equal(ui.app._saleWatchStatusText(100, { pagination: { nextCursor: 'x' }, freshness: { reader: { lastUpdateAt: at, behind: false } } }), '100 names · updated 4 minutes ago · more Probably sold names available below');
  assert.equal(ui.app._saleWatchStatusText(39, { pagination: { nextCursor: null }, freshness: { reader: { lastUpdateAt: at, behind: false } } }), '39 names · updated 4 minutes ago');
});
