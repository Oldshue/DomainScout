'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyNameQualityGate,
  rankMarketOpportunities,
  rankThesisFirstMarketOpportunities,
} = require('../server/market-opportunity-ranking');

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

test('marketplace inventory cannot introduce a candidate after targets are frozen', () => {
  const result = rankThesisFirstMarketOpportunities({
    research_observed_at: '2026-04-01T10:00:00Z',
    theses_frozen_at: '2026-04-01T10:05:00Z',
    targets_frozen_at: '2026-04-01T10:10:00Z',
    quotes_started_at: '2026-04-01T10:11:00Z',
    theses: { resilient_gardens: { summary: 'weather-adaptive home growing' } },
    frozen_targets: ['WeatherGarden.com'],
    candidates: [{
      domain: 'CheapClimateName.com', thesis_id: 'resilient_gardens',
      observed_at: '2026-04-01T10:12:00Z', price_usd: 50, trend_fit: 100,
      name_quality: strongQuality(),
    }],
  });
  assert.equal(result.provenance.passed, false);
  assert.deepEqual(result.candidates, []);
  assert.match(result.provenance.errors.join(' '), /not in the frozen target set/);
});

test('an unrelated thesis-first packet ranks only after chronology is proven', () => {
  const result = rankThesisFirstMarketOpportunities({
    research_observed_at: '2026-05-02T09:00:00Z',
    theses_frozen_at: '2026-05-02T09:05:00Z',
    targets_frozen_at: '2026-05-02T09:08:00Z',
    quotes_started_at: '2026-05-02T09:10:00Z',
    theses: { lab_automation: { summary: 'automated wet-lab operations' } },
    frozen_targets: ['LabHarbor.com'],
    candidates: [{
      domain: 'LabHarbor.com', thesis_id: 'lab_automation',
      observed_at: '2026-05-02T09:11:00Z', price_usd: 1800, trend_fit: 82,
      name_quality: strongQuality(),
    }],
  });
  assert.equal(result.provenance.passed, true);
  assert.deepEqual(result.candidates.map(row => row.domain), ['LabHarbor.com']);
});
