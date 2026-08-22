'use strict';

const QUALITY_MINIMUMS = Object.freeze({
  naturalness: 7,
  clarity: 7,
  memorability: 6,
  commercial_breadth: 6,
  morphology: 7,
  ambiguity_max: 2,
  confidence: 0.75,
  overall: 72,
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function applyNameQualityGate(candidate) {
  const quality = candidate?.name_quality || {};
  const required = ['naturalness', 'clarity', 'memorability', 'commercial_breadth', 'morphology', 'ambiguity', 'confidence'];
  const missing = required.filter(field => finite(quality[field]) == null);
  if (missing.length) {
    return { passed: false, overall: 0, reasons: [`missing independent quality fields: ${missing.join(', ')}`] };
  }

  const naturalness = clamp(finite(quality.naturalness), 0, 10);
  const clarity = clamp(finite(quality.clarity), 0, 10);
  const memorability = clamp(finite(quality.memorability), 0, 10);
  const commercialBreadth = clamp(finite(quality.commercial_breadth), 0, 10);
  const morphology = clamp(finite(quality.morphology), 0, 10);
  const ambiguity = clamp(finite(quality.ambiguity), 0, 10);
  const confidence = clamp(finite(quality.confidence), 0, 1);
  const overall = Number(((
    naturalness * 0.24
    + clarity * 0.24
    + memorability * 0.18
    + commercialBreadth * 0.17
    + morphology * 0.17
  ) * 10).toFixed(2));

  const reasons = [];
  if (naturalness < QUALITY_MINIMUMS.naturalness) reasons.push('awkward or unnatural phrase');
  if (clarity < QUALITY_MINIMUMS.clarity) reasons.push('meaning is not immediately clear');
  if (memorability < QUALITY_MINIMUMS.memorability) reasons.push('insufficient memorability');
  if (commercialBreadth < QUALITY_MINIMUMS.commercial_breadth) reasons.push('commercial use is too narrow');
  if (morphology < QUALITY_MINIMUMS.morphology) reasons.push('weak word construction');
  if (ambiguity > QUALITY_MINIMUMS.ambiguity_max) reasons.push('material ambiguity or negative reading');
  if (confidence < QUALITY_MINIMUMS.confidence) reasons.push('quality assessment confidence too low');
  if (overall < QUALITY_MINIMUMS.overall) reasons.push(`overall quality ${overall} is below ${QUALITY_MINIMUMS.overall}`);

  return { passed: reasons.length === 0, overall, reasons };
}

function priceValueScore(priceUsd) {
  const price = finite(priceUsd);
  if (price == null || price <= 0) return null;
  return clamp(100 - (18 * Math.log2(price / 1000)), 0, 100);
}

function rankMarketOpportunities(candidates) {
  return (Array.isArray(candidates) ? candidates : []).flatMap(candidate => {
    const gate = applyNameQualityGate(candidate);
    const priceScore = priceValueScore(candidate?.price_usd);
    const trendFit = finite(candidate?.trend_fit);
    if (!gate.passed || priceScore == null || trendFit == null) return [];
    const boundedTrend = clamp(trendFit, 0, 100);
    const valueScore = gate.overall * 0.45 + boundedTrend * 0.30 + priceScore * 0.25;
    return [{
      ...candidate,
      name_quality_score: gate.overall,
      price_value_score: Number(priceScore.toFixed(2)),
      opportunity_score: Number(valueScore.toFixed(2)),
    }];
  }).sort((a, b) => b.opportunity_score - a.opportunity_score || a.price_usd - b.price_usd);
}

module.exports = {
  QUALITY_MINIMUMS,
  applyNameQualityGate,
  priceValueScore,
  rankMarketOpportunities,
};
