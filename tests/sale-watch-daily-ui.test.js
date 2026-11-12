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
      if (body instanceof Error) throw body;
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
  assert.match(html, /<strong>2026-11-12<\/strong> <span>1 sold · 1 candidate<\/span>/);
  assert.match(html, /<strong>2026-11-11<\/strong> <span>0 sold · 1 candidate<\/span>/);
  const heads = html.slice(html.indexOf('<section'));
  assert.doesNotMatch(heads, /(8|7|4) candidates/, 'tapes are never summed');
  assert.equal(el('sale-watch-subtitle').textContent, 'Loaded days: 1 sold through resellers · 2 candidates', 'hero line sums one tape only');
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
  assert.match(html, /0 live · 5 candidates/);
  assert.match(html, /0 live · 3 candidates/);
  assert.equal(el('sale-watch-subtitle').textContent, "Loaded days: 0 live from builders' own registrations · 8 candidates");
  assert.doesNotMatch(html, /bought from resellers/i);
  app.setSaleWatchTape('noise-or-anything');
  assert.equal(store.saleWatchTape, 'builder', 'unknown tape ignored');
});

test('day head: only the one-line title is the sticky header; Breakdown disclosure is closed by default, per day, not persisted', () => {
  const { app, el, store } = loadFrontend();
  app._saleWatchDaily = { days, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  const heads = html.match(/<header class="sale-watch-day-head"[\s\S]*?<\/header>/g) || [];
  assert.equal(heads.length, 2);
  for (const h of heads) {
    assert.doesNotMatch(h, /sale-watch-chip-group/, 'chip groups are not inside the sticky title');
    assert.match(h, /aria-expanded="false"[^>]*>Breakdown<\/button>/);
  }
  assert.match(html, /<div class="sale-watch-day-breakdown" id="sale-watch-breakdown-2026-11-12" hidden>/);
  assert.match(html, /<div class="sale-watch-day-breakdown" id="sale-watch-breakdown-2026-11-11" hidden>/);
  const attrs = {};
  const btn = { dataset: { day: '2026-11-12' }, setAttribute(k, v) { attrs[k] = v; }, getAttribute: k => (k === 'aria-controls' ? 'sale-watch-breakdown-2026-11-12' : null) };
  el('sale-watch-breakdown-2026-11-12').hidden = true;
  app.toggleSaleWatchDayBreakdown(btn);
  assert.equal(el('sale-watch-breakdown-2026-11-12').hidden, false);
  assert.equal(attrs['aria-expanded'], 'true');
  app.renderSaleWatchDaily();
  const again = el('sale-watch-daily').innerHTML;
  assert.match(again, /id="sale-watch-breakdown-2026-11-12">/, 'open state for that day survives a re-render');
  assert.match(again, /id="sale-watch-breakdown-2026-11-11" hidden>/, 'other days stay closed');
  assert.deepEqual(Object.keys(store).filter(k => /breakdown|open/i.test(k)), [], 'not persisted');
});

test('window summary: one numbers line, "Filters and breakdown" closed by default, first row precedes any chip group', () => {
  const { app, el } = loadFrontend();
  app._saleWatchDaily = { days, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  // The window line is shown once (the hero subtitle), never repeated above the list.
  assert.doesNotMatch(html, /<span class="sale-watch-summary-line">Loaded days/);
  assert.match(el('sale-watch-subtitle').textContent, /^Loaded days: [^<]*sold/);
  assert.match(html, /id="sale-watch-summary-toggle" aria-expanded="false"[^>]*>Filters and breakdown<\/button>/);
  assert.match(html, /id="sale-watch-summary-groups" hidden><\/div>/);
  const firstRow = html.indexOf('class="sale-watch-day-row"');
  const firstGroup = html.indexOf('sale-watch-chip-group');
  assert.ok(firstRow > 0);
  assert.ok(firstGroup === -1 || firstRow < firstGroup, 'first row precedes chip groups when closed');
  assert.equal(el('sale-watch-active-filters').hidden, true, 'no active filter line without filters');
  app.toggleSaleWatchSummary({ setAttribute() {} });
  assert.match(el('sale-watch-summary-groups').innerHTML, /data-group="byVenue"/);
  assert.equal(el('sale-watch-summary-groups').hidden, false);
});

test('active filters: removable chips under the toolbar with the disclosure closed, count on the disclosure', () => {
  const { app, el, store } = loadFrontend();
  store.saleWatchDailyFilters = JSON.stringify({ venue: 'Afternic' });
  app._saleWatchDaily = { days, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  assert.match(html, /aria-expanded="false"[^>]*>Filters and breakdown <b class="sale-watch-filter-count">1<\/b><\/button>/);
  const active = el('sale-watch-active-filters');
  assert.equal(active.hidden, false);
  assert.match(active.innerHTML, /data-k="venue" data-v="Afternic" onclick="app.toggleSaleWatchFilter\(this.dataset.k, this.dataset.v\)">Afternic ×<\/button>/);
  assert.match(active.innerHTML, /Clear filters/);
  app.toggleSaleWatchFilter('venue', 'Afternic');
  assert.equal(el('sale-watch-active-filters').hidden, true);
});

test('header line: window numbers for the tape shown; Insights line only when a row has a stored insight', () => {
  const { app, el } = loadFrontend();
  const win = { tape: 'aftermarket', counts: { aftermarket: 70, builder: 9, noise: 0 }, sold: { aftermarket: 58, builder: 4, noise: 0 } };
  const lastWrittenAt = new Date(Date.now() - 3600000).toISOString();
  app._saleWatchDaily = { days, window: win, insights: { lastWrittenAt }, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  assert.equal(el('sale-watch-subtitle').textContent, 'Past 14 days: 58 sold through resellers · 12 candidates');
  assert.match(el('sale-watch-daily').innerHTML, /Insights last written/, 'shown: rivo.com has a stored insight');
  const bare = days.map(d => ({ ...d, rows: d.rows.map(r => ({ ...r, insight: null })) }));
  app._saleWatchDaily = { days: bare, window: win, insights: { lastWrittenAt }, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  assert.doesNotMatch(el('sale-watch-daily').innerHTML, /Insights last written/);
  assert.doesNotMatch(el('sale-watch-subtitle').textContent, /Insights/);
  app._saleWatchDaily = { days: bare, window: { ...win, tape: 'builder' }, pagination: { nextCursor: null } };
  app.setSaleWatchTape('builder');
  app._saleWatchDaily = { days: bare, window: { ...win, tape: 'builder' }, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  assert.equal(el('sale-watch-subtitle').textContent, "Past 14 days: 4 live from builders' own registrations · 5 candidates");
});

test('css: the day title is the only sticky part of a day and is opaque', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  const rule = sel => (css.match(new RegExp(`(^|\\n)${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`)) || [])[2] || '';
  const head = rule('.sale-watch-day-head');
  assert.match(head, /position: sticky/);
  assert.match(head, /background: rgb\(12, 16, 15\)/);
  assert.doesNotMatch(head, /rgba/);
  assert.doesNotMatch(rule('.sale-watch-day-breakdown'), /sticky/);
});

test('day feed default tape is aftermarket and the default window is 14 days', async () => {
  const { app, fetches } = loadFrontend();
  await app.loadSaleWatchDaily();
  const u = fetches.find(x => /\/api\/sale-watch\/daily/.test(x));
  assert.match(u, /tape=aftermarket/);
  // The snapshot's own window: window=14, no client-computed from/to.
  assert.match(u, /[?&]window=14&/);
  assert.doesNotMatch(u, /[?&](from|to)=/);
});

test('day title: "N sold", then "· M candidates" only when candidates are included; never transfer counts', () => {
  const { app, el, store } = loadFrontend();
  const withClasses = JSON.parse(JSON.stringify(days));
  withClasses[0].classes = { transferCompleted: 3, transferInProgress: 2 };
  store.saleWatchIncludeCandidates = '0';
  app._saleWatchDaily = { days: withClasses, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  let html = el('sale-watch-daily').innerHTML;
  assert.match(html, /<strong>2026-11-12<\/strong> <span>1 sold<\/span>/);
  const heads = (html.match(/<header class="sale-watch-day-head"[\s\S]*?<\/header>/g) || []).join('');
  assert.doesNotMatch(heads, /candidate|transfer/);
  app.toggleSaleWatchProbableOnly();
  html = el('sale-watch-daily').innerHTML;
  assert.match(html, /<strong>2026-11-12<\/strong> <span>1 sold · 1 candidate<\/span>/);
  assert.doesNotMatch((html.match(/<header class="sale-watch-day-head"[\s\S]*?<\/header>/g) || []).join(''), /transfer/);
});

test('tape row: the two tape buttons only, no Noise button; Include candidates on its own line, outside the tape row', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const start = html.indexOf('<div class="sale-watch-tapes"');
  const row = html.slice(start, html.indexOf('</div>', start));
  assert.deepEqual([...row.matchAll(/data-sale-watch-tape="([^"]+)"/g)].map(m => m[1]), ['aftermarket', 'builder']);
  assert.equal((row.match(/<button/g) || []).length, 2, 'tape row holds the two tape buttons only');
  assert.doesNotMatch(html, /data-sale-watch-tape="noise"|>Noise</);
  assert.doesNotMatch(row, /sale-watch-probable-only|Include candidates/, 'switch label is not inside the tape row');
  assert.match(html, /<div class="sale-watch-options">\s*<button class="btn sale-watch-switch" id="sale-watch-probable-only"[^>]*>[\s\S]*?Include candidates<\/button>\s*<\/div>/);
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.sale-watch-options \.sale-watch-switch \{[^}]*white-space: nowrap/, 'label on one line');
  const { app, store } = loadFrontend();
  store.saleWatchTape = 'noise';
  assert.equal(app._saleWatchTape(), 'aftermarket', 'a stored noise tape falls back to resellers');
  app.setSaleWatchTape('noise');
  assert.equal(store.saleWatchTape, 'noise', 'noise is not a selectable tape');
});

test('buyer title: decoded markup stays escaped in the DOM; long titles capped at ~70 chars with the full title attribute', () => {
  const { app, el } = loadFrontend();
  const long = 'SECOND SONS CANADA – OUR PEOPLE, OUR HOME, OUR FUTURE, AND EVERYTHING ELSE WE BUILD TOGETHER';
  app._saleWatchDaily = { days: [{ day: '2026-11-12', counts: { aftermarket: 2, builder: 0, noise: 0 }, rows: [
    { domain: 'secondsons.ca', derived: { tape: 'aftermarket', buyerTitle: long, buyerUrl: 'https://secondsons.ca/', timeline: [] }, insight: null },
    { domain: 'evil.com', derived: { tape: 'aftermarket', buyerTitle: '<script>alert(1)</script> & co', timeline: [] }, insight: null },
  ] }], pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/);
  assert.ok(html.includes(`title="${long}"`), 'full title in the title attribute');
  const shown = /title="[^"]*"[^>]*>([^<]*)<\/a>/.exec(html)[1];
  assert.ok(shown.endsWith('…'), shown);
  assert.ok(Array.from(shown).length <= 70, shown);
  assert.equal(app._saleWatchCapTitle('Short title'), 'Short title');
});

test('window line: own full-width wrapping row with hero wording; disclosure on the next row, right-aligned', () => {
  const { app, el } = loadFrontend();
  const win = { counts: { aftermarket: 943, builder: 500, noise: 3 }, sold: { aftermarket: 888, builder: 491, noise: 0 } };
  app._saleWatchDaily = { days, window: { ...win, tape: 'aftermarket' }, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  let html = el('sale-watch-daily').innerHTML;
  assert.doesNotMatch(html, /sale-watch-summary-line">Past 14 days/);
  assert.match(html, /<div class="sale-watch-summary-head"><button[^>]*sale-watch-disclosure/);
  assert.equal(el('sale-watch-subtitle').textContent, 'Past 14 days: 888 sold through resellers · 55 candidates');
  app._saleWatchTape = () => 'builder';
  app._saleWatchDaily = { days, window: { ...win, tape: 'builder' }, pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  html = el('sale-watch-daily').innerHTML;
  assert.doesNotMatch(html, /sale-watch-summary-line">Past 14 days/);
  assert.match(el('sale-watch-subtitle').textContent, /Past 14 days: 491 live from builders' own registrations · 9 candidates/);
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  const line = /\.sale-watch-summary-head \.sale-watch-summary-line \{([^}]*)\}/.exec(css)[1];
  assert.match(line, /flex: 1 1 100%/);
  assert.match(line, /white-space: normal/);
  assert.doesNotMatch(line, /ellipsis|nowrap/);
  assert.match(/\.sale-watch-summary-head \{([^}]*)\}/.exec(css)[1], /flex-wrap: wrap/);
  assert.match(css, /\.sale-watch-summary-head \.sale-watch-disclosure \{ margin-left: auto; \}/);
});

test('heading focus: the panel moves focus to the Sale Watch title for screen readers, but the heading shows no outline', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /#sale-watch-title:focus, #sale-watch-title:focus-visible \{ outline: none; \}/);
  assert.match(source, /getElementById\('sale-watch-title'\)\.focus\?\.\(\)/, 'focus move kept');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /<h2 id="sale-watch-title" tabindex="-1">/);
  assert.doesNotMatch(css, /button:focus\s*\{[^}]*outline:\s*none/, 'interactive controls keep a focus outline');
});

test('buyer link: a live site with no buyer title uses the final host as link text', () => {
  const { app, el } = loadFrontend();
  app._saleWatchDaily = { days: [{ day: '2026-11-12', counts: { aftermarket: 1, builder: 0, noise: 0 }, rows: [
    { domain: 'brightpath.com', derived: { tape: 'aftermarket', homepageState: 'live site', buyerHost: 'brightpath-health.io', timeline: [] }, insight: null },
  ] }], pagination: { nextCursor: null } };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  assert.match(html, /<span data-fact="buyer"><a href="https:\/\/brightpath-health\.io\/" title="brightpath-health\.io"[^>]*>brightpath-health\.io<\/a><\/span>/);
});

test('screen: a failing refresh after a successful load keeps rows on screen; a stored window renders instantly as of HH:MM', async () => {
  const { app, el, store } = loadFrontend([{ days, generatedAt: '2026-11-12T21:40:00Z', pagination: { nextCursor: null } }, new Error('network down')]);
  app.loadSaleWatchDaily();
  await flush(); await flush();
  assert.match(el('sale-watch-daily').innerHTML, /brightpath\.com/);
  assert.match(el('sale-watch-status').textContent, /as of \d\d:\d\d/);
  app.loadSaleWatchDaily(false, true);
  await flush(); await flush();
  assert.match(el('sale-watch-daily').innerHTML, /brightpath\.com/, 'rows stay on screen');
  assert.equal(el('sale-watch-status').textContent, 'refreshing…');
  assert.doesNotMatch(el('sale-watch-daily').innerHTML + el('sale-watch-status').textContent, /could not load/i);
  const key = Object.keys(store).find(k => /^saleWatchDaily\.v1\./.test(k));
  assert.ok(key, 'window stored in localStorage');
  assert.equal(JSON.parse(store[key]).v, 1);
  const second = loadFrontend([new Error('server restarting')]);
  second.store[key] = store[key];
  second.app.loadSaleWatchDaily();
  assert.match(second.el('sale-watch-daily').innerHTML, /brightpath\.com/, 'stored window rendered before any answer');
  assert.match(second.el('sale-watch-status').textContent, /as of \d\d:\d\d/);
  await flush(); await flush();
  assert.match(second.el('sale-watch-daily').innerHTML, /brightpath\.com/);
  assert.doesNotMatch(second.el('sale-watch-daily').innerHTML + second.el('sale-watch-status').textContent, /could not load/i);
  const third = loadFrontend([new Error('down')]);
  third.app.loadSaleWatchDaily();
  await flush(); await flush();
  assert.match(third.el('sale-watch-status').textContent, /Could not load the feed\. Retrying automatically/, 'only with neither a stored window nor an answer');
});
