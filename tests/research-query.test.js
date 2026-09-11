'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseResearchQuery, permutations } = require('../server/research-query');

// ── position aliases ────────────────────────────────────────────────────────

test('parseResearchQuery: mode=prefix aliases to position beginning', () => {
  const model = parseResearchQuery({ term: 'shop', mode: 'prefix' });
  assert.equal(model.position, 'beginning');
  assert.deepEqual(model.terms, ['shop']);
});

test('parseResearchQuery: mode=contains aliases to position any', () => {
  const model = parseResearchQuery({ term: 'shop', mode: 'contains' });
  assert.equal(model.position, 'any');
});

test('parseResearchQuery: mode=suffix aliases to position end', () => {
  const model = parseResearchQuery({ term: 'shop', mode: 'suffix' });
  assert.equal(model.position, 'end');
});

test('parseResearchQuery: position=shuffle is accepted directly', () => {
  const model = parseResearchQuery({ q: 'new york', position: 'shuffle' });
  assert.equal(model.position, 'shuffle');
});

test('parseResearchQuery: legacy prefix/term params still work unchanged (default position beginning)', () => {
  const model = parseResearchQuery({ prefix: 'shop' });
  assert.deepEqual(model.terms, ['shop']);
  assert.equal(model.position, 'beginning');
  assert.equal(model.multi, false);
});

// ── multi: default on when q has whitespace ─────────────────────────────────

test('parseResearchQuery: whitespace in q turns multi on by default with ordered parts', () => {
  const model = parseResearchQuery({ q: 'new york tours' });
  assert.equal(model.multi, true);
  assert.deepEqual(model.terms, ['new', 'york', 'tours']);
});

test('parseResearchQuery: single-word q defaults multi off', () => {
  const model = parseResearchQuery({ q: 'newyork' });
  assert.equal(model.multi, false);
  assert.deepEqual(model.terms, ['newyork']);
});

test('parseResearchQuery: multi=0 forces multi off even with whitespace (falls back to OR terms)', () => {
  const model = parseResearchQuery({ q: 'new york', multi: '0' });
  assert.equal(model.multi, false);
  assert.deepEqual(model.terms, ['new', 'york']);
});

test('parseResearchQuery: multi=1 forces multi on even without whitespace', () => {
  const model = parseResearchQuery({ q: 'shop', multi: '1' });
  assert.equal(model.multi, true);
  assert.deepEqual(model.terms, ['shop']);
});

// ── exclude: comma/space list param + inline "-term" tokens ────────────────

test('parseResearchQuery: inline -term tokens inside q become exclusions and are stripped from terms', () => {
  const model = parseResearchQuery({ q: 'new york -bad -ugly' });
  assert.deepEqual(model.terms, ['new', 'york']);
  assert.deepEqual(model.exclude, ['bad', 'ugly']);
});

test('parseResearchQuery: exclude param merges with inline -term tokens', () => {
  const model = parseResearchQuery({ q: 'new york -bar', exclude: 'foo' });
  assert.deepEqual([...model.exclude].sort(), ['bar', 'foo']);
});

test('parseResearchQuery: exclude param accepts comma or space separated lists', () => {
  const model = parseResearchQuery({ q: 'shop', exclude: 'foo, bar  baz' });
  assert.deepEqual([...model.exclude].sort(), ['bar', 'baz', 'foo']);
});

// ── shuffle permutation cap ──────────────────────────────────────────────────

test('parseResearchQuery: shuffle with <=4 parts keeps position shuffle and adds no notes', () => {
  const model = parseResearchQuery({ q: 'aa bb cc dd', position: 'shuffle' });
  assert.equal(model.position, 'shuffle');
  assert.deepEqual(model.notes, []);
});

test('parseResearchQuery: shuffle with >4 parts falls back to any and records a note', () => {
  const model = parseResearchQuery({ q: 'aa bb cc dd ee', position: 'shuffle' });
  assert.equal(model.position, 'any');
  assert.equal(model.notes.length, 1);
  assert.match(model.notes[0], /shuffle limited to the first 4 parts/);
});

// ── filter parsing ───────────────────────────────────────────────────────────

