'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { openWatchlist, normalizeDomain } = require('../server/watchlist');

test('a name is stored the same way however it was typed', () => {
  assert.equal(normalizeDomain(' HTTPS://www.Example.COM/path?x=1 '), 'example.com');
  assert.equal(normalizeDomain('sub.example.co.uk.'), 'sub.example.co.uk');
  for (const bad of ['', 'nodot', 'a b.com', '-x.com', 'x..com', '<script>.com']) assert.equal(normalizeDomain(bad), '', bad);
});

test('the eye adds and removes a name, and each name comes back with where it is listed now', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-watch-'));
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const asked = [];
  // The inventory: the provider snapshot and the stored streams answer separately.
  app.get('/api/domains', (req, res) => {
    asked.push([req.query.stream || 'stored', req.query.q, req.query.searchMode]);
    const rows = req.query.stream === 'godaddy-auction'
      ? [{ domain: 'durango.net', source: 'GoDaddy Auction', stream: 'godaddy-auction', auction_end: '2099-01-02T00:00:00Z', auction_url: 'https://gd/durango.net' }, { domain: 'durangohub.com', source: 'GoDaddy Auction', stream: 'godaddy-auction', auction_end: '2099-01-01T00:00:00Z' }]
      : [{ domain: 'durango.net', source: 'Namecheap', stream: 'namecheap-auction', auction_end: '2001-01-01T00:00:00Z', auction_url: null }];
    res.json({ domains: rows });
  });
  const watchlist = openWatchlist({ dataDir, port });
  watchlist.routes(app);
  const base = 'http://127.0.0.1:' + port;
  try {
    assert.deepEqual(await (await fetch(base + '/api/watch')).json(), { domains: [], count: 0 });
    assert.equal((await fetch(base + '/api/watch/not%20a%20name', { method: 'PUT' })).status, 400);
    await fetch(base + '/api/watch/Durango.NET', { method: 'PUT' });
    await fetch(base + '/api/watch/durango.net', { method: 'PUT' });
    assert.deepEqual(await (await fetch(base + '/api/watch/quiet.io', { method: 'PUT' })).json(), { domains: ['durango.net', 'quiet.io'], count: 2 });

    const now = await watchlist.current();
    assert.deepEqual(now, [
      { domain: 'durango.net', atAuctionNow: true, listings: [
        { venue: 'Namecheap', listing: 'namecheap-auction', endsAt: '2001-01-01T00:00:00Z', url: null },
        { venue: 'GoDaddy Auction', listing: 'godaddy-auction', endsAt: '2099-01-02T00:00:00Z', url: 'https://gd/durango.net' },
      ] },
      { domain: 'quiet.io', atAuctionNow: false, listings: [] },
    ]);
    // Only the exact name counts, and each stream is asked by the name's label.
    assert.ok(asked.some(a => a[0] === 'godaddy-auction' && a[1] === 'durango' && a[2] === 'prefix'));
    // A second read soon after does not ask the inventory again.
    const before = asked.length;
    await watchlist.current();
    assert.equal(asked.length, before);

    assert.deepEqual(await (await fetch(base + '/api/watch/durango.net', { method: 'DELETE' })).json(), { domains: ['quiet.io'], count: 1 });
    // Reopened from the same folder, the list is still there.
    assert.deepEqual(openWatchlist({ dataDir, port }).names().map(n => n.domain), ['quiet.io']);
  } finally {
    server.close();
  }
});
