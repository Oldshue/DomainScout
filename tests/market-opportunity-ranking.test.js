'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyNameQualityGate,
  applyBuyerSubstituteGate,
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

function strongSubstitute(overrides = {}) {
  return {
    domain: 'CategoryLeader.com',
    price_usd: 30000,
    buyer_preference: 'candidate',
    retail_ceiling_usd: 20000,
    substitution_strength: 0.9,
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
    { domain: 'SwiftShare.com', price_usd: 5000, trend_fit: 84, name_quality: strongQuality(), substitute_analysis: strongSubstitute({ retail_ceiling_usd: 60000 }) },
    { domain: 'ClearHarbor.com', price_usd: 1800, trend_fit: 84, name_quality: strongQuality(), substitute_analysis: strongSubstitute({ retail_ceiling_usd: 60000 }) },
  ];
  assert.deepEqual(rankMarketOpportunities(candidates).map(row => row.domain), ['ClearHarbor.com', 'SwiftShare.com']);
});

test('the gate and value ranking are not tied to the motivating technology theme', () => {
  const climateCommerce = {
    domain: 'GardenLoom.com',
    price_usd: 1400,
    trend_fit: 79,
    name_quality: strongQuality({ commercial_breadth: 7 }),
    substitute_analysis: strongSubstitute({ domain: 'ClimateGarden.com', price_usd: 40000, retail_ceiling_usd: 25000 }),
  };
  const [ranked] = rankMarketOpportunities([climateCommerce]);
  assert.equal(ranked.domain, 'GardenLoom.com');
  assert.ok(ranked.opportunity_score > 0);
});

test('a preferred buyer substitute caps resale upside and rejects the opportunity', () => {
  const agentBalance = {
    domain: 'AgentBalance.com', price_usd: 997, trend_fit: 92, name_quality: strongQuality(),
    substitute_analysis: strongSubstitute({
      domain: 'AgentCredit.com', price_usd: 8999, buyer_preference: 'substitute',
      retail_ceiling_usd: 8000, substitution_strength: 0.9,
    }),
  };
  const gate = applyBuyerSubstituteGate(agentBalance);
  assert.equal(gate.passed, false);
  assert.equal(gate.upside_multiple, 8.02);
  assert.match(gate.reasons.join(' '), /10x is required/);
  assert.deepEqual(rankMarketOpportunities([agentBalance]), []);
});

test('a category-grade name survives when the substitute ceiling leaves asymmetric upside', () => {
  const machineTreasury = {
    domain: 'MachineTreasury.com', price_usd: 199, trend_fit: 90, name_quality: strongQuality(),
    substitute_analysis: strongSubstitute({
      domain: 'AgentWallet.com', price_usd: 300000, buyer_preference: 'candidate',
      retail_ceiling_usd: 100000, substitution_strength: 0.8,
    }),
  };
  const [ranked] = rankMarketOpportunities([machineTreasury]);
  assert.equal(ranked.buyer_substitute_domain, 'AgentWallet.com');
  assert.equal(ranked.upside_multiple, 502.51);
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
      substitute_analysis: strongSubstitute(),
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
      substitute_analysis: strongSubstitute({ domain: 'LabExchange.com', price_usd: 45000, retail_ceiling_usd: 30000 }),
    }],
  });
  assert.equal(result.provenance.passed, true);
  assert.deepEqual(result.candidates.map(row => row.domain), ['LabHarbor.com']);
});
