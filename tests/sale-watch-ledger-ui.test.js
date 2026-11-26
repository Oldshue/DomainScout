'use strict';

// Sale Watch page, Ledger view: Ledger is the default, Leads is one tap away,
// verdict chips filter server-side, the search box is a name-word search, a
// one-word search shows its per-week sold counts, and each day shows the
// import's recorded departures against the ledger's rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');

function loadFrontend({ store = {}, respond = () => ({ days: [], pagination: { nextCursor: null } }) } = {}) {
  const elements = {};
  const el = id => elements[id] || (elements[id] = { id, textContent: '', innerHTML: '', value: '', placeholder: '', hidden: false, style: {}, dataset: {}, focus() {}, setAttribute(k, v) { this[k] = v; } });
  const scopeButtons = ['ledger', 'leads'].map(s => ({ dataset: { saleWatchScope: s }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }));
  const document = {
    body: {}, activeElement: null, addEventListener() {}, getElementById: el,
    querySelector: () => ({ style: {}, contains: () => false }),
    querySelectorAll: sel => (sel === '[data-sale-watch-scope]' ? scopeButtons : []),
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
      const body = respond(url);
      return { ok: true, status: body && body.__status ? body.__status : 200, json: async () => body };
    },
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  context.__state.stream = '_salewatch';
  return { app: context.__app, el, fetches, store, scopeButtons };
}
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)); };

const counts = (o = {}) => ({ sold: 0, lead: 0, moved: 0, expired: 0, unknown: 0, portfolio: 0, ...o });
const ledgerPage = (extra = {}) => ({
  schema: 'domainscout.sale-watch-ledger/v1', scope: 'ledger', from: '2026-11-12', to: '2026-11-25', q: '', verdicts: ['sold', 'lead'],
  window: { totals: counts({ sold: 212, lead: 1034, moved: 28450, expired: 9100, unknown: 1890, portfolio: 77 }),
    completeness: { recorded: 41203, policyExcluded: 440, expected: 40763, ledger: 40763, difference: 0, daysWithImport: 14, daysMismatched: 0, daysWithoutImport: 0 } },
  days: [
    { day: '2026-11-25', continued: false, counts: counts({ sold: 2, lead: 1, moved: 3000 }), ledgerRows: 3003, completeness: { recorded: 3010, policyExcluded: 7, expected: 3003, ledger: 3003, difference: 0 },
      rows: [
        { domain: 'matrixinference.com', day: '2026-11-25', verdict: 'sold', classification: 'likely-sale', dest: null, source: 'assessment' },
        { domain: 'modalinference.com', day: '2026-11-25', verdict: 'sold', classification: 'transfer-completed', dest: null, source: 'assessment' },
        { domain: 'obsidianinference.com', day: '2026-11-25', verdict: 'lead', classification: 'seller-departure', dest: null, source: 'assessment' },
      ] },
    { day: '2026-11-24', continued: false, counts: counts({ moved: 2 }), ledgerRows: 2, completeness: { recorded: 9, policyExcluded: 0, expected: 9, ledger: 2, difference: 7 },
      rows: [] },
  ],
  pagination: { nextCursor: null }, ...extra,
});

