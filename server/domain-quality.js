const { loadDictionary, segmentBaseName } = require('./domainlab');
const { signalWeight } = require('./domain-signal-policy');

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

  // Pronounceability — random strings ("s1cj65kstga8jfmclopi8sei7b", "xqzjkdfg")
  // must never rank as "best quality". Penalize low vowel ratio and long
  // consonant runs (y counts as a vowel so real words like "crypto" pass).
  const letters = base.replace(/[^a-z]/g, '');
  if (letters.length >= 4) {
    const vowels = (letters.match(/[aeiouy]/g) || []).length;
    const vowelRatio = vowels / letters.length;
    let maxRun = 0, run = 0;
    for (const ch of letters) {
      if ('aeiouy'.includes(ch)) { run = 0; } else { run += 1; if (run > maxRun) maxRun = run; }
    }
    let gibberish = 0;
    if (vowelRatio < 0.18) gibberish += 120; else if (vowelRatio < 0.27) gibberish += 45;
    if (maxRun >= 6) gibberish += 120; else if (maxRun >= 5) gibberish += 45;
    if (gibberish > 0) {
      score -= Math.min(220, gibberish);
      reasons.push('low readability');
    }
  }

  return {
    quality_score: Math.max(0, Math.round(score)),
    quality_reasons: reasons.slice(0, 8).join('; '),
  };
}

module.exports = {
  computeDomainQuality,
};

// ── Alpha Name Tier ─────────────────────────────────────────────────────────
// One shared, deterministic answer to "is this a name a serious end-user
// would pay for?" so Sale Watch and every board can show alpha names only.
// Builds on domainlab's dictionary segmentation; no new dependency.
const ALPHA_TLDS = Object.freeze([
  'com', 'net', 'org', 'io', 'ai', 'co', 'app', 'dev', 'me', 'us', 'uk',
  'co.uk', 'de', 'fr', 'es', 'it', 'nl', 'ca', 'au', 'com.au', 'eu', 'ch',
  'se', 'no', 'dk', 'fi', 'be', 'at', 'nz', 'ie', 'pt', 'br', 'com.br',
  'mx', 'pl', 'in', 'jp', 'kr', 'sg', 'hk',
]);
const ALPHA_TLD_SET = new Set(ALPHA_TLDS);

// Worked examples fix this boundary: aiphotorestoration.com (18 letters)
// must reach the word-form check ('three or more words'), while
// dallascleaningservices.com (22 letters) must fail on length alone.
const ALPHA_LABEL_MAX_LENGTH = 20;
const ALPHA_LABEL_MIN_LENGTH = 3;
const CONSONANT_RUN_RE = /[^aeiouy]{4,}/;
const VOWEL_RE = /[aeiouy]/;

function splitLabelAndTld(domain) {
  const full = String(domain || '').toLowerCase();
  const dot = full.indexOf('.');
  if (dot < 0) return { label: full, tld: '' };
  return { label: full.slice(0, dot), tld: full.slice(dot + 1) };
}

function isAlphaDictionaryForm(words) {
  if (!words.length || words.length > 2) return false;
  const dict = loadDictionary();
  return words.every((w) => w.length >= 3 && dict.has(w));
}

function isAlphaBrandableForm(label) {
  if (label.length > 8) return false;
  if (!VOWEL_RE.test(label)) return false;
  if (CONSONANT_RUN_RE.test(label)) return false;
  return true;
}

function assessNameAlpha(domain) {
  const { label, tld } = splitLabelAndTld(domain);
  const result = { domain: String(domain || ''), label, tld, words: [] };

  if (!/^[a-z]+$/.test(label)) {
    return { ...result, tier: 'weak', reasons: ['non-alpha characters'] };
  }

  if (label.length < ALPHA_LABEL_MIN_LENGTH || label.length > ALPHA_LABEL_MAX_LENGTH) {
    return { ...result, tier: 'weak', reasons: ['length'] };
  }

  if (signalWeight(tld) === 0) {
    return { ...result, tier: 'weak', reasons: ['zero-signal tld'] };
  }

  const reasons = [];
  const tldInAlpha = ALPHA_TLD_SET.has(tld);
  if (!tldInAlpha) reasons.push('tld not in alpha tier');

  const words = segmentBaseName(label);
  const dictionaryForm = isAlphaDictionaryForm(words);
  const brandableForm = isAlphaBrandableForm(label);
  const qualifies = dictionaryForm || brandableForm;

  if (qualifies) {
    reasons.push(dictionaryForm ? 'two dictionary words' : 'short brandable');
  } else {
    reasons.push(words.length >= 3 ? 'three or more words' : 'not pronounceable');
  }

  const tier = qualifies && tldInAlpha ? 'alpha' : 'standard';
  return { ...result, words, tier, reasons };
}

module.exports.assessNameAlpha = assessNameAlpha;
module.exports.ALPHA_TLDS = ALPHA_TLDS;
