'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATES, quoteAfternic, quoteGoDaddyRegistrar, quoteSedo, quoteListing } = require('../server/listing-quotes');

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
  const client = { post: async () => ({ status: 200, data: { domains: [{ domain: 'cobaltclinic.com', available: false, definitive: true }] } }), get: async url => {
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
  assert.equal(quote.quotes.length, 3);
});

test('GoDaddy registrar confirms a premium fixed price but does not admit a hand registration', async () => {
  const premiumClient = { post: async () => ({ status: 200, data: { domains: [{ domain: 'orchardledger.com', available: true, premium: true, price: 2450000000, currency: 'USD' }] } }) };
  const handregClient = { post: async () => ({ status: 200, data: { domains: [{ domain: 'gardenloom.com', available: true, premium: false, price: 12990000, currency: 'USD' }] } }) };
  const premium = await quoteGoDaddyRegistrar('orchardledger.com', { client: premiumClient, apiKey: 'k', apiSecret: 's' });
  const handreg = await quoteGoDaddyRegistrar('gardenloom.com', { client: handregClient, apiKey: 'k', apiSecret: 's' });
  assert.equal(premium.state, STATES.FIXED_PRICE);
  assert.equal(premium.price, 2450);
  assert.equal(handreg.state, STATES.REGISTRATION_AVAILABLE);
  assert.equal(handreg.registrationPrice, 12.99);
});

test('provider-neutral lookup starts with GoDaddy and short-circuits direct marketplaces for a premium', async () => {
  const calls = [];
  const client = {
    post: async url => {
      calls.push(url);
      return { status: 200, data: { domains: [{ domain: 'authoritykey.com', available: true, premium: true, price: 988000000, currency: 'USD' }] } };
    },
    get: async url => { calls.push(url); throw new Error('direct marketplace should not be called'); },
  };
  const quote = await quoteListing('authoritykey.com', { client, godaddy: { apiKey: 'k', apiSecret: 's' } });
  assert.equal(quote.provider, 'GoDaddy');
  assert.equal(quote.price, 988);
  assert.equal(calls.length, 1);
});
