'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
const { readSaleWatchLedger } = require(path.join(root, 'server/sale-watch'));
const ledger = readSaleWatchLedger();

function writeLedgerFixture(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const discoveryPath = path.join(dir, 'discovery.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ entries }), 'utf8');
  return { ledgerPath, discoveryPath };
}

// Compact/days surface tests (CHANGE 1) need a real alpha-qualifying,
// non-stale acquisition-candidate row. This mirrors the exact ParkLogic
// seller-departure + matching-brand-destination fixture already proven in
// tests/sale-watch-evidence.test.js ('ParkLogic (parking-origin) rows...'),
// but timestamped relative to the real clock (assessSaleEntry defaults `now`
// to `new Date()` on this route, unlike the evidence-file tests which pass a
// fixed `now`). `departureDaysAgo` moves only the departure/report date;
// lastObservedAt/rdap.checkedAt stay "today" so the row is never stale.
function acquisitionCandidateFixture(domain, label, { departureDaysAgo = 0 } = {}) {
  const now = new Date();
  const recent = now.toISOString();
  const departureIso = new Date(now.getTime() - departureDaysAgo * 86400000).toISOString().slice(0, 10);
  const buyerUrl = `https://${domain}`;
  return {
    domain,
    tier: 'probable',
    reportDate: departureIso,
    lastObservedAt: recent,
    sellerNameservers: ['ns1.gm111.parklogic.com', 'ns2.gm111.parklogic.com'],
    buyerUrl,
    discovery: {
      structurallyMoved: true,
      buyerUse: true,
      departureDate: departureIso,
      homepage: { active: true, status: 200, title: `${label} — team planning`, finalUrl: buyerUrl },
      rdap: { lastChangedAt: recent, statuses: [], checkedAt: recent, registrar: 'Example Registrar Inc.' },
    },
  };
}

async function callSaleWatchRoute(entries, query) {
  const { registerSaleWatchRoutes } = require('../server/sale-watch');
  const { ledgerPath, discoveryPath } = writeLedgerFixture(entries);
  const routes = new Map();
  const stubApp = { get(routePath, handler) { routes.set(routePath, handler); } };
  registerSaleWatchRoutes(stubApp, { ledgerPath, discoveryPath, reconstructionLoader: async () => [] });
  const handler = routes.get('/api/sale-watch');
  let sent = null;
  const res = { set(){}, status(){ return this; }, json(body){ sent = body; } };
  await handler({ query }, res);
  return sent;
}

test('Sale Watch is a first-class visible DomainScout navigation surface', () => {
  assert.match(html, /data-stream="_salewatch"[^>]*>\s*◉ Sale Watch/);
  assert.match(html, /id="sale-watch-panel"[\s\S]*id="sale-watch-title"[^>]*>Sale Watch</);
  assert.match(app, /_toolPanels: \[[^\]]*'_salewatch'/);
  assert.match(app, /if \(stream === '_salewatch'\)[\s\S]*this\.showSaleWatchPanel\(\)/);
});

test('Sale Watch seed includes every adjudicated end-user row, not the eight monitor controls', () => {
  assert.equal(ledger.counts.admitted, 26);
  assert.equal(ledger.counts.verified, 7);
  assert.equal(ledger.counts.probable, 19);
  assert.equal(ledger.counts.suspected, 0);
  assert.equal(ledger.counts.auctionPricesShown, 0);
  assert.equal(ledger.coverage.reportedRowsChecked, 600);
  assert.ok(ledger.entries.every(row => row.rationale && row.sellerNameservers.length && row.buyerNameservers.length));
});

test('Evidence links open a new tab without replacing DomainScout', () => {
  assert.match(app, /target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/);
  assert.match(app, /Open observed destination ↗/);
  assert.match(app, /Open source evidence ↗/);
});

test('External clickouts never disclose the DomainScout deployment as a referrer', () => {
  const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(server, /res\.set\('Referrer-Policy', 'no-referrer'\)/);
});

test('Sale Watch surface remains usable at MacBook and narrow widths', () => {
  assert.match(css, /\.app\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*width:\s*100%[^}]*min-width:\s*0/);
  assert.match(css, /\.sale-watch-metrics\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*240px\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.sale-watch-metrics\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*240px\)/);
  assert.match(css, /\.sale-watch-panel\s*\{[^}]*overflow-y:\s*auto[^}]*overflow-x:\s*hidden[^}]*width:\s*100%[^}]*min-width:\s*0/);
  assert.match(css, /\.sale-watch-(?:hero|metrics|toolbar|list)\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/);
  assert.match(css, /\.main\s*\{[^}]*min-width:\s*0/);
});

