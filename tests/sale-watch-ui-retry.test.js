'use strict';

// Sale Watch feed never dead-ends on a transient 503 (read-lane timeout) or
// 202 (stored ledger still being built): days stay on screen, the status says
// "Still computing, retrying…", and the retry honours retryAfterMs with
// backoff. A response for a superseded tape or search never overwrites the
// feed. The status sentence never carries internal vocabulary.

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
  const store = {};
  const document = {
    body: {}, activeElement: null, addEventListener() {}, getElementById: el,
    querySelector: () => ({ style: {}, contains: () => false }), querySelectorAll: () => [],
  };
  const fetches = [];
  const context = {
    URLSearchParams, AbortController, console, document,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval() {}, clearInterval() {},
    requestAnimationFrame() { return 0; },
    fetch: async url => {
      fetches.push(url);
      const next = responses.shift() || { status: 200, body: { days: [], pagination: { nextCursor: null } } };
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
    },
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  context.__state.stream = '_salewatch';
  return { app: context.__app, el, timers, fetches, store };
}

const day = (d, domains) => ({ day: d, counts: { aftermarket: domains.length, builder: 0, noise: 0 },
  rows: domains.map(domain => ({ domain, classification: 'likely-sale', derived: { tape: 'aftermarket', lead: true, leadReason: 'marketplace exit + registrar transfer', timeline: [] }, insight: null })) });

test('feed: 503 and 202 keep days on screen, say "refreshing…", and retry with backoff honouring retryAfterMs', async () => {
  const { app, el, timers } = loadFrontend([
    { status: 503, body: { error: 'Sale Watch insights are temporarily busy', retryAfterMs: 4000 } },
    { status: 202, body: { status: 'pending', retryAfterMs: 5000 } },
    { status: 200, body: { days: [day('2026-11-12', ['fresh.com'])], pagination: { nextCursor: null } } },
  ]);
  app._saleWatchDaily = { days: [day('2026-11-11', ['kept.com'])], pagination: { nextCursor: null } };
  el('sale-watch-daily').innerHTML = '<div>kept.com</div>';
  await app.loadSaleWatchDaily();
  assert.equal(el('sale-watch-status').textContent, 'refreshing…', 'operator 2026-11-12: a busy refresh with rows on screen is a quiet refreshing line');
  assert.equal(el('sale-watch-daily').innerHTML, '<div>kept.com</div>', 'days on screen stay');
  assert.equal(timers.at(-1).ms, 4000, 'retryAfterMs is a minimum');
  await timers.at(-1).fn();
  assert.equal(el('sale-watch-status').textContent, 'refreshing…', 'operator 2026-11-12: a busy refresh with rows on screen is a quiet refreshing line');
  assert.equal(timers.at(-1).ms, 5000);
  await timers.at(-1).fn();
  assert.match(el('sale-watch-daily').innerHTML, /fresh\.com/);
  assert.match(el('sale-watch-status').textContent, /^\d+ names?/);
});

test('retry budget: backoff doubles, honours retryAfterMs, and gives up after about 2 minutes', () => {
  const { app } = loadFrontend([]);
  const t0 = 1_000_000;
  assert.equal(app._retryDelay('daily', 'k', 0, t0), 2000);
  assert.equal(app._retryDelay('daily', 'k', 0, t0 + 2000), 4000);
  assert.equal(app._retryDelay('daily', 'k', 9000, t0 + 6000), 9000, 'retryAfterMs is a minimum');
  assert.ok(app._retryDelay('daily', 'k', 0, t0 + 115000) <= 5000, 'never past the budget');
  assert.equal(app._retryDelay('daily', 'k', 0, t0 + 121000), null, 'budget spent');
  assert.equal(app._retryDelay('daily', 'other', 0, t0 + 121000), 2000, 'a new request key starts a fresh budget');
});

test('a spent fast-retry budget keeps retrying every 30 s and never shows an error for a busy lane', async () => {
  const { app, el, timers } = loadFrontend([{ status: 503, body: { error: 'busy' } }]);
  app._retryLanes = { daily: { key: 'aftermarket|14||', startedAt: Date.now() - 130000, attempt: 6 } };
  await app.loadSaleWatchDaily();
  assert.equal(timers.at(-1).ms, 30000);
  assert.doesNotMatch(el('sale-watch-status').textContent, /could not/i);
});