test('parseResearchQuery: digits/hyphens/idn/length filters parse to the model', () => {
  const model = parseResearchQuery({ q: 'shop', digits: 'only', hyphens: 'none', idn: 'none', minLength: '5', maxLength: '10' });
  assert.deepEqual(model.filters, {
    digits: 'only',
    hyphens: 'none',
    idn: 'none',
    minLength: 5,
    maxLength: 10,
    extensions: [],
  });
});

test('parseResearchQuery: filters default to any/any/any/null/null/[] when unset', () => {
  const model = parseResearchQuery({ q: 'shop' });
  assert.deepEqual(model.filters, {
    digits: 'any',
    hyphens: 'any',
    idn: 'any',
    minLength: null,
    maxLength: null,
    extensions: [],
  });
});

test('parseResearchQuery: tlds comma list normalizes to dotted extensions', () => {
  const model = parseResearchQuery({ q: 'shop', tlds: '.com,net' });
  assert.deepEqual(model.filters.extensions, ['.com', '.net']);
});

test('parseResearchQuery: honours existing extension chip params (tld, domainSuffix) alongside tlds', () => {
  const model = parseResearchQuery({ q: 'shop', tld: 'io', domainSuffix: 'ai' });
  assert.deepEqual(model.filters.extensions, ['.io', '.ai']);
});

// ── invalid -> 400-shaped error object ──────────────────────────────────────

test('parseResearchQuery: empty q returns a 400-shaped error', () => {
  const model = parseResearchQuery({ q: '' });
  assert.deepEqual(model, { error: 'enter at least one term with 2+ characters', status: 400 });
});

test('parseResearchQuery: unsupported position returns a 400-shaped error', () => {
  const model = parseResearchQuery({ q: 'shop', position: 'diagonal' });
  assert.equal(model.status, 400);
  assert.match(model.error, /unsupported position/);
});

test('parseResearchQuery: invalid digits filter returns a 400-shaped error', () => {
  const model = parseResearchQuery({ q: 'shop', digits: 'sometimes' });
  assert.equal(model.status, 400);
  assert.match(model.error, /invalid digits filter/);
});

test('parseResearchQuery: invalid hyphens filter returns a 400-shaped error', () => {
  const model = parseResearchQuery({ q: 'shop', hyphens: 'only' });
  assert.equal(model.status, 400);
  assert.match(model.error, /invalid hyphens filter/);
});

test('parseResearchQuery: invalid idn filter returns a 400-shaped error', () => {
  const model = parseResearchQuery({ q: 'shop', idn: 'only' });
  assert.equal(model.status, 400);
  assert.match(model.error, /invalid idn filter/);
});

test('parseResearchQuery: non-numeric minLength returns a 400-shaped error', () => {
  const model = parseResearchQuery({ q: 'shop', minLength: 'abc' });
  assert.equal(model.status, 400);
  assert.match(model.error, /invalid minLength/);
});

test('parseResearchQuery: minLength greater than maxLength returns a 400-shaped error', () => {
  const model = parseResearchQuery({ q: 'shop', minLength: '10', maxLength: '5' });
  assert.equal(model.status, 400);
  assert.match(model.error, /must be <=/);
});

// ── frozen model ─────────────────────────────────────────────────────────────

test('parseResearchQuery: returns a deep-frozen model', () => {
  const model = parseResearchQuery({ q: 'new york tours' });
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.filters), true);
  assert.equal(Object.isFrozen(model.terms), true);
  assert.equal(Object.isFrozen(model.exclude), true);
});

// ── permutations() pure helper ────────────────────────────────────────────────

test('permutations: single element returns itself', () => {
  assert.deepEqual(permutations(['a']), [['a']]);
});

test('permutations: two elements returns both orderings', () => {
  const perms = permutations(['a', 'b']).map(p => p.join(''));
  assert.deepEqual(perms.sort(), ['ab', 'ba']);
});

test('permutations: three elements returns all six orderings', () => {
  const perms = permutations(['a', 'b', 'c']).map(p => p.join(''));
  assert.equal(perms.length, 6);
  assert.deepEqual(new Set(perms).size, 6);
});
