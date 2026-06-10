function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function baseNameFromDomain(domain) {
  const d = String(domain || '').toLowerCase();
  const dot = d.lastIndexOf('.');
  return dot > 0 ? d.slice(0, dot) : d;
}

function lengthScore(length) {
  if (length <= 0) return 0;
  if (length <= 3) return 170;
  if (length === 4) return 150;
  if (length === 5) return 130;
  if (length === 6) return 110;
  if (length <= 8) return 85;
  if (length <= 10) return 60;
  if (length <= 12) return 35;
  return Math.max(0, 25 - ((length - 12) * 5));
}

function tldPriorityScore(tld) {
  return {
    '.com': 120,
    '.ai': 95,
    '.sh': 80,
    '.io': 75,
    '.net': 55,
    '.org': 50,
    '.bot': 45,
    '.dev': 45,
    '.app': 40,
    '.co': 35,
  }[String(tld || '').toLowerCase()] || 20;
}

function isAvailability(value, target) {
  return value === target || value === String(target);
}

function computeDomainQuality(domain) {
  const base = String(domain.base_name || baseNameFromDomain(domain.domain));
  const length = numberOrZero(domain.length || base.length);
  const tldsTaken = numberOrZero(domain.tlds_taken);
  const ageYears = numberOrZero(domain.age_years);
  const wayback = numberOrZero(domain.wayback_snapshots);
  const hasNumbers = Number(domain.has_numbers || /[0-9]/.test(base)) ? 1 : 0;
  const hasHyphens = Number(domain.has_hyphens || base.includes('-')) ? 1 : 0;

  if (isAvailability(domain.registration_available, 0)) {
    return {
      quality_score: 0,
      quality_reasons: 'confirmed unavailable',
    };
  }

  let score = 0;
  const reasons = [];

  score += lengthScore(length);
  if (length > 0) reasons.push(`${length} chars`);

  const tldScore = tldPriorityScore(domain.tld);
  score += tldScore;
  if (domain.tld) reasons.push(`${domain.tld} priority`);

  if (!hasNumbers) {
    score += 45;
  } else {
    score -= 35;
    reasons.push('has number');
  }
  if (!hasHyphens) {
    score += 40;
  } else {
    score -= 30;
    reasons.push('has hyphen');
  }
  if (!hasNumbers && !hasHyphens) reasons.push('clean');

  if (tldsTaken > 0) {
    score += Math.min(260, Math.round(Math.log2(tldsTaken + 1) * 38));
    reasons.push(`${tldsTaken} TLDs taken`);
  }

  if (ageYears > 0) {
    score += Math.min(110, Math.round(ageYears * 6));
    reasons.push(`${ageYears}y old`);
  }

  if (wayback > 0) {
    score += Math.min(120, Math.round(Math.log10(wayback + 1) * 60));
    reasons.push(`${wayback} Wayback`);
  }

  if (isAvailability(domain.registration_available, 1)) {
    score += 70;
    reasons.unshift('confirmed available');
  }

  const source = String(domain.availability_source || '');
  if (/^(whois|rdap)\+dns$/.test(source)) {
    score += 25;
    reasons.push(source);
  }

  if (length >= 14) score -= Math.min(80, (length - 13) * 8);

  return {
    quality_score: Math.max(0, Math.round(score)),
    quality_reasons: reasons.slice(0, 8).join('; '),
  };
}

module.exports = {
  computeDomainQuality,
};