test('Ledger is the default view: the feed is fetched with scope=ledger and the default verdicts sold + lead', async () => {
  const { app, fetches, el, scopeButtons } = loadFrontend({ respond: url => (url.includes('/trend/rising') ? { words: [{ word: 'inference', recent: 4, prior: 1 }], recentDays: 7, priorDays: 21 } : ledgerPage()) });
  assert.equal(app._saleWatchScope(), 'ledger');
  await app.loadSaleWatchDaily();
  await flush();
  assert.match(fetches[0], /\/api\/sale-watch\/daily\?scope=ledger&window=14&verdict=sold%2Clead&q=&cursor=$/);
  const out = el('sale-watch-daily').innerHTML;
  assert.equal((out.match(/class="sale-watch-ledger-row"/g) || []).length, 3);
  assert.ok(out.indexOf('matrixinference.com') < out.indexOf('obsidianinference.com'));
  assert.match(out, /data-verdict="sold">Sold</);
  assert.match(out, /left the market and stayed off it/);
  // Day header: counts by verdict and the completeness numbers.
  assert.match(out, /<strong>2026-11-25<\/strong> <span>2 sold · 1 lead · 3,000 moved<\/span>/);
  assert.match(out, /data-mismatch="false"[^>]*>3,010 recorded · 3,003 in ledger ✓</);
  assert.match(out, /data-mismatch="true"[^>]*>9 recorded · 2 in ledger · \+7</, 'a day whose ledger is short of the import is marked');
  assert.match(out, /No names on this day in the shown verdicts\./);
  // Window completeness line.
  assert.match(out, /id="sale-watch-ledger-check" data-mismatch="false">Past 14 days: <strong>41,203<\/strong> seller departures recorded/);
  assert.match(out, /<strong>40,763<\/strong> names in the ledger · every day matches/);
  // Verdict chips with window counts; sold and lead pressed.
  const chips = el('sale-watch-verdicts').innerHTML;
  assert.equal((chips.match(/class="sale-watch-chip/g) || []).length, 6);
  assert.match(chips, /aria-pressed="true" data-verdict="sold"[^>]*>Sold \/ probably sold<b>212<\/b>/);
  assert.match(chips, /aria-pressed="false" data-verdict="moved"[^>]*>Moved to seller or parking<b>28,450<\/b>/);
  assert.equal(scopeButtons[0].attrs['aria-pressed'], 'true');
  assert.equal(scopeButtons[1].attrs['aria-pressed'], 'false');
  // Lead-feed controls are hidden in the ledger; the verdict chips are shown.
  assert.equal(el('sale-watch-tapes').hidden, true);
  assert.equal(el('sale-watch-options').hidden, true);
  assert.equal(el('sale-watch-verdicts').hidden, false);
  assert.match(el('sale-watch-subtitle').textContent, /212 sold or probably sold · 1,034 leads · 40,763 names left a seller/);
  // Rising words (no search): chips that search the word.
  await flush();
  assert.match(el('sale-watch-daily').innerHTML, /id="sale-watch-rising"[\s\S]*data-word="inference"[^>]*>inference 4</);
});

test('the Ledger / Leads toggle persists and Leads fetches the existing feed unchanged', async () => {
  const { app, fetches, store, el } = loadFrontend({ respond: () => ({ days: [], pagination: { nextCursor: null } }) });
  app.setSaleWatchScope('leads');
  await flush();
  assert.equal(store.saleWatchScope, 'leads');
  assert.equal(app._saleWatchScope(), 'leads');
  assert.match(fetches.at(-1), /\/api\/sale-watch\/daily\?window=14&tape=aftermarket&q=&cursor=$/);
  assert.equal(el('sale-watch-tapes').hidden, false);
  assert.equal(el('sale-watch-verdicts').hidden, true);
  app.setSaleWatchScope('ledger');
  await flush();
  assert.equal(store.saleWatchScope, 'ledger');
  assert.ok(fetches.slice(1).some(u => /\/api\/sale-watch\/daily\?scope=ledger/.test(u)));
});

test('verdict chips refetch with the chosen groups, persist, and never leave none selected', async () => {
  const { app, fetches, store } = loadFrontend({ respond: () => ledgerPage() });
  app.toggleSaleWatchVerdict('expired');
  await flush();
  assert.deepEqual(JSON.parse(store.saleWatchVerdicts), ['sold', 'lead', 'expired']);
  assert.match(fetches.find(u => u.includes('scope=ledger')), /verdict=sold%2Clead%2Cexpired/);
  app.toggleSaleWatchVerdict('sold'); await flush();
  app.toggleSaleWatchVerdict('lead'); await flush();
  app.toggleSaleWatchVerdict('expired'); await flush();
  assert.deepEqual([...app._saleWatchVerdicts()], ['expired'], 'the last chip stays on');
  app.toggleSaleWatchVerdict('bogus');
  assert.deepEqual([...app._saleWatchVerdicts()], ['expired']);
});

test('a one-word search is a name-word search with a per-week sold trend strip', async () => {
  const trend = { q: 'inference', days: 90, totals: counts({ sold: 9, lead: 4, moved: 30 }),
    byWeek: [{ week: '2026-11-09', days: 7, ...counts({ sold: 2, lead: 1 }), total: 9 }, { week: '2026-11-16', days: 7, ...counts({ sold: 6, lead: 2 }), total: 20 }, { week: '2026-11-23', days: 3, ...counts({ sold: 1, lead: 1 }), total: 14 }] };
  const page = ledgerPage({ q: 'inference', search: { words: ['inference'], matches: 3, matchCounts: counts({ sold: 2, lead: 1, moved: 30 }), capped: false, cap: 5000 } });
  page.days = [{ ...page.days[0], matches: 3 }];
  const { app, fetches, el } = loadFrontend({ respond: url => (url.includes('/api/sale-watch/trend?') ? trend : page) });
  app.searchSaleWatchWord('inference');
  await flush();
  assert.match(fetches[0], /scope=ledger&window=14&verdict=sold%2Clead&q=inference/);
  assert.ok(fetches.some(u => /\/api\/sale-watch\/trend\?q=inference&days=90$/.test(u)));
  const out = el('sale-watch-daily').innerHTML;
  assert.match(out, /id="sale-watch-ledger-matches"><strong>3<\/strong> names with the word <strong>inference<\/strong>/);
  assert.match(out, /id="sale-watch-trend"/);
  assert.equal((out.match(/class="sale-watch-trend-bar"/g) || []).length, 3);
  assert.match(out, /data-week="2026-11-16" data-partial="false"[^>]*><span>6<\/span><i style="height:100%">/);
  assert.match(out, /data-week="2026-11-23" data-partial="true"/, 'the current, unfinished week is marked');
  assert.match(out, /<strong>9<\/strong> sold · 4 leads · 43 left a seller/);
  assert.match(out, /<strong>2026-11-25<\/strong> <span>3 with “inference”<\/span>/);
  // With a search the chips count the matches per verdict.
  assert.match(el('sale-watch-verdicts').innerHTML, /data-verdict="moved"[^>]*>Moved to seller or parking<b>30<\/b>/);
});

test('names are escaped, and a pending ledger keeps the page and retries', async () => {
  const page = ledgerPage();
  page.days[0].rows = [{ domain: 'x"><img src=x>.com', day: '2026-11-25', verdict: 'moved', classification: 'platform-destination', dest: '<b>Sedo</b>', source: 'import' }];
  const { app, el } = loadFrontend({ respond: () => page });
  await app.loadSaleWatchDaily();
  await flush();
  const out = el('sale-watch-daily').innerHTML;
  assert.doesNotMatch(out, /<img src=x>/);
  assert.doesNotMatch(out, /<b>Sedo<\/b>/);
  assert.match(out, /now on another marketplace or parking · now at &lt;b&gt;Sedo&lt;\/b&gt;/);
  assert.doesNotMatch(out, /sale-watch-ledger-evidence/, 'an import-only row has no stored evidence to open');
  const pending = loadFrontend({ respond: () => ({ __status: 202, status: 'pending', retryAfterMs: 5000 }) });
  await pending.app.loadSaleWatchDaily();
  await flush();
  assert.match(pending.el('sale-watch-status').textContent, /being built, retrying/);
});

test('markup and styles: the toggle is in the page with Ledger first, and the ledger works at phone width', () => {
  const scopes = html.slice(html.indexOf('sale-watch-scopes'), html.indexOf('id="sale-watch-verdicts"'));
  assert.ok(scopes.indexOf('data-sale-watch-scope="ledger"') < scopes.indexOf('data-sale-watch-scope="leads"'));
  assert.match(scopes, /data-sale-watch-scope="ledger" aria-pressed="true"/);
  assert.match(html, /id="sale-watch-verdicts" class="sale-watch-verdicts" role="group" aria-label="Verdict"/);
  const ledgerCss = css.slice(css.indexOf('/* Sale Watch ledger:'));
  const phone = ledgerCss.slice(ledgerCss.indexOf('@media (max-width: 640px)'));
  assert.ok(phone.length > 0);
  // Phone: chips scroll sideways instead of widening the page, tap targets are 40px, long names wrap.
  assert.match(phone, /\.sale-watch-verdicts \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto/);
  assert.match(phone, /\.sale-watch-verdicts \.sale-watch-chip \{[^}]*min-height: 40px/);
  assert.match(phone, /\.sale-watch-day-head \.sale-watch-ledger-check \{[^}]*flex: 1 1 100%/);
  assert.match(ledgerCss, /\.sale-watch-ledger-row a\.sale-watch-name[^{]*\{[^}]*overflow-wrap: anywhere/);
  assert.match(ledgerCss, /\.sale-watch-trend \{[^}]*max-width: 100%/);
  // Braces balance: a stray closing brace before a rule makes the browser drop that rule.
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
  assert.match(phone, /\.sale-watch-ledger-day \.sale-watch-day-head > span \{[^}]*white-space: normal/);
  assert.match(ledgerCss, /\.sale-watch-trend-bar \{[^}]*min-width: 0/);
});
