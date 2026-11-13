'use strict';

// Sale Watch feed readability (DOM-level, app.js in a vm): self-explanatory
// row facts in a fixed order (item 1), the tape switch state and the
// "Probably sold only" on/off toggle (item 3), and the hero (item 4).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

function button(attrs = {}, dataset = {}) {
  return { attrs: { ...attrs }, dataset: { ...dataset }, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; } };
}

function loadFrontend({ store = { saleWatchIncludeCandidates: '1' } } = {}) {
  const elements = {};
  const el = id => elements[id] || (elements[id] = { id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, style: {}, dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, focus() {} });
  const tapes = ['aftermarket', 'builder', 'noise'].map(t => button({ 'aria-pressed': 'false' }, { saleWatchTape: t }));
  const document = {
    body: {}, activeElement: null, addEventListener() {}, getElementById: el,
    querySelector: () => ({ style: {}, contains: () => false }),
    querySelectorAll: sel => (String(sel).includes('data-sale-watch-tape') ? tapes : []),
  };
  const context = {
    URLSearchParams, AbortController, console, document,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    window: { location: { protocol: 'http:', search: '', pathname: '/' }, history: { pushState() {}, replaceState() {} } },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    requestAnimationFrame() { return 0; },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ days: [], pagination: { nextCursor: null } }) }),
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  context.__state.stream = '_salewatch';
  return { app: context.__app, el, tapes, store };
}

const ROWS = [
  { domain: 'brightpat9.com', classification: 'likely-sale', derived: { tape: 'aftermarket', probablySold: true, venue: 'Dan', buyerTitle: 'BrightPat Studio', buyerUrl: 'https://brightpat9.com/', homepageState: 'live site', registeredYear: 2019, length: 10, lengthBand: '9-11', registrar: 'Namecheap', extension: 'com', hasHyphen: false, hasDigit: true, otherExtensions: null, tier: 'probable', timeline: [] }, insight: null },
  { domain: 'rivo.net', classification: 'unconfirmed-move', derived: { tape: 'aftermarket', probablySold: false, venue: 'Sedo', homepageState: 'site not checked', length: 4, lengthBand: '1-4', registrar: 'GoDaddy', extension: 'net', hasHyphen: true, hasDigit: false, otherExtensions: 12, tier: 'suspected', timeline: [] }, insight: null },
];
const page = () => ({
  days: [{ day: '2026-11-12', counts: { aftermarket: 2, builder: 0, noise: 0 }, probable: { aftermarket: 1, builder: 0, noise: 0 }, rows: JSON.parse(JSON.stringify(ROWS)) }],
  window: { tape: 'aftermarket', counts: { aftermarket: 673, builder: 40, noise: 9 }, probable: { aftermarket: 347, builder: 3, noise: 0 } },
  pagination: { nextCursor: null },
});
const rowOf = (html, domain) => { const at = html.indexOf(`data-domain="${domain}"`); return html.slice(at, html.indexOf('</summary>', at)); };
const facts = row => [...row.matchAll(/<span data-fact="([a-z]+)">([\s\S]*?)<\/span>/g)].map(m => [m[1], m[2].replace(/<[^>]+>/g, '')]);

test('item 1: each row fact reads on its own, in the fixed column order, with no extension or tier word', () => {
  const { app, el } = loadFrontend();
  app._saleWatchDaily = page();
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  const sold = rowOf(html, 'brightpat9.com');
  assert.deepEqual(facts(sold), [
    ['venue', 'left Dan'], ['buyer', 'BrightPat Studio'], ['site', 'live site'], ['registered', 'reg. 2019'],
    ['length', '10 letters'], ['registrar', 'at Namecheap'], ['digit', 'has digit'],
  ]);
  assert.match(sold, /<span data-fact="buyer"><a href="https:\/\/brightpat9\.com\/"[^>]*>BrightPat Studio<\/a><\/span>/);
  assert.match(sold, /class="sale-watch-tier probable">Probably sold</);
  const factText = facts(sold).map(f => f[1]).join(' ');
  assert.doesNotMatch(factText, /\bcom\b|\bprobable\b|\bhyphen\b|9-11|\bextensions?\b/);
  const cand = rowOf(html, 'rivo.net');
  assert.deepEqual(facts(cand).map(f => f[0]), ['venue', 'site', 'length', 'registrar', 'hyphen', 'extensions'], 'same order; unknown buyer and year omitted');
  assert.deepEqual(facts(cand).map(f => f[1]), ['left Sedo', 'site not checked', '4 letters', 'at GoDaddy', 'hyphen', 'taken in 12 extensions']);
  assert.match(cand, /class="sale-watch-tier candidate">candidate</);
  assert.doesNotMatch(facts(cand).map(f => f[1]).join(' '), /\bnet\b|suspected/);
});

