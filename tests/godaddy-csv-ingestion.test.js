'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../scrapers/godaddy');

test('official GoDaddy CSV fields project into a complete auction row', () => {
  const csv = [
    'Domain Name,ItemID,Auction Type,Time Left,Price,Bids,Domain Age,ValuationPrice,Majestic TF',
    'EXAMPLE.COM,718442598,Bid,08/11/2026 09:00 AM (PDT),$125,7,18,$2400,22',
    '',
  ].join('\n');
  const payload = _test.parseCsvPayload('expiring_service_auctions.csv.zip', Buffer.from(csv));
  assert.equal(payload.data.length, 1);
  const row = _test.parseListing(
    payload.data[0],
    'godaddy-auction',
    'GoDaddy Auction',
    payload.filename
  );
  assert.equal(row.domain, 'example.com');
  assert.equal(row.auction_price, 125);
  assert.equal(row.bid_count, 7);
  assert.equal(row.age_years, 18);
  assert.equal(row.auction_end, '2026-08-11T16:00:00.000Z');
  assert.equal(row.source_feed, 'expiring_service_auctions.csv.zip');
  assert.equal(row.metrics.valuationprice, '$2400');
  assert.match(row.auction_url, /example-com-718442598/);
});