test('Sale Watch ledger ranks a newer suspected sale above an older verified sale', () => {
  const { ledgerPath, discoveryPath } = writeLedgerFixture([
    { domain: 'old-verified.com', tier: 'verified', sourceUrl: 'https://reports.example/sold', reportDate: '2024-01-01', reportedPriceUsd: 100 },
    { domain: 'new-suspected.com', tier: 'suspected', reportDate: '2026-08-01', reportedPriceUsd: 50 },
  ]);
  const rows = readSaleWatchLedger(ledgerPath, discoveryPath);
  assert.deepEqual(rows.entries.map(row => row.domain), ['new-suspected.com', 'old-verified.com']);
});

test('Sale Watch ledger keeps unknown departure dates last even after a recent probe', () => {
  const { ledgerPath, discoveryPath } = writeLedgerFixture([
    { domain: 'dated.com', tier: 'verified', sourceUrl: 'https://reports.example/sold', reportDate: '2025-01-01', reportedPriceUsd: 10 },
    { domain: 'observed.com', tier: 'suspected', lastObservedAt: '2026-06-15T00:00:00Z', reportedPriceUsd: 10 },
  ]);
  const rows = readSaleWatchLedger(ledgerPath, discoveryPath);
  assert.deepEqual(rows.entries.map(row => row.domain), ['dated.com', 'observed.com']);
});

test('Sale Watch ledger sorts entries with no date information at all to the bottom', () => {
  const { ledgerPath, discoveryPath } = writeLedgerFixture([
    { domain: 'nodate.com', tier: 'verified', reportedPriceUsd: 999 },
    { domain: 'dated.com', tier: 'suspected', reportDate: '2020-01-01', reportedPriceUsd: 1 },
  ]);
  const rows = readSaleWatchLedger(ledgerPath, discoveryPath);
  assert.deepEqual(rows.entries.map(row => row.domain), ['dated.com', 'nodate.com']);
});

test('Sale Watch ledger breaks same-date ties by domain independently of price and tier', () => {
  const { ledgerPath, discoveryPath } = writeLedgerFixture([
    { domain: 'suspected-low.com', tier: 'suspected', reportDate: '2026-05-01', reportedPriceUsd: 100 },
    { domain: 'verified-high.com', tier: 'verified', sourceUrl: 'https://reports.example/sold', reportDate: '2026-05-01', reportedPriceUsd: 100 },
    { domain: 'higher-price.com', tier: 'suspected', reportDate: '2026-05-01', reportedPriceUsd: 200 },
  ]);
  const rows = readSaleWatchLedger(ledgerPath, discoveryPath);
  assert.deepEqual(
    rows.entries.map(row => row.domain),
    ['higher-price.com', 'suspected-low.com', 'verified-high.com']
  );
});