test('item 1: legacy "not checked" homepage state still reads "site not checked"', () => {
  const { app, el } = loadFrontend();
  const p = page();
  p.days[0].rows[0].derived.homepageState = 'not checked';
  app._saleWatchDaily = p;
  app.renderSaleWatchDaily();
  assert.match(rowOf(el('sale-watch-daily').innerHTML, 'brightpat9.com'), /<span data-fact="site">site not checked<\/span>/);
});

test('item 2: feed links use the panel colours, not browser-default blue/underline', () => {
  assert.match(css, /\.sale-watch-day-row a, \.sale-watch-day-row a:visited \{[^}]*text-decoration: none/);
  assert.match(css, /\.sale-watch-day-row a\.sale-watch-name[^{]*\{[^}]*color: #8df0c8[^}]*font: 700 15px/);
});

test('item 3: selected tape is filled with aria-pressed=true; the toggle reads on/off with aria-pressed matching', () => {
  const { app, el, tapes, store } = loadFrontend({ store: { saleWatchTape: 'builder' } });
  app._saleWatchDaily = page();
  app.renderSaleWatchDaily();
  assert.deepEqual(tapes.map(b => b.attrs['aria-pressed']), ['false', 'true', 'false']);
  const toggle = el('sale-watch-probable-only');
  assert.equal(toggle.attrs['aria-pressed'], 'false');
  app.toggleSaleWatchProbableOnly();
  assert.equal(store.saleWatchIncludeCandidates, '1', 'Include candidates is on and saved');
  assert.equal(toggle.attrs['aria-pressed'], 'true');
  assert.equal(toggle.dataset.on, 'true');
  app.toggleSaleWatchProbableOnly();
  assert.equal(toggle.attrs['aria-pressed'], 'false');
  // Markup starts with aria-pressed on every tape and the toggle is a switch.
  for (const t of ['aftermarket', 'builder']) assert.match(indexHtml, new RegExp(`data-sale-watch-tape="${t}" aria-pressed="false"`));
  assert.match(indexHtml, /class="btn sale-watch-switch" id="sale-watch-probable-only" aria-pressed="false"[^>]*><span class="sale-watch-switch-track"/);
  // Filled vs outlined from the existing palette; no coloured edge tabs.
  assert.match(css, /\.sale-watch-tapes \.btn\[data-sale-watch-tape\] \{[^}]*background: transparent[^}]*border: 1px solid var\(--border\)/);
  assert.match(css, /\.sale-watch-tapes \.btn\[data-sale-watch-tape\]\[aria-pressed="true"\] \{[^}]*background: var\(--text\)[^}]*color: var\(--bg\)/);
  assert.match(css, /\.sale-watch-switch\[aria-pressed="true"\] \.sale-watch-switch-track::after \{[^}]*left: 14px/);
  const rules = css.match(/[^}]*sale-watch-(?:tapes|switch)[^{]*\{[^}]*\}/g).join('\n');
  assert.doesNotMatch(rules, /border-(left|right|top|bottom)\s*:/);
});

