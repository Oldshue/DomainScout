'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATES, quoteAfternic, quoteSedo, quoteListing } = require('../server/listing-quotes');

function nextData(profile) {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { profile } } })}</script></html>`;
}

test('Afternic exact quote normalizes micro-dollar BIN prices', async () => {
  const client = { get: async () => ({
    status: 200, headers: {}, data: nextData({ domain: 'orchardledger.com', isForSale: true, buyNow: 2450000000, minBid: 1800000000 }),
  }) };
  const quote = await quoteAfternic('orchardledger.com', { client });
  assert.equal(quote.state, STATES.FIXED_PRICE);
  assert.equal(quote.price, 2450);
  assert.equal(quote.minOffer, 1800);
});

test('Afternic redirects preserve listed-unpriced separately from absent', async () => {
  const listedClient = { get: async () => ({ status: 307, headers: { location: '/forsale/cobaltclinic.com' } }) };
  const absentClient = { get: async () => ({ status: 307, headers: { location: '/_error' } }) };
  assert.equal((await quoteAfternic('cobaltclinic.com', { client: listedClient })).state, STATES.LISTED_UNPRICED);
  assert.equal((await quoteAfternic('cobaltclinic.com', { client: absentClient })).state, STATES.ABSENT);
});

test('Sedo exact quote normalizes cents and keeps bid ranges unpriced', async () => {
  const binClient = { get: async () => ({ status: 200, data: {
    name: 'orchardledger.com', domainPriceType: 'buynow',
    buynow: { priceOptions: { price: 47500, currency: { name: 'usd' } } },
  } }) };
  const rangeClient = { get: async () => ({ status: 200, data: { domainPriceType: 'bidrange' } }) };
  assert.equal((await quoteSedo('orchardledger.com', { client: binClient })).price, 475);
  assert.equal((await quoteSedo('orchardledger.com', { client: rangeClient })).state, STATES.LISTED_UNPRICED);
});

test('provider-neutral quote falls through from absent Afternic to fixed Sedo', async () => {
  const client = { get: async url => {
    if (url.includes('afternic.com')) return { status: 307, headers: { location: '/_error' } };
    return { status: 200, data: {
      name: 'cobaltclinic.com', domainPriceType: 'buynow',
      buynow: { priceOptions: { price: 129900, currency: { name: 'usd' } } },
    } };
  } };
  const quote = await quoteListing('cobaltclinic.com', { client });
  assert.equal(quote.provider, 'Sedo');
  assert.equal(quote.state, STATES.FIXED_PRICE);
  assert.equal(quote.price, 1299);
  assert.equal(quote.quotes.length, 2);
});