test('merged chronological pages do not show retained history ahead of unseen newer reconstruction',()=>{
 const {pageSaleLedger}=require('../server/sale-watch');
 const row=(domain,date)=>({domain,reportDate:date,tier:'transfer',classification:'transfer-in-progress'});
 const retained=[row('old.com','2026-09-01'),row('middle.com','2026-09-14')];
 const recon=[row('a.com','2026-09-15'),row('b.com','2026-09-15'),row('c.com','2026-09-15')];
 const first=pageSaleLedger({entries:[...retained,...recon],excludedEntries:[]},recon,{view:'leads',pageSize:2,scanLimit:3});
 assert.deepEqual(first.entries.map(e=>e.domain),['a.com','b.com']);
 const after=JSON.parse(Buffer.from(first.pagination.nextCursor,'base64url'));
 const second=pageSaleLedger({entries:[...retained,recon[2]],excludedEntries:[]},[recon[2]],{view:'leads',after,pageSize:2,scanLimit:3});
 assert.deepEqual(second.entries.map(e=>e.domain),['c.com','middle.com']);
 const last=pageSaleLedger({entries:retained,excludedEntries:[]},[],{view:'leads',after:JSON.parse(Buffer.from(second.pagination.nextCursor,'base64url')),pageSize:2,scanLimit:3});
 assert.deepEqual(last.entries.map(e=>e.domain),['old.com']);assert.equal(last.pagination.nextCursor,null);
});

test('GET /api/sale-watch?view=alpha returns pageSize 5000 and an alpha summary block',async()=>{
 const { registerSaleWatchRoutes } = require('../server/sale-watch');
 const { ledgerPath, discoveryPath } = writeLedgerFixture([]);
 const routes = new Map();
 const stubApp = { get(routePath, handler) { routes.set(routePath, handler); } };
 registerSaleWatchRoutes(stubApp, { ledgerPath, discoveryPath, reconstructionLoader: async () => [] });
 const handler = routes.get('/api/sale-watch');
 let sent = null;
 const res = { set(){}, status(){ return this; }, json(body){ sent = body; } };
 await handler({ query: { view: 'alpha' } }, res);
 assert.equal(sent.pagination.pageSize, 5000);
 assert.ok(sent.alpha);
 assert.equal(sent.alpha.windowDays, 30);
});

test('interactive Sale Watch pages bound initial evidence work and preserve a cursor', async()=>{
 const { registerSaleWatchRoutes } = require('../server/sale-watch');
 const { ledgerPath, discoveryPath } = writeLedgerFixture([]);
 const routes = new Map();
 const calls = [];
 const stubApp = { get(routePath, handler) { routes.set(routePath, handler); } };
 const reconstructionLoader = async query => {
   calls.push(query);
   return Array.from({length: query.limit}, (_, index) => {
     const suffix = String(index).padStart(3, '0');
     return acquisitionCandidateFixture(`flowbox${suffix}.com`, `Flowbox${suffix}`);
   });
 };
 registerSaleWatchRoutes(stubApp, { ledgerPath, discoveryPath, reconstructionLoader });
 const handler = routes.get('/api/sale-watch');
 let sent = null;
 const res = { set(){}, status(){ return this; }, json(body){ sent = body; } };
 await handler({ query: { view: 'leads', surface: 'interactive' } }, res);
 assert.equal(calls[0].limit, 101, 'one lookahead row establishes whether another page exists');
 assert.equal(sent.pagination.pageSize, 100);
 assert.equal(sent.entries.length, 100);
 assert.ok(sent.pagination.nextCursor);
});

