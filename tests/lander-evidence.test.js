'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLanderEvidence } = require('../server/lander-evidence');

test('an ordinary cross-host product redirect is not a sale listing', () => {
  const result = classifyLanderEvidence({
    originalHost: 'weatherloom.dev',
    finalUrl: 'https://weatherloom.com/products/developer',
    body: '<html><title>WeatherLoom developer tools</title></html>',
  });
  assert.equal(result.wasRedirected, true);
  assert.equal(result.isForSale, false);
  assert.equal(result.platform, null);
});

test('a redirect to a known marketplace is affirmative sale evidence', () => {
  const result = classifyLanderEvidence({
    originalHost: 'weatherloom.dev',
    finalUrl: 'https://www.afternic.com/domain/weatherloom.dev',
    body: '<html></html>',
  });
  assert.equal(result.isForSale, true);
  assert.equal(result.platform, 'Afternic');
});

test('an unknown lander requires explicit sale language', () => {
  const result = classifyLanderEvidence({
    originalHost: 'weatherloom.dev',
    finalUrl: 'https://names.example/listing/weatherloom',
    body: '<html>WeatherLoom.dev is for sale. Make an offer.</html>',
  });
  assert.equal(result.isForSale, true);
  assert.equal(result.platform, 'names.example');
});
