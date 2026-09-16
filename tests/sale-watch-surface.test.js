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

test('Sale Watch is a first-class visible DomainScout navigation surface', () => {
  assert.match(html, /data-stream="_salewatch"[^>]*>\s*◉ Sale Watch/);
  assert.match(html, /id="sale-watch-panel"[\s\S]*id="sale-watch-title">Sale Watch/);
  assert.match(app, /_toolPanels: \[[^\]]*'_salewatch'/);
  assert.match(app, /if \(stream === '_salewatch'\)[\s\S]*this\.showSaleWatchPanel\(\)/);
});

test('Sale Watch is populated natively and never launches the AgentForge interface', () => {
  assert.match(html, /id="sale-watch-list"/);
  assert.match(html, /id="sale-watch-search"/);
  assert.match(app, /fetch\(`\$\{API\}\/api\/sale-watch`/);
  assert.match(app, /renderSaleWatch\(\)/);
  assert.doesNotMatch(html, /agentforge-console[^"']+\/app/);
  assert.doesNotMatch(html, /Open live Sale Watch/);
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
  assert.match(css, /\.sale-watch-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(5/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.sale-watch-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
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
  // verified-high.com carries a sourceUrl + tier 'verified' with no discovery,
  // so assessSaleEntry classifies it 'reported-sale' (evidenceRank 6); the other
  // two have no discovery/sourceUrl signal at all and fall to the terminal
  // 'unconfirmed-move' classification (evidenceRank 7, the default "other"
  // bucket). Evidence rank now sorts ahead of domain length/name on a same-date
  // tie, so verified-high.com (rank 6) leads; the rank-7 pair then breaks by
  // domain length (higher-price.com, 16 chars, before suspected-low.com, 17).
  assert.deepEqual(
    rows.entries.map(row => row.domain),
    ['verified-high.com', 'higher-price.com', 'suspected-low.com']
  );
});


test('displayed departure date orders mixed tiers newest first, independent of later probes', () => {
  const vm = require('node:vm');
  const sort = app.match(/rows\.sort\(\(a,b\)=>String\(b\.reportDate[^\n]+/)[0];
  const rows = [
    {domain:'old-transfer.com', classification:'transfer-in-progress', reportDate:'2026-09-01', lastObservedAt:'2026-09-09'},
    {domain:'unknown.com', classification:'likely-sale', reportDate:null, lastObservedAt:'2026-09-10'},
    {domain:'new.com', classification:'acquisition-candidate', reportDate:'2026-09-05', lastObservedAt:'2026-09-05'},
    {domain:'aaa.com', classification:'unconfirmed-move', reportDate:'2026-09-05', lastObservedAt:'2026-09-06'},
  ];
  vm.runInNewContext(sort, {rows});
  assert.deepEqual(rows.map(row=>row.domain), ['aaa.com','new.com','old-transfer.com','unknown.com']);
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
