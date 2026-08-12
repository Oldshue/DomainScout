'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExplicitSiblingEvidence,
  normalizeExplicitSiblingEvidence,
  rowMatchesExplicitSiblingEvidence,
} = require('../server/sibling-evidence');

test('taken-only accepts only an exact explicit taken record', () => {
  const positive = { taken_in_evidence: [{ tld: '.ai', status: 'taken' }] };
  const negative = { taken_in_evidence: [{ tld: '.ai', status: 'not_taken' }] };
  const unknown = { taken_in_evidence: [{ tld: '.ai', status: 'unknown' }] };
  const contract = { tlds: ['.ai'], mode: 'taken', match: 'all' };
  assert.equal(rowMatchesExplicitSiblingEvidence(positive, contract), true);
  assert.equal(rowMatchesExplicitSiblingEvidence(negative, contract), false);
  assert.equal(rowMatchesExplicitSiblingEvidence(unknown, contract), false);
  assert.equal(rowMatchesExplicitSiblingEvidence({ taken_in_evidence: [] }, contract), false);
  assert.equal(rowMatchesExplicitSiblingEvidence({ taken_in_evidence: true }, contract), false);
  assert.equal(rowMatchesExplicitSiblingEvidence({ taken_in_evidence: 'taken' }, contract), false);
});

test('arbitrary sibling TLDs do not inherit truth from another selected TLD', () => {
  const row = { taken_in_evidence: [
    { tld: '.ai', status: 'taken' },
    { tld: '.shop', status: 'not_taken' },
  ] };
  assert.equal(rowMatchesExplicitSiblingEvidence(row, {
    tlds: ['.ai'], mode: 'taken', match: 'all',
  }), true);
  assert.equal(rowMatchesExplicitSiblingEvidence(row, {
    tlds: ['.shop'], mode: 'taken', match: 'all',
  }), false, 'the unrelated .shop negative must never be coerced from the .ai positive');
  assert.equal(rowMatchesExplicitSiblingEvidence(row, {
    tlds: ['.ai', '.shop'], mode: 'taken', match: 'any',
  }), true);
  assert.equal(rowMatchesExplicitSiblingEvidence(row, {
    tlds: ['.ai', '.shop'], mode: 'taken', match: 'all',
  }), false);
});

test('worker projection emits decisive negatives only for complete coverage', () => {
  const row = { domain: 'sentinel.com' };
  const tlds = ['.ai', '.shop'];
  const sets = [new Set(['sentinel']), new Set()];
  assert.deepEqual(buildExplicitSiblingEvidence(row, { tlds, sets, coverageComplete: true }), [
    { tld: '.ai', status: 'taken' },
    { tld: '.shop', status: 'not_taken' },
  ]);
  assert.deepEqual(buildExplicitSiblingEvidence(row, { tlds, sets, coverageComplete: false }), [
    { tld: '.ai', status: 'taken' },
    { tld: '.shop', status: 'unknown' },
  ]);
});

test('evidence records use an exact fail-closed schema', () => {
  assert.equal(normalizeExplicitSiblingEvidence([{ tld: '.ai', status: 'taken', truthy: true }]), null);
  assert.equal(normalizeExplicitSiblingEvidence([{ tld: '.ai', status: 'taken' }, { tld: 'ai', status: 'taken' }]), null);
  assert.equal(normalizeExplicitSiblingEvidence([{ tld: '.ai', status: 'available' }]), null);
  assert.deepEqual(normalizeExplicitSiblingEvidence([{ tld: 'SHOP', status: 'not_taken' }]), [
    { tld: '.shop', status: 'not_taken' },
  ]);
});