test('item 4: hero is "Sale Watch" with one window line in words; no pill, no LOADED counter', () => {
  const hero = indexHtml.slice(indexHtml.indexOf('id="sale-watch-panel"'), indexHtml.indexOf('class="sale-watch-toolbar"', indexHtml.indexOf('id="sale-watch-panel"')));
  assert.match(hero, /<h2 id="sale-watch-title"[^>]*>Sale Watch<\/h2>/);
  assert.match(hero, /id="sale-watch-subtitle"/);
  assert.doesNotMatch(hero, /sale-watch-live|sale-watch-total|sale-watch-metrics|loaded/i);
  assert.doesNotMatch(source, /sale-watch-total/);
  const { app, el } = loadFrontend();
  app._saleWatchDaily = page();
  app.renderSaleWatchDaily();
  assert.equal(el('sale-watch-subtitle').textContent, 'Past 14 days: 347 sold through resellers · 326 candidates');
  assert.doesNotMatch(el('sale-watch-daily').innerHTML, /LOADED/);
});

test('defects B/C/D: no older name marker (removed), transfer badges, continued day header with whole-day counts', () => {
  const { app, el } = loadFrontend();
  const rows = [
    { domain: 'oldpark.com', classification: 'acquisition-candidate', derived: { tape: 'aftermarket', probablySold: false, venue: 'Spaceship Parking', olderName: true, homepageState: 'live site', length: 7, registeredYear: 2019, timeline: [] }, insight: null },
    { domain: 'moved.com', classification: 'transfer-completed', derived: { tape: 'aftermarket', probablySold: false, venue: 'Afternic', homepageState: 'parked', length: 5, timeline: [] }, insight: null },
    { domain: 'moving.com', classification: 'transfer-in-progress', derived: { tape: 'aftermarket', probablySold: false, venue: 'Sedo', homepageState: 'parked', length: 6, timeline: [] }, insight: null },
  ];
  const classes = { likelySale: 0, transferCompleted: 1, transferInProgress: 1, candidate: 1 };
  app._saleWatchDaily = {
    days: [
      { day: '2026-11-12', counts: { aftermarket: 300, builder: 0, noise: 0 }, probable: { aftermarket: 0, builder: 0, noise: 0 }, classes, rows: rows.slice(0, 1) },
      { day: '2026-11-12', continued: true, counts: { aftermarket: 300, builder: 0, noise: 0 }, probable: { aftermarket: 0, builder: 0, noise: 0 }, classes, rows: rows.slice(1) },
    ],
    window: { tape: 'aftermarket', counts: { aftermarket: 300, builder: 0, noise: 0 }, probable: { aftermarket: 0, builder: 0, noise: 0 }, classes },
    pagination: { nextCursor: null },
  };
  app.renderSaleWatchDaily();
  const html = el('sale-watch-daily').innerHTML;
  const older = facts(rowOf(html, 'oldpark.com'));
  assert.deepEqual(older.slice(0, 2), [['venue', 'left Spaceship Parking'], ['site', 'live site']]);
  assert.doesNotMatch(html, /older name/, 'the older name tag is never printed');
  assert.ok(rowOf(html, 'oldpark.com').includes('sale-watch-tier candidate'));
  assert.ok(rowOf(html, 'moved.com').includes('>transfer completed<'));
  assert.ok(rowOf(html, 'moving.com').includes('>transfer in progress<'));
  assert.ok(!facts(rowOf(html, 'moved.com')).some(([k]) => k === 'older'), 'no older fact');
  const heads = [...html.matchAll(/<header class="sale-watch-day-head" data-continued="(true|false)">([\s\S]*?)<\/header>/g)];
  assert.equal(heads.length, 2);
  assert.equal(heads[1][1], 'true');
  assert.ok(heads[1][2].includes('continued'));
  assert.ok(heads[1][2].includes('0 sold · 300 candidates'), 'continued header keeps the whole-day counts');
  assert.ok(!/transfer/.test(heads[0][2]), 'no transfer counts in the day title');
  assert.doesNotMatch(el('sale-watch-subtitle').textContent, /transfer/, 'transfer counts live in the Reason breakdown, not the header line');
});
