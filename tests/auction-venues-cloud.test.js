'use strict';

// Every auction venue's board refreshes in the cloud by default, a flagged (Saved)
// name follows its listing to whichever venue has it today, and a venue that stops
// refreshing is visible in /api/health.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const scrapeAll = fs.readFileSync(path.join(root, 'server/scrape-all.js'), 'utf8');
const dynadot = require('../scrapers/dynadot');
const { applyCurrentListingsToSaved, upsertCurrentListings } = require('../server/saved-listings');
const { STREAM_DESCRIPTORS } = require('../server/provider-snapshot-registry');
const { ACTIVE_AUCTION_STREAMS } = require('../server/auction-cleanup');

function cronBody(expression) {
  const start = server.indexOf(`cron.schedule('${expression}'`);
  assert.notStrictEqual(start, -1, `cron ${expression} is scheduled`);
  return server.slice(start, server.indexOf('});', start));
}

test('Namecheap and Dynadot boards are scheduled without the opt-in heavy gate', () => {
  for (const expression of ['10 * * * *', '40 */4 * * *']) {
    const body = cronBody(expression);
    assert.match(body, /BACKGROUND_BULK_REFRESH_ENABLED/);
    assert.doesNotMatch(body, /HEAVY_REFRESH_CRON_ENABLED/);
  }
  assert.match(cronBody('40 */4 * * *'), /dynadotOnly: true/);
  assert.match(server, /dynadot-startup-current-inventory/);
  assert.match(server, /'dynadot-auction': \{ maxHeartbeatAgeMs:/);
  assert.match(scrapeAll, /--dynadot-only/);
  assert.ok(STREAM_DESCRIPTORS.some(d => d.stream === 'dynadot-auction'));
  assert.ok(ACTIVE_AUCTION_STREAMS.includes('dynadot-auction'));
});

test('a successful venue refresh is logged and failures reach health', () => {
  const body = scrapeAll.slice(scrapeAll.indexOf('async function refreshProviderInventory'), scrapeAll.indexOf('async function refreshNamecheapInventory'));
  assert.match(body, /logRun\.run\(\{ stream, domains_found: manifest\.count, domains_new: 0, error: null \}\)/);
  assert.match(body, /status: 'failed'/);
  assert.match(body, /refreshSavedListings\(label, domains\)/);
  assert.match(server, /auctionVenues: auctionVenueHealth\(\)/);
  assert.match(server, /\[AuctionVenues:STALE\]/);
});

function record(domain, overrides = {}) {
  return { domain, utf_name: domain, current_bid_price: '12.50', bids: 3, end_time_stamp: Date.now() + 86_400_000, age: 4, ...overrides };
}

test('Dynadot board reads every page of the account API and de-duplicates the first page', async () => {
  const full = (prefix) => Array.from({ length: dynadot.API_PAGE_SIZE }, (_, i) => record(`${prefix}${i}.com`));
  const asked = [];
  const pages = {
    expired: [full('a'), full('a'), full('b'), [record('last.ai'), record('ended.com', { end_time_stamp: Date.now() - 1000 })]],
    user: [[record('user-one.io')], [record('user-one.io')]],
  };
  const rows = await dynadot.scrapeDynadotAuctions({
    minIntervalMs: 0,
    fetchPage: async ({ type, pageIndex }) => { asked.push(`${type}:${pageIndex}`); return pages[type][pageIndex] || []; },
  });
  assert.deepStrictEqual(asked, ['expired:0', 'expired:1', 'expired:2', 'expired:3', 'user:0', 'user:1']);
  assert.strictEqual(rows.length, 2 * dynadot.API_PAGE_SIZE + 2);
  const row = rows.find(r => r.domain === 'last.ai');
  assert.deepStrictEqual(
    { stream: row.stream, source: row.source, tld: row.tld, price: row.auction_price, bids: row.bid_count, url: row.auction_url },
    { stream: 'dynadot-auction', source: 'Dynadot', tld: '.ai', price: 12.5, bids: 3, url: 'https://www.dynadot.com/market/auction/last.ai' },
  );
  assert.strictEqual(rows.find(r => r.domain === 'user-one.io').source, 'Dynadot user auction');
  assert.ok(!rows.some(r => r.domain === 'ended.com'));
  assert.strictEqual(rows.snapshotEvidence.source, 'dynadot-account-api-get_open_auctions');
});

test('Dynadot board refuses a pager that does not advance, and needs the account key', async () => {
  const same = Array.from({ length: dynadot.API_PAGE_SIZE }, (_, i) => record(`same${i}.com`));
  await assert.rejects(dynadot.scrapeDynadotAuctions({ minIntervalMs: 0, fetchPage: async () => same }), /pagination did not advance/);
  const prior = process.env.DOMAINSCOUT_DYNADOT_API_KEY;
  delete process.env.DOMAINSCOUT_DYNADOT_API_KEY;
  try {
    assert.strictEqual(dynadot.boardConfigured(), false);
    await assert.rejects(dynadot.scrapeDynadotAuctions(), /DOMAINSCOUT_DYNADOT_API_KEY/);
  } finally {
    if (prior !== undefined) process.env.DOMAINSCOUT_DYNADOT_API_KEY = prior;
  }
  // Without the key the board is never started, but flagged names are still watched.
  assert.match(server, /options\.dynadotOnly && !dynadotBoardConfigured\(\)/);
  assert.match(server, /cron\.schedule\('\*\/20 \* \* \* \*', \(\) => watchFlaggedNamesAtDynadot/);
  assert.match(server, /watchlist\.names\(\)/);
});

test('a by-name Dynadot lookup tells listed, not listed and could-not-look apart', async () => {
  const listed = { status: 200, data: { code: 200, data: { data: { domain: 'qten.com', utf8_name: 'qten.com', bid_price: '2225', bids: 118, end_time_stamp: Date.now() + 3_600_000 } } } };
  const missing = { status: 200, data: { code: 500, msg: 'can not find auction, auction name: nope.com', data: null } };
  const calls = [];
  const client = answers => ({ request: async (config) => { calls.push(config.params); return answers[config.params.aftermarket_type] || missing; } });
  const hit = await dynadot.lookupDynadotListing('QTEN.com', { client: client({ USER_AUCTION: listed }) });
  assert.strictEqual(hit.domain, 'qten.com');
  assert.strictEqual(hit.source, 'Dynadot user auction');
  assert.strictEqual(hit.auction_price, 2225);
  assert.deepStrictEqual(calls.map(c => c.aftermarket_type), ['EXPIRED_AUCTION', 'USER_AUCTION']);
  assert.strictEqual(await dynadot.lookupDynadotListing('nope.com', { client: client({}) }), null);
  await assert.rejects(dynadot.lookupDynadotListing('x.com', { client: { request: async () => ({ status: 403, data: '<html>Attention Required</html>' }) } }), /HTTP 403/);
  await assert.rejects(dynadot.lookupDynadotListing('x.com', { client: { request: async () => ({ status: 200, data: { code: 401, msg: 'please signin first' } }) } }), /answered 401/);
});

function savedDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, stream TEXT NOT NULL, source TEXT,
    auction_price REAL, auction_end TEXT, auction_url TEXT, bid_count INTEGER DEFAULT 0,
    tld TEXT, length INTEGER, has_numbers INTEGER DEFAULT 0, has_hyphens INTEGER DEFAULT 0,
    saved INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, notes TEXT, UNIQUE(domain, stream))`);
  return db;
}

test('a relisted Saved name takes the new venue, end, price and URL and stays saved', () => {
  const db = savedDb();
  const insert = db.prepare('INSERT INTO domains (domain, stream, source, auction_price, auction_end, auction_url, saved, notes) VALUES (?,?,?,?,?,?,?,?)');
  insert.run('constellation.ai', 'namecheap-auction', 'Namecheap', 25200, '2026-05-06T15:00:00.000Z', 'https://www.namecheap.com/market/constellation.ai', 1, 'want this');
  insert.run('durango.net', 'godaddy-auction', 'GoDaddy Auction', 314, '2026-05-03T18:30:00Z', 'https://old', 1, null);
  insert.run('durango.net', 'dynadot-auction', 'Dynadot', 5, '2026-01-01T00:00:00Z', 'https://stale', 0, null);
  insert.run('unsaved.com', 'namecheap-auction', 'Namecheap', 1, '2026-05-01T00:00:00Z', 'https://x', 0, null);
  const nowMs = Date.parse('2026-11-18T12:00:00Z');
  const updated = applyCurrentListingsToSaved(db, [
    { domain: 'constellation.ai', stream: 'namecheap-auction', source: 'Namecheap', auction_price: 31000, auction_end: '2026-11-25T15:00:00.000Z', auction_url: 'https://www.namecheap.com/market/constellation.ai', bid_count: 9 },
    { domain: 'durango.net', stream: 'dynadot-auction', source: 'Dynadot', auction_price: 77, auction_end: '2026-11-20T16:00:00.000Z', auction_url: 'https://www.dynadot.com/market/auction/durango.net', bid_count: 2 },
    { domain: 'unsaved.com', stream: 'dynadot-auction', source: 'Dynadot', auction_price: 9, auction_end: '2026-11-20T16:00:00.000Z', auction_url: 'https://y' },
    { domain: 'constellation.ai', stream: 'dynadot-auction', source: 'Dynadot', auction_price: 1, auction_end: '2026-11-01T00:00:00.000Z', auction_url: 'https://ended' },
  ], { nowMs });
  assert.deepStrictEqual(updated.map(u => u.domain).sort(), ['constellation.ai', 'durango.net']);
  const saved = db.prepare('SELECT domain, stream, source, auction_price, auction_end, auction_url, bid_count, saved, notes FROM domains WHERE saved = 1 ORDER BY domain').all();
  assert.deepStrictEqual(saved, [
    { domain: 'constellation.ai', stream: 'namecheap-auction', source: 'Namecheap', auction_price: 31000, auction_end: '2026-11-25T15:00:00.000Z', auction_url: 'https://www.namecheap.com/market/constellation.ai', bid_count: 9, saved: 1, notes: 'want this' },
    { domain: 'durango.net', stream: 'dynadot-auction', source: 'Dynadot', auction_price: 77, auction_end: '2026-11-20T16:00:00.000Z', auction_url: 'https://www.dynadot.com/market/auction/durango.net', bid_count: 2, saved: 1, notes: null },
  ]);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM domains WHERE domain = 'durango.net'").get().n, 1);
  assert.strictEqual(db.prepare("SELECT stream FROM domains WHERE domain = 'unsaved.com'").get().stream, 'namecheap-auction');
  // A venue board that no longer lists the name leaves the Saved row untouched.
  assert.deepStrictEqual(applyCurrentListingsToSaved(db, [], { nowMs }), []);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM domains WHERE saved = 1').get().n, 2);
});

test('a watched-only name gets a stored venue row that later listings update in place', () => {
  const db = savedDb();
  const nowMs = Date.parse('2026-11-18T12:00:00Z');
  const listing = { domain: 'watched.ai', tld: '.ai', stream: 'dynadot-auction', source: 'Dynadot', auction_price: 40, auction_end: '2026-11-21T16:00:00.000Z', auction_url: 'https://www.dynadot.com/market/auction/watched.ai', bid_count: 1, length: 7 };
  assert.strictEqual(upsertCurrentListings(db, [listing, { ...listing, domain: 'over.ai', auction_end: '2026-11-01T00:00:00.000Z' }], { nowMs }), 1);
  upsertCurrentListings(db, [{ ...listing, auction_price: 95, bid_count: 6 }], { nowMs });
  assert.deepStrictEqual(
    db.prepare('SELECT domain, stream, auction_price, bid_count, auction_end, saved FROM domains').all(),
    [{ domain: 'watched.ai', stream: 'dynadot-auction', auction_price: 95, bid_count: 6, auction_end: '2026-11-21T16:00:00.000Z', saved: 0 }],
  );
});
