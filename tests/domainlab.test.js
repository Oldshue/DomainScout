'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  semanticGroupForTld,
  segmentBaseName,
  ZONE_SEMANTIC_GROUPS,
} = require('../server/domainlab');

test('semanticGroupForTld classifies technical, geo and other zones', () => {
  assert.equal(semanticGroupForTld('app'), 'technical');
  assert.equal(semanticGroupForTld('.dev'), 'technical');
  assert.equal(semanticGroupForTld('shop'), 'commerce');
  assert.equal(semanticGroupForTld('de'), 'geo');
  assert.equal(semanticGroupForTld('museum'), 'other');
});

test('ZONE_SEMANTIC_GROUPS covers the required seed extensions', () => {
  assert.deepEqual(ZONE_SEMANTIC_GROUPS.technical.sort(), ['ai', 'app', 'cloud', 'codes', 'dev', 'io', 'sh', 'tech'].sort());
  assert.ok(ZONE_SEMANTIC_GROUPS.commerce.includes('shop'));
  assert.ok(ZONE_SEMANTIC_GROUPS.finance.includes('capital'));
});

test('segmentBaseName splits hyphens first, then longest-match dictionary words', () => {
  const words = segmentBaseName('rally-talent');
  assert.deepEqual(words, ['rally', 'talent']);
});

test('segmentBaseName degrades gracefully on names with no clean dictionary split', () => {
  const words = segmentBaseName('xz9-qq');
  assert.ok(Array.isArray(words));
});