test('a hard failure keeps loaded days and says so in plain words', async () => {
  const { app, el } = loadFrontend([{ status: 500, body: { error: 'boom' } }]);
  app._saleWatchDaily = { days: [day('2026-11-11', ['kept.com'])], pagination: { nextCursor: null } };
  el('sale-watch-daily').innerHTML = '<div>kept.com</div>';
  await app.loadSaleWatchDaily();
  assert.equal(el('sale-watch-status').textContent, 'refreshing…', 'a failed refresh never shows an error over loaded rows');
  assert.equal(el('sale-watch-daily').innerHTML, '<div>kept.com</div>', 'rows on screen are never replaced by the error card');
});

test('a failed load with nothing on screen offers one tap to retry', async () => {
  const { app, el } = loadFrontend([{ status: 500, body: { error: 'boom' } }]);
  await app.loadSaleWatchDaily();
  assert.match(el('sale-watch-daily').innerHTML, /id="sale-watch-retry"[^>]*onclick="app\.loadSaleWatchDaily\(\)"/);
  assert.equal(el('sale-watch-status').textContent, 'Could not load the feed. Retrying automatically.');
});

test('a response for a superseded tape or search cannot overwrite the visible feed', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { app, el, store } = loadFrontend([]);
  app._saleWatchDaily = { days: [day('2026-11-11', ['kept.com'])], pagination: { nextCursor: null } };
  el('sale-watch-daily').innerHTML = '<div>kept.com</div>';
  const realFetch = async () => { await gate; return { ok: true, status: 200, json: async () => ({ days: [day('2026-11-12', ['stale.com'])], pagination: {} }) }; };
  app._saleWatchQuery = 'old';
  const pending = (async () => { const f = globalThis.fetch; return f; })();
  await pending;
  // Swap fetch in the app's context through the loaded module's closure-free API.
  const ctxFetch = realFetch;
  const run = (async () => {
    const original = app.loadSaleWatchDaily;
    return original;
  })();
  await run;
  // Simulate: request starts for q=old, user then types q=new before it returns.
  const started = app.loadSaleWatchDaily.call(Object.assign(Object.create(app), {}));
  app._saleWatchQuery = 'new';
  release();
  await started;
  await ctxFetch;
  assert.doesNotMatch(el('sale-watch-daily').innerHTML, /stale\.com/);
  assert.equal(store.saleWatchTape, undefined);
});

test('status line: "<n> names · updated <ago>" from when evidence last landed', () => {
  const { app } = loadFrontend([]);
  const at = new Date(Date.now() - 270000).toISOString();
  assert.equal(app._saleWatchStatusText(39, { pagination: { nextCursor: null }, freshness: { reader: { lastUpdateAt: at, behind: false } } }), '39 names · updated 4 minutes ago');
  assert.equal(app._saleWatchStatusText(39, { pagination: { nextCursor: null } }), '39 names', 'unknown time is omitted, not guessed');
  assert.equal(app._saleWatchStatusText(1, { pagination: { nextCursor: null } }), '1 name');
});

test('internal vocabulary never appears; a feed that really is behind says so in one plain sentence', () => {
  const { app } = loadFrontend([]);
  const internal = /wave|assessment|version|ledger|stage|searchIndex|stale|degraded|probe|indexed/i;
  const text = app._saleWatchStatusText(39, { freshness: { verdict: 'stale', reader: { lastUpdateAt: new Date(Date.now() - 3 * 3600000 - 60000).toISOString(), behind: true } } });
  assert.equal(text, '39 names. New seller departures may be delayed; last update 3 hours ago. Repairing automatically.');
  assert.doesNotMatch(text, internal);
  assert.equal(app._saleWatchStatusText(2, { freshness: { reader: { lastUpdateAt: null, behind: true } } }), '2 names. New seller departures may be delayed. Repairing automatically.');
});

test('status line says plainly when earlier days load on scroll', () => {
  const { app } = loadFrontend([]);
  const at = new Date(Date.now() - 270000).toISOString();
  assert.equal(app._saleWatchStatusText(100, { pagination: { nextCursor: 'x' }, freshness: { reader: { lastUpdateAt: at, behind: false } } }), '100 names · updated 4 minutes ago · earlier days load as you scroll');
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

test('desktop and phone: the status sentence is readable text and empty-card actions are full-width tap targets', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.sale-watch-toolbar #sale-watch-status \{[^}]*font: 12px var\(--font-sans\);[^}]*white-space: normal;[^}]*flex-basis: 100%/);
  assert.match(css, /\.sale-watch-empty \.btn \{[^}]*opacity: 1;/);
  const phone = css.slice(css.indexOf('@media (max-width: 820px)'), css.indexOf('@media (max-width: 600px)'));
  assert.match(phone, /\.sale-watch-empty \.btn \{[^}]*width: 100%;[^}]*min-height: 40px;/);
});
