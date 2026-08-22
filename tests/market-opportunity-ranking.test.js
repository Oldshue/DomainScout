'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyNameQualityGate, rankMarketOpportunities } = require('../server/market-opportunity-ranking');

function strongQuality(overrides = {}) {
  return {
    naturalness: 9,
    clarity: 9,
    memorability: 8,
    commercial_breadth: 8,
    morphology: 9,
    ambiguity: 1,
    confidence: 0.9,
    ...overrides,
  };
}

test('an awkward ambiguous name is rejected before trend or price can rank it', () => {
  const riskStat = {
    domain: 'RiskStat.com',
    price_usd: 50,
    trend_fit: 100,
    name_quality: strongQuality({ naturalness: 4, clarity: 4, morphology: 5, ambiguity: 5 }),
  };
  assert.equal(applyNameQualityGate(riskStat).passed, false);
  assert.deepEqual(rankMarketOpportunities([riskStat]), []);
});

test('price materially changes the order after equally strong names pass quality', () => {
  const candidates = [
    { domain: 'SwiftShare.com', price_usd: 5000, trend_fit: 84, name_quality: strongQuality() },
    { domain: 'ClearHarbor.com', price_usd: 1800, trend_fit: 84, name_quality: strongQuality() },
  ];
  assert.deepEqual(rankMarketOpportunities(candidates).map(row => row.domain), ['ClearHarbor.com', 'SwiftShare.com']);
});

test('the gate and value ranking are not tied to the motivating technology theme', () => {
  const climateCommerce = {
    domain: 'GardenLoom.com',
    price_usd: 1400,
    trend_fit: 79,
    name_quality: strongQuality({ commercial_breadth: 7 }),
  };
  const [ranked] = rankMarketOpportunities([climateCommerce]);
  assert.equal(ranked.domain, 'GardenLoom.com');
  assert.ok(ranked.opportunity_score > 0);
});
