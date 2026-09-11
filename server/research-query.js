'use strict';

// dotDB-parity search query model — pure, no DB or Express dependency.
// parseResearchQuery(params) turns raw HTTP-style query params into a
// frozen, deterministic model that server/universe-summary.js (via
// server/zone-truth.js) executes against the daily universe summary.
//
// Model shape:
//   {
//     terms: [...],                       // OR terms (multi=false) or ordered parts (multi=true)
//     position: 'any'|'beginning'|'end'|'shuffle',
//     multi: boolean,
//     exclude: [...],
//     filters: { digits, hyphens, idn, minLength, maxLength, extensions },
//     notes: [ 'plain sentence', ... ],
//   }
// On invalid input, returns { error: 'message', status: 400 } instead.

const MAX_PARTS = 6;
const MAX_SHUFFLE_PARTS = 4;
const MIN_PART_LEN = 2;

const POSITION_ALIASES = {
  prefix: 'beginning',
  start: 'beginning',
  starts: 'beginning',
  startswith: 'beginning',
  begin: 'beginning',
  beginning: 'beginning',
  contains: 'any',
  contain: 'any',
  any: 'any',
  suffix: 'end',
  ends: 'end',
  endswith: 'end',
  end: 'end',
  shuffle: 'shuffle',
};

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

function errorResult(message) {
  return { error: message, status: 400 };
}

function splitList(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeExtension(tld) {
  const t = String(tld || '').trim().toLowerCase();
  if (!t || t === 'all') return null;
  return t.startsWith('.') ? t : `.${t}`;
}

// All orderings of `parts` (used for shuffle position; the caller caps
// parts.length to MAX_SHUFFLE_PARTS before relying on this — 4! = 24 max).
function permutations(parts) {
  if (parts.length <= 1) return [parts.slice()];
  const result = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rest = parts.slice(0, i).concat(parts.slice(i + 1));
    for (const perm of permutations(rest)) {
      result.push([parts[i], ...perm]);
    }
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function parseResearchQuery(params = {}) {
  const notes = [];

  // ── q (+ prefix/term aliases) and inline "-exclude" tokens ─────────────
  const rawQInput = String(params.q ?? params.prefix ?? params.term ?? '');
  const inlineExcludes = [];
  const qTokens = rawQInput
    .split(/\s+/)
    .filter(Boolean)
    .filter(tok => {
      if (tok.length > 1 && tok.startsWith('-')) {
        inlineExcludes.push(tok.slice(1).toLowerCase());
        return false;
      }
      return true;
    });
  const rawQ = qTokens.join(' ');
  const hasWhitespace = /\s/.test(rawQ.trim());

  // ── multi: default on when q contains whitespace ───────────────────────
  let multi = hasWhitespace;
  const rawMulti = params.multi;
  if (rawMulti !== undefined && rawMulti !== null && rawMulti !== '') {
    const v = String(rawMulti).toLowerCase();
    if (TRUTHY.has(v)) multi = true;
    else if (FALSY.has(v)) multi = false;
  }

  // ── terms: ordered parts (multi) or OR terms (legacy, superset-compatible) ─
  let terms;
  if (multi) {
    terms = rawQ
      .toLowerCase()
      .split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length >= MIN_PART_LEN)
      .slice(0, MAX_PARTS);
  } else {
    terms = [...new Set(
      rawQ
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .map(t => t.trim())
        .filter(t => t.length >= MIN_PART_LEN && t !== 'or' && t !== 'and')
    )].slice(0, MAX_PARTS);
  }

  if (!terms.length) {
    return errorResult('enter at least one term with 2+ characters');
  }

  // ── position (aliases: prefix/start*→beginning, contains→any, suffix/end*→end) ─
  const rawPosition = String(params.position ?? params.mode ?? 'prefix').toLowerCase();
  let position = POSITION_ALIASES[rawPosition];
  if (!position) {
    return errorResult(`unsupported position: ${rawPosition}`);
  }

  if (position === 'shuffle' && multi && terms.length > MAX_SHUFFLE_PARTS) {
    notes.push(`shuffle limited to the first ${MAX_SHUFFLE_PARTS} parts; falling back to matching anywhere for the rest`);
    position = 'any';
  }

  // ── exclude: comma/space list param + inline "-term" tokens from q ─────
  const exclude = [...new Set(
    [...splitList(params.exclude), ...inlineExcludes]
      .map(t => t.toLowerCase())
      .filter(Boolean)
  )];

  // ── filters ──────────────────────────────────────────────────────────
  const digitsRaw = params.digits == null || params.digits === '' ? 'any' : String(params.digits).toLowerCase();
  if (!['any', 'none', 'only'].includes(digitsRaw)) {
    return errorResult(`invalid digits filter: ${params.digits}`);
  }

  const hyphensRaw = params.hyphens == null || params.hyphens === '' ? 'any' : String(params.hyphens).toLowerCase();
  if (!['any', 'none'].includes(hyphensRaw)) {
    return errorResult(`invalid hyphens filter: ${params.hyphens}`);
  }

  const idnRaw = params.idn == null || params.idn === '' ? 'any' : String(params.idn).toLowerCase();
  if (!['any', 'none'].includes(idnRaw)) {
    return errorResult(`invalid idn filter: ${params.idn}`);
  }

  let minLength = null;
  if (params.minLength != null && params.minLength !== '') {
    minLength = Number.parseInt(params.minLength, 10);
    if (!Number.isFinite(minLength) || minLength < 1) {
      return errorResult(`invalid minLength: ${params.minLength}`);
    }
  }

  let maxLength = null;
  if (params.maxLength != null && params.maxLength !== '') {
    maxLength = Number.parseInt(params.maxLength, 10);
    if (!Number.isFinite(maxLength) || maxLength < 1) {
      return errorResult(`invalid maxLength: ${params.maxLength}`);
    }
  }

  if (minLength != null && maxLength != null && minLength > maxLength) {
    return errorResult(`minLength (${minLength}) must be <= maxLength (${maxLength})`);
  }

  // extensions: `tlds` (comma list) plus the existing extension chip params
  // (`tld`, `extensions`, `domainSuffix`) so old callers keep working.
  const extensionSources = [params.tlds, params.tld, params.extensions, params.domainSuffix];
  const extensions = [...new Set(
    extensionSources
      .flatMap(src => splitList(src))
      .map(normalizeExtension)
      .filter(Boolean)
  )];

  const model = {
    terms,
    position,
    multi,
    exclude,
    filters: {
      digits: digitsRaw,
      hyphens: hyphensRaw,
      idn: idnRaw,
      minLength,
      maxLength,
      extensions,
    },
    notes,
  };

  return deepFreeze(model);
}

module.exports = { parseResearchQuery, permutations };