test('interactive Sale Watch never waits for the supplementary full-history coverage census', async () => {
  const { registerSaleWatchRoutes } = require('../server/sale-watch');
  const { ledgerPath, discoveryPath } = writeLedgerFixture([]);
  const routes = new Map();
  const callOrder = [];
  let releaseCoverage;
  const coverage = new Promise(resolve => { releaseCoverage = resolve; });
  registerSaleWatchRoutes({ get(routePath, handler) { routes.set(routePath, handler); } }, {
    ledgerPath,
    discoveryPath,
    reconstructionLoader: async () => { callOrder.push('page'); return []; },
    reconstructionCoverage: () => { callOrder.push('coverage'); return coverage; },
    coverageWaitMs: 1000,
  });
  let sent;
  const response = routes.get('/api/sale-watch')(
    { query: { view: 'probable', surface: 'interactive', days: '7' } },
    { set() {}, status() { return this; }, json(body) { sent = body; } },
  );
  const outcome = await Promise.race([response.then(() => 'returned'), new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
  assert.equal(outcome, 'returned');
  assert.deepEqual(callOrder, ['page', 'coverage'], 'the indexed page enters the single read lane before full-history coverage');
  assert.equal(sent.coverage.reconstruction.pending, true);
  releaseCoverage({ following: 123 });
  await coverage;
});

test('view=alpha and compact=1 returns entries with exactly the compact keys and no discovery key', async () => {
  const sent = await callSaleWatchRoute([
    acquisitionCandidateFixture('flowbox.com', 'Flowbox'),
  ], { view: 'alpha', compact: '1' });
  assert.equal(sent.compact, true);
  const rows = [...sent.entries, ...sent.excludedEntries];
  assert.ok(rows.length > 0);
  const expectedKeys = ['domain','classification','tier','reportDate','buyerTitle','buyerUrl','venue','sellerNameservers','buyerNameservers','basis','departureDaySource','registrar','transferAt','signals','counterEvidence','rationale','marketplace'].sort();
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), expectedKeys);
    assert.equal(row.discovery, undefined);
  }
});

test('days=7 drops older entries and keeps alpha.total consistent with the returned rows', async () => {
  const sent = await callSaleWatchRoute([
    acquisitionCandidateFixture('flowbox.com', 'Flowbox', { departureDaysAgo: 0 }),
    acquisitionCandidateFixture('boxflow.com', 'Boxflow', { departureDaysAgo: 40 }),
  ], { view: 'alpha', days: '7' });
  assert.equal(sent.days, 7);
  const rows = [...sent.entries, ...sent.excludedEntries];
  assert.deepEqual(rows.map(r => r.domain).sort(), ['flowbox.com']);
  assert.equal(sent.alpha.total, rows.length);
});

test('without days or compact params the response keeps its original full-entry shape', async () => {
  const sent = await callSaleWatchRoute([acquisitionCandidateFixture('flowbox.com', 'Flowbox')], { view: 'all' });
  assert.equal(sent.compact, undefined);
  assert.equal(sent.days, undefined);
  assert.ok(sent.entries[0].discovery);
  assert.equal(typeof sent.entries[0].domain, 'string');
});

test('indexed Sale Watch coverage replaces the interactive raw-file placeholder', async () => {
  const { registerSaleWatchRoutes } = require('../server/sale-watch');
  const { ledgerPath, discoveryPath } = writeLedgerFixture([]);
  const routes = new Map();
  registerSaleWatchRoutes({ get(routePath, handler) { routes.set(routePath, handler); } }, {
    ledgerPath,
    discoveryPath,
    reconstructionLoader: async () => ({
      entries: [],
      source: 'stored',
      generatedAt: '2026-10-29T17:04:05.038Z',
      coverage: {
        discoveryMode: 'public-reverse-nameserver',
        nameserverDiscovery: { coverageStatus: 'partial-public-sample' },
        nameserverDeparturesInspected: 823,
        nameserverAssociationsExposed: 1500,
      },
      ledgerStore: { serving: 'indexed-probable-projection', assessed: 266, total: 266 },
    }),
  });
  let sent = null;
  const res = { set(){}, status(){ return this; }, json(body){ sent = body; } };
  await routes.get('/api/sale-watch')({ query: { view: 'probable', surface: 'interactive' } }, res);
  assert.equal(sent.generatedAt, '2026-10-29T17:04:05.038Z');
  assert.equal(sent.coverage.discoveryMode, 'public-reverse-nameserver');
  assert.equal(sent.coverage.nameserverDiscovery.coverageStatus, 'partial-public-sample');
  assert.equal(sent.coverage.nameserverDeparturesInspected, 823);
  assert.equal(sent.coverage.reconstruction.ledgerStore.total, 266);
  assert.equal(sent.delivery.source, 'local-projection', 'a desktop projection is never presented as current cloud evidence');
  assert.ok(sent.delivery.warning);
});

