'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const adapter = fs.readFileSync(path.join(root, 'scrapers/namecheap.js'), 'utf8');
const auctions = fs.readFileSync(path.join(root, 'scrapers/auctions.js'), 'utf8');
const scrapeAll = fs.readFileSync(path.join(root, 'server/scrape-all.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const { fetchApiPage } = require('../scrapers/namecheap');

assert.match(adapter, /client\/api\/sales/);
assert.doesNotMatch(adapter, /client\/graphql|persistedQuery/);
assert.match(adapter, /while \(true\)/);
assert.match(adapter, /cursor pagination did not advance/);
assert.match(adapter, /incomplete snapshot/);
assert.match(adapter, /find-generic-password/);

assert.match(auctions, /includeNamecheap \? scrapeNamecheap\(\) : Promise\.resolve\(\[\]\)/);
assert.match(scrapeAll, /runAuctions\(\{ includeGoDaddy: false, includeNamecheap: false \}\)/);
assert.match(scrapeAll, /Snapshot withheld/);
assert.match(scrapeAll, /--namecheap-only/);
assert.match(scrapeAll, /name === 'namecheap-auction'/);

assert.match(server, /cron\.schedule\('10 \* \* \* \*'/);
assert.match(server, /namecheap-startup-current-inventory/);
assert.match(server, /streamForCache === 'namecheap-auction'/);
assert.match(server, /Namecheap rows are withheld until a complete current snapshot is validated/);
assert.match(server, /requestedStream === 'namecheap-auction'/);
assert.match(server, /api\/namecheap-inventory/);
assert.match(server, /inventoryHealth: streamForCache === 'namecheap-auction'/);
assert.match(desktop, /godaddy-closeout', 'namecheap-auction'/);
assert.match(desktop, /api\/namecheap-inventory/);

(async () => {
  let request = null;
  const payload = await fetchApiPage({
    apiKey: 'fixture-token',
    pageSize: 25,
    cursor: 'fixture-cursor',
    client: {
      async get(url, options) {
        request = { url, options };
        return { data: { items: [], hasMore: false, nextCursor: null } };
      },
    },
  });
  assert.deepEqual(payload, { items: [], hasMore: false, nextCursor: null });
  assert.equal(request.url, 'https://aftermarketapi.namecheap.com/client/api/sales');
  assert.equal(request.options.params.cursor, 'fixture-cursor');
  assert.equal(request.options.params.pageSize, 25);
  assert.equal(request.options.headers.Authorization, 'Bearer fixture-token');
  console.log('namecheap-current-inventory.test.js: all assertions passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
