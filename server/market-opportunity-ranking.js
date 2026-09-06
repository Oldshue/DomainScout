'use strict';

const QUALITY_MINIMUMS = Object.freeze({
  naturalness: 8,
  clarity: 6,
  memorability: 7,
  commercial_breadth: 7,
  morphology: 8,
  spoken_brandability: 7,
  emotional_resonance: 6,
  distinctiveness: 7,
  premium_lexical_strength: 8,
  founder_choice: 8,
  strategic_retention: 8,
  five_figure_conviction: 8,
  obvious_better_alternatives_max: 1,
  ambiguity_max: 2,
  confidence: 0.8,
  overall: 76,
});

const SUBSTITUTE_MINIMUMS = Object.freeze({
  confidence: 0.75,
  substitution_strength: 0.6,
  upside_multiple: 10,
});

function finite(value) {
  if(value==null || value==='')return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function applyNameQualityGate(candidate) {
  const quality = candidate?.name_quality || {};
  const required = ['naturalness', 'clarity', 'memorability', 'commercial_breadth', 'morphology',
    'spoken_brandability', 'emotional_resonance', 'distinctiveness', 'premium_lexical_strength',
    'founder_choice', 'strategic_retention', 'five_figure_conviction', 'obvious_better_alternatives',
    'ambiguity', 'confidence'];
  const missing = required.filter(field => finite(quality[field]) == null);
  if (missing.length) {
    return { passed: false, overall: 0, reasons: [`missing independent quality fields: ${missing.join(', ')}`] };
  }

  const naturalness = clamp(finite(quality.naturalness), 0, 10);
  const clarity = clamp(finite(quality.clarity), 0, 10);
  const memorability = clamp(finite(quality.memorability), 0, 10);
  const commercialBreadth = clamp(finite(quality.commercial_breadth), 0, 10);
  const morphology = clamp(finite(quality.morphology), 0, 10);
  const spokenBrandability = clamp(finite(quality.spoken_brandability), 0, 10);
  const emotionalResonance = clamp(finite(quality.emotional_resonance), 0, 10);
  const distinctiveness = clamp(finite(quality.distinctiveness), 0, 10);
  const premiumLexicalStrength = clamp(finite(quality.premium_lexical_strength), 0, 10);
  const founderChoice = clamp(finite(quality.founder_choice), 0, 10);
  const strategicRetention = clamp(finite(quality.strategic_retention), 0, 10);
  const fiveFigureConviction = clamp(finite(quality.five_figure_conviction), 0, 10);
  const obviousBetterAlternatives = clamp(finite(quality.obvious_better_alternatives), 0, 10);
  const ambiguity = clamp(finite(quality.ambiguity), 0, 10);
  const confidence = clamp(finite(quality.confidence), 0, 1);
  const overall = Number(((
    naturalness * 0.10
    + clarity * 0.05
    + memorability * 0.10
    + commercialBreadth * 0.08
    + morphology * 0.08
    + spokenBrandability * 0.08
    + emotionalResonance * 0.05
    + distinctiveness * 0.08
    + premiumLexicalStrength * 0.12
    + founderChoice * 0.10
    + strategicRetention * 0.08
    + fiveFigureConviction * 0.08
  ) * 10).toFixed(2));

  const reasons = [];
  if (naturalness < QUALITY_MINIMUMS.naturalness) reasons.push('awkward or unnatural phrase');
  if (clarity < QUALITY_MINIMUMS.clarity) reasons.push('meaning is not immediately clear');
  if (memorability < QUALITY_MINIMUMS.memorability) reasons.push('insufficient memorability');
  if (commercialBreadth < QUALITY_MINIMUMS.commercial_breadth) reasons.push('commercial use is too narrow');
  if (morphology < QUALITY_MINIMUMS.morphology) reasons.push('weak word construction');
  if (spokenBrandability < QUALITY_MINIMUMS.spoken_brandability) reasons.push('does not sound like a credible spoken company brand');
  if (emotionalResonance < QUALITY_MINIMUMS.emotional_resonance) reasons.push('lacks an appealing or reassuring emotional signal');
  if (distinctiveness < QUALITY_MINIMUMS.distinctiveness) reasons.push('too generic or functional to be a memorable company name');
  if (premiumLexicalStrength < QUALITY_MINIMUMS.premium_lexical_strength) reasons.push('lacks scarce premium lexical quality');
  if (founderChoice < QUALITY_MINIMUMS.founder_choice) reasons.push('a serious founder would choose an obvious stronger name');
  if (strategicRetention < QUALITY_MINIMUMS.strategic_retention) reasons.push('a strategic acquirer would likely replace the brand');
  if (fiveFigureConviction < QUALITY_MINIMUMS.five_figure_conviction) reasons.push('does not remain compelling at a five-figure ask');
  if (obviousBetterAlternatives > QUALITY_MINIMUMS.obvious_better_alternatives_max) reasons.push('too many obvious better naming alternatives');
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

function applyAcquisitionBudgetGate(candidate) {
  const price = finite(candidate?.price_usd);
  const maximum = finite(candidate?.max_acquisition_price_usd);
  const reasons = [];
  if (price == null || price <= 0) reasons.push('candidate price is required');
  if (maximum != null && maximum <= 0) reasons.push('maximum acquisition price must be positive');
  if (price != null && maximum != null && price > maximum) {
    reasons.push(`asking price $${price} exceeds the $${maximum} acquisition ceiling`);
  }
  return { passed: reasons.length === 0, reasons, price_usd: price, maximum_price_usd: maximum };
}

// Turn observed registrations into a marketplace-blind exact-base upgrade
// channel. Editorial and market gates run later; this function only guarantees
// that a newly observed brand in another extension causes its .com to be
// considered without inventing keyword combinations.
function buildExactBaseUpgradeTargets(observations, options = {}) {
  const targetTlds = [...new Set((options.target_tlds || [options.target_tld || 'com'])
    .map(value => String(value).replace(/^\./, '').toLowerCase()).filter(Boolean))];
  const allowedSourceTlds = new Set((options.source_tlds || []).map(value => String(value).replace(/^\./, '').toLowerCase()));
  const seen = new Set();
  return (Array.isArray(observations) ? observations : []).flatMap(observation => {
    const sourceDomain = String(observation?.domain || '').trim().toLowerCase().replace(/\.$/, '');
    const labels = sourceDomain.split('.');
    if (labels.length !== 2 || !labels[0] || !labels[1] || ['xyz','shop','info'].includes(labels[1])) return [];
    if (allowedSourceTlds.size && !allowedSourceTlds.has(labels[1])) return [];
    return targetTlds.flatMap(targetTld => {
      if (labels[1] === targetTld || ['xyz','shop','info'].includes(targetTld)) return [];
      const targetDomain = `${labels[0]}.${targetTld}`;
      if (seen.has(targetDomain)) return [];
      seen.add(targetDomain);
      return [{domain:targetDomain,source_registration:sourceDomain,source_observed_at:observation.observed_at||observation.date||null,thesis_id:observation.thesis_id||null,discovery_channel:'exact-base-upgrade'}];
    });
  });
}

// A cheap acquisition is not an asymmetric opportunity when the same buyer can
// purchase a preferred substitute before reaching the candidate's intended
// retail price. Require an explicit, conservative buyer-alternative ceiling.
// This contract is theme-neutral and works for any registration-led naming
// market rather than encoding a particular technology vocabulary.
function applyBuyerSubstituteGate(candidate) {
  const analysis = candidate?.substitute_analysis || {};
  const candidatePrice = finite(candidate?.price_usd);
  const substitutePrice = finite(analysis.price_usd);
  const retailCeiling = finite(analysis.retail_ceiling_usd);
  const confidence = finite(analysis.confidence);
  const substitutionStrength = finite(analysis.substitution_strength);
  const preference = String(analysis.buyer_preference || '').toLowerCase();
  const substituteDomain = String(analysis.domain || '').trim();
  const reasons = [];

  if (!substituteDomain) reasons.push('best buyer substitute domain is required');
  if (candidatePrice == null || candidatePrice <= 0) reasons.push('candidate price is required');
  if (substitutePrice == null || substitutePrice <= 0) reasons.push('best buyer substitute price is required');
  if (retailCeiling == null || retailCeiling <= 0) reasons.push('conservative retail ceiling is required');
  if (!['candidate', 'substitute', 'equivalent'].includes(preference)) reasons.push('buyer preference must be candidate, substitute, or equivalent');
  if (confidence == null || confidence < SUBSTITUTE_MINIMUMS.confidence) reasons.push('substitute assessment confidence is too low');
  if (substitutionStrength == null || substitutionStrength < SUBSTITUTE_MINIMUMS.substitution_strength) reasons.push('alternative is not a strong enough buyer substitute');

  if (retailCeiling != null && substitutePrice != null && ['substitute', 'equivalent'].includes(preference)
      && retailCeiling > substitutePrice) {
    reasons.push('retail ceiling exceeds the ask for an equal or preferred buyer substitute');
  }

  const upsideMultiple = candidatePrice > 0 && retailCeiling > 0 ? retailCeiling / candidatePrice : null;
  if (upsideMultiple != null && upsideMultiple < SUBSTITUTE_MINIMUMS.upside_multiple) {
    reasons.push(`buyer-substitute ceiling leaves only ${upsideMultiple.toFixed(2)}x upside; ${SUBSTITUTE_MINIMUMS.upside_multiple}x is required`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    substitute_domain: substituteDomain || null,
    substitute_price_usd: substitutePrice,
    retail_ceiling_usd: retailCeiling,
    upside_multiple: upsideMultiple == null ? null : Number(upsideMultiple.toFixed(2)),
  };
}

function upsideMultipleScore(multiple) {
  const value = finite(multiple);
  if (value == null || value <= 0) return null;
  return clamp(25 * Math.log2(value / 2), 0, 100);
}

function applyAdoptionEvidenceGate(candidate, now=Date.now()) {
  const sources=Array.isArray(candidate?.adoption_evidence)?candidate.adoption_evidence:[];
  const eligible=sources.filter(source=>{const age=now-Date.parse(source.published_at);try{return source.kind==='primary' && source.scope==='category' && typeof source.summary==='string' && source.summary.trim().length>=20 && /^https?:$/.test(new URL(source.url).protocol) && Number.isFinite(age) && age>=0 && age<=180*86400000;}catch{return false;}});
  const publishers=new Set(eligible.map(source=>new URL(source.url).hostname.replace(/^www\./,'').split('.').slice(-2).join('.')));
  const reasons=[];if(publishers.size<2)reasons.push('Two independent dated primary category sources within 180 days are required');
  if(candidate?.accelerating && !eligible.some(source=>now-Date.parse(source.published_at)<=90*86400000))reasons.push('Acceleration requires a primary source within 90 days');
  return {passed:reasons.length===0,reasons,eligibleSources:eligible.length,publishers:publishers.size,verification:'Researcher-supplied source evidence; not independent page verification'};
}

function applyEconomicsEvidenceGate(candidate,now=Date.now()) {
  const e=candidate?.economics||{},quote=candidate?.quote||{},reasons=[];
  const price=finite(candidate?.price_usd),renewal=finite(e.annual_renewal_usd),fee=finite(e.selling_fee_fraction),probability=finite(e.five_year_sale_probability),sale=finite(e.sale_price_usd);
  const quoteAge=now-Date.parse(quote.checked_at);
  if(!['available','listed'].includes(quote.status)||!String(quote.provider||'').trim()||!candidate?.domain||String(quote.domain||'').toLowerCase()!==String(candidate.domain).toLowerCase()||!Number.isFinite(quoteAge)||quoteAge<0||quoteAge>86400000||finite(quote.price_usd)!==price)reasons.push('A matching registrar or marketplace quote within 24 hours is required');
  if(renewal==null||renewal<0||fee==null||fee<0||fee>=1||probability==null||probability<=0||probability>=1||sale==null||sale<=0||!e.assumptions)reasons.push('Explicit five-year resale, probability, fee and renewal assumptions are required');
  const cost=price==null||renewal==null?NaN:price+4*renewal,proceeds=probability*sale*(1-fee),profit=proceeds-cost;
  if(!Number.isFinite(profit)||profit<=0)reasons.push('The stated five-year assumptions do not produce a positive expected profit');
  return {passed:reasons.length===0,reasons,total_cash_cost_usd:cost,expected_net_proceeds_usd:proceeds,expected_profit_usd:profit,expected_multiple:cost>0?proceeds/cost:null,interpretation:'Conditional on supplied assumptions; not an empirical sale forecast'};
}

function applyRegistrationEvidenceGate(candidate) {
  const evidence=candidate?.registration_evidence;
  const reasons=[];
  if(evidence?.version!==1)reasons.push('Measured naming-pattern evidence is required');
  if(!evidence?.registrationReview?.passed)reasons.push(...(evidence?.registrationReview?.reasons||['Registration pattern has not cleared research review']));
  if(!Array.isArray(evidence?.excludedSuffixes)||!evidence.excludedSuffixes.includes('xyz'))reasons.push('Evidence must exclude xyz');
  if(!(finite(evidence?.weightedCurrentLabels??evidence?.currentLabels)>=3) || !(finite(evidence?.weightedDistinctLabels??evidence?.distinctLabels)>=10) || !(finite(evidence?.activeDays)>=3))reasons.push('A one-off cross-extension match cannot justify acquisition');
  const domain=String(candidate?.domain||'').trim().toLowerCase();
  if(!evidence?.token || !domain.split('.')[0].includes(evidence.token) || ['xyz','shop','info'].includes(domain.split('.').pop()))reasons.push('Candidate must preserve the researched vocabulary in an eligible extension');
  return {passed:reasons.length===0,reasons};
}

function rankMarketOpportunities(candidates) {
  return (Array.isArray(candidates) ? candidates : []).flatMap(candidate => {
    const evidenceGate = applyRegistrationEvidenceGate(candidate);
    const adoptionGate=applyAdoptionEvidenceGate(candidate),economicsGate=applyEconomicsEvidenceGate(candidate);
    const gate = applyNameQualityGate(candidate);
    const budgetGate = applyAcquisitionBudgetGate(candidate);
    const substituteGate = applyBuyerSubstituteGate(candidate);
    const priceScore = priceValueScore(candidate?.price_usd);
    const measured=candidate.registration_evidence||{};
    const trendFit=Math.min(100,40*Math.min(1,(measured.activeDays||0)/7)+30*Math.min(1,(measured.weightedCurrentLabels??measured.currentLabels??0)/20)+30*Math.min(1,(measured.weightedDistinctLabels??measured.distinctLabels??0)/100));
    const upsideScore = upsideMultipleScore(substituteGate.upside_multiple);
    if (!adoptionGate.passed || !economicsGate.passed || !evidenceGate.passed || !gate.passed || !budgetGate.passed || !substituteGate.passed || priceScore == null || trendFit == null || upsideScore == null) return [];
    const boundedTrend = clamp(trendFit, 0, 100);
    const valueScore = gate.overall * 0.35 + boundedTrend * 0.25 + priceScore * 0.15 + upsideScore * 0.25;
    return [{
      ...candidate,
      underwriting:economicsGate,
      name_quality_score: gate.overall,
      price_value_score: Number(priceScore.toFixed(2)),
      buyer_substitute_ceiling_usd: substituteGate.retail_ceiling_usd,
      buyer_substitute_domain: substituteGate.substitute_domain,
      upside_multiple: substituteGate.upside_multiple,
      upside_multiple_score: Number(upsideScore.toFixed(2)),
      opportunity_score: Number(valueScore.toFixed(2)),
    }];
  }).sort((a, b) => b.underwriting.expected_multiple-a.underwriting.expected_multiple || b.underwriting.expected_profit_usd-a.underwriting.expected_profit_usd || b.opportunity_score-a.opportunity_score);
}

function timestamp(value) {
  const time = new Date(value || '').getTime();
  return Number.isFinite(time) ? time : null;
}

// Fail closed when a recommendation packet cannot prove that research produced
// its theses and target universe before marketplace inventory or price was seen.
// This contract is domain-neutral: the same chronology works for naming signals
// drawn from climate, biotech, consumer, or any other market corpus.
function validateThesisFirstPacket(packet) {
  const errors = [];
  const researchObservedAt = timestamp(packet?.research_observed_at);
  const thesesFrozenAt = timestamp(packet?.theses_frozen_at);
  const targetsFrozenAt = timestamp(packet?.targets_frozen_at);
  const quotesStartedAt = timestamp(packet?.quotes_started_at);
  if (researchObservedAt == null) errors.push('research_observed_at is required');
  if (thesesFrozenAt == null) errors.push('theses_frozen_at is required');
  if (targetsFrozenAt == null) errors.push('targets_frozen_at is required');
  if (quotesStartedAt == null) errors.push('quotes_started_at is required');
  if (researchObservedAt != null && thesesFrozenAt != null && researchObservedAt > thesesFrozenAt) {
    errors.push('theses were frozen before the research observation completed');
  }
  if (thesesFrozenAt != null && targetsFrozenAt != null && thesesFrozenAt > targetsFrozenAt) {
    errors.push('targets were frozen before the theses');
  }
  if (targetsFrozenAt != null && quotesStartedAt != null && targetsFrozenAt > quotesStartedAt) {
    errors.push('marketplace quoting began before targets were frozen');
  }

  const theses = packet?.theses && typeof packet.theses === 'object' ? packet.theses : {};
  const frozenTargets = new Set((Array.isArray(packet?.frozen_targets) ? packet.frozen_targets : [])
    .map(value => String(value || '').toLowerCase().trim())
    .filter(Boolean));
  if (!Object.keys(theses).length) errors.push('at least one frozen thesis is required');
  if (!frozenTargets.size) errors.push('at least one frozen target is required');

  for (const candidate of Array.isArray(packet?.candidates) ? packet.candidates : []) {
    const domain = String(candidate?.domain || '').toLowerCase().trim();
    if (!frozenTargets.has(domain)) errors.push(`${domain || 'candidate'} was not in the frozen target set`);
    if (!candidate?.thesis_id || !Object.hasOwn(theses, candidate.thesis_id)) {
      errors.push(`${domain || 'candidate'} does not reference a frozen thesis`);
    }
    const observedAt = timestamp(candidate?.observed_at);
    if (observedAt == null) errors.push(`${domain || 'candidate'} is missing quote observed_at`);
    else if (targetsFrozenAt != null && observedAt < targetsFrozenAt) {
      errors.push(`${domain || 'candidate'} was quoted before targets were frozen`);
    }
  }

  return { passed: errors.length === 0, errors };
}

function rankThesisFirstMarketOpportunities(packet) {
  const provenance = validateThesisFirstPacket(packet);
  if (!provenance.passed) return { provenance, candidates: [] };
  return { provenance, candidates: rankMarketOpportunities(packet.candidates) };
}

module.exports = {
  QUALITY_MINIMUMS,
  SUBSTITUTE_MINIMUMS,
  applyNameQualityGate,
  applyRegistrationEvidenceGate,
  applyAdoptionEvidenceGate,
  applyEconomicsEvidenceGate,
  applyAcquisitionBudgetGate,
  buildExactBaseUpgradeTargets,
  applyBuyerSubstituteGate,
  priceValueScore,
  upsideMultipleScore,
  rankMarketOpportunities,
  validateThesisFirstPacket,
  rankThesisFirstMarketOpportunities,
};