test('Sale Watch search placeholder describes name and theme search', () => {
  assert.match(html, /id="sale-watch-search"[^>]*placeholder="Search a name or theme, e\.g\. inference"/);
  assert.doesNotMatch(html, /Search domain, destination, seller DNS/);
});

test('Sale Watch toolbar wraps on phones with 40px controls', () => {
  const phone = css.match(/@media \(max-width: 820px\) \{[\s\S]*?\n\}/)[0];
  assert.match(phone, /\.sale-watch-toolbar \{[^}]*flex-direction: column/);
  assert.match(phone, /\.sale-watch-toolbar select \{[^}]*width: 100%[^}]*min-width: 0/);
  assert.match(phone, /\.sale-watch-toolbar input, \.sale-watch-toolbar select, \.sale-watch-toolbar \.btn \{[^}]*min-height: 40px/);
});

test('Sale Watch phone header (<600px): hero description hidden, metrics in one compact row, toolbar directly under, no new accents', () => {
  const block = css.match(/@media \(max-width: 600px\) \{[\s\S]*?\n\}/);
  assert.ok(block, 'max-width 600px block exists');
  const phone = block[0];
  assert.match(phone, /\.sale-watch-hero p:not\(\.sale-watch-eyebrow\) \{[^}]*display: none/);
  assert.match(phone, /\.sale-watch-metrics \{[^}]*display: flex[^}]*flex-wrap: wrap/);
  assert.match(phone, /\.sale-watch-metrics article \{[^}]*padding: 0[^}]*border: 0/);
  assert.match(phone, /\.sale-watch-metrics article::after \{[^}]*content: attr\(data-short\)/);
  assert.match(phone, /\.sale-watch-toolbar \{[^}]*margin: 6px 0 8px/);
  // No new colour accents, edge bars or underlines.
  assert.doesNotMatch(phone, /#[0-9a-f]{3,8}\b|rgba?\(|border-(left|right|top|bottom)|text-decoration|box-shadow/i);
  // The 600px block follows the 820px block so it wins the cascade.
  assert.ok(css.indexOf('@media (max-width: 600px)') > css.indexOf('@media (max-width: 820px)'));
  // The Sale Watch hero has no pill and no LOADED counter.
  const hero = html.slice(html.indexOf('id="sale-watch-panel"'), html.indexOf('id="sale-watch-search"'));
  assert.doesNotMatch(hero, /sale-watch-live|sale-watch-metrics|sale-watch-total|loaded/i);
});

