'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLander } = require('../server/lander-evidence');
const check = (html, extra = {}) => classifyLander({ domain: 'orchardledger.com', finalUrl: 'https://www.orchardledger.com/', html, ...extra });

test('registrar parking ads do not offer the researched domain', () => {
  const result = check('<h1>orchardledger.com</h1><p>has been recently registered with namecheap.com</p><a href="https://namecheap.com/market">Domains for sale</a><p>other.com $1,100 Buy now</p>');
  assert.equal(result.forSale, false);
  assert.equal(result.reason, 'registration_parking');
});
test('an unrelated product redirect and Buy now button are not domain-sale evidence', () => {
  assert.equal(check('<title>Garden supplies</title><h1>Seeds for sale</h1><p>Buy now $995</p>', { finalUrl: 'https://garden.example/' }).forSale, false);
});
test('marketplace mentions and adverts alone do not establish a listing', () => {
  assert.equal(check('<title>orchardledger.com</title><p>Read about Sedo.com and Afternic. Buy now!</p>').forSale, false);
  assert.equal(check('<title>other.com</title><h1>other.com is for sale</h1>').forSale, false);
});
test('an explicit subject-domain sale statement survives www redirects', () => {
  assert.equal(check('<h1>orchardledger.com</h1><p>Domain for sale</p><button>Buy now</button>').forSale, true);
  assert.equal(check('<p>orchardledger.com is available for sale</p>').forSale, true);
  assert.equal(check('<title>orchardledger.com</title><p>Buy this domain name</p>').forSale, true);
});
test('an HTTP challenge must not become a listing even when it echoes sale text', () => {
  assert.equal(check('<h1>orchardledger.com</h1><p>Domain for sale</p>', { status: 403 }).forSale, false);
});