test('Sale Watch is populated natively and never launches the AgentForge interface', () => {
  assert.match(html, /id="sale-watch-daily"/);
  assert.match(html, /id="sale-watch-search"/);
  assert.match(app, /fetch\(`\$\{API\}\/api\/sale-watch\/daily\?/);
  assert.match(app, /renderSaleWatchDaily\(\)/);
  assert.doesNotMatch(html, /agentforge-console[^"']+\/app/);
  assert.doesNotMatch(html, /Open live Sale Watch/);
});

test('one screen: the old Probably sold list, its Show more button and its window select are gone', () => {
  assert.doesNotMatch(html, /id="sale-watch-list"|id="sale-watch-more"|id="sale-watch-window"/);
  assert.doesNotMatch(app, /renderSaleWatch\(|loadSaleWatch\(|showMoreSaleWatch|_applySaleWatchLive|_saleWatchWindowDays/);
  assert.equal((html.match(/class="sale-watch-daily"/g) || []).length, 1);
  // Hero, search box and method note stay.
  assert.match(html, /class="sale-watch-hero"[\s\S]*id="sale-watch-search"[\s\S]*id="sale-watch-daily"[\s\S]*class="sale-watch-method"/);
});

test('the feed requests the selected window with tape, q and cursor', () => {
  assert.match(app, /\/api\/sale-watch\/daily\?window=\$\{winDays\}&tape=\$\{encodeURIComponent\(tape\)\}&q=\$\{encodeURIComponent\(query\)\}&cursor=/);
});

test('Sale Watch rows label why they matched the query', () => {
  const vm = require('node:vm');
  const source = app.match(/const matchLabel = row => \{[\s\S]*?\n    \};/)[0];
  const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const label = (query, row) => vm.runInNewContext(`${source}; matchLabel(row)`, { query, row, esc });
  assert.equal(label('inference', { domain: 'fastinference.ai', matchedOn: 'name', matchedTerm: 'inference' }), '<small class="sale-watch-match" data-matched="name">matched: name</small>');
  assert.equal(label('inference', { domain: 'lumen.ai', matchedOn: 'site title', matchedTerm: 'inference' }), '<small class="sale-watch-match" data-matched="site title">matched: site title</small>');
  assert.equal(label('inference', { domain: 'lumen.ai', matchedOn: 'site text', matchedTerm: 'inference' }), '<small class="sale-watch-match" data-matched="site text">matched: site text</small>');
  assert.equal(label('compute', { domain: 'tensorfarm.com', matchedOn: 'theme', matchedTerm: 'gpu' }), '<small class="sale-watch-match" data-matched="theme">related by theme (gpu)</small>');
  assert.equal(label('', { domain: 'x.com', matchedOn: 'name', matchedTerm: 'x' }), '', 'no label without a query');
  assert.equal(label('gpu', { domain: 'a.com', matchedOn: 'theme', matchedTerm: '<b>' }), '<small class="sale-watch-match" data-matched="theme">related by theme (&lt;b&gt;)</small>');
  const rule = css.match(/small\.sale-watch-match \{[^}]*\}/)[0];
  assert.match(rule, /overflow-wrap: anywhere/);
  assert.doesNotMatch(rule, /color|border|background/);
});

test('Sale Watch keeps truthful evidence labels and never claims a completed payment', () => {
  assert.match(html, /<h2 id="sale-watch-title"[^>]*>Sale Watch<\/h2>/);
  assert.match(html, /id="sale-watch-subtitle"/);
  assert.match(html, /Payment and ownership are not confirmed, and no numeric probability is claimed/);
  assert.doesNotMatch(html, /Wider departure tape|early seller departures|Noise \/ excluded|All movements/);
  assert.doesNotMatch(app, /showSaleWatchLeads|_renderSaleWatchLeadsHint|\/api\/sale-watch\/candidates/);
  assert.match(app, /built: 'Branded operating destination \+ registrar transfer'/);
  assert.match(app, /transfer: 'Marketplace departure \+ registrar transfer'/);
  assert.match(app, /'off-market': 'Marketplace departure \+ stayed off-market'/);
  assert.match(app, /likely purchase ·/);
  assert.match(app, /moving ·/);
  assert.doesNotMatch(app, />Probably sold<\/span>/);
});

test('Sale Watch status does not market the wider movement tape', () => {
  assert.doesNotMatch(app, /raw names monitored|zone movement follow-up awaiting|more movements available below/);
  assert.match(app, /earlier days load as you scroll/);
});

test('background feed refreshes apply in place, preserving the visible row, its offset and open evidence', () => {
  assert.match(app, /setInterval\(\(\) => \{ if \(state\.stream === '_salewatch'\) this\.loadSaleWatchDaily\(false, true\); \}, 30000\)/);
  assert.match(app, /if \(replacing && !append\) this\._preserveSaleWatchAnchor\(render\)/);
  assert.match(app, /_preserveSaleWatchAnchor\(render\) \{[\s\S]*?getBoundingClientRect[\s\S]*?row\.open = true/);
  assert.doesNotMatch(app, /refresh to apply any list changes/);
});
