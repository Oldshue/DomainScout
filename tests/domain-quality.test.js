'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessNameAlpha, ALPHA_TLDS, computeDomainQuality } = require('../server/domain-quality');

test('assessNameAlpha: faxly.com is alpha via short brandable form', () => {
  const r = assessNameAlpha('faxly.com');
  assert.equal(r.tier, 'alpha');
  assert.ok(r.reasons.includes('short brandable'));
});

test('assessNameAlpha: buykosher.com is alpha via two dictionary words', () => {
  const r = assessNameAlpha('buykosher.com');
  assert.equal(r.tier, 'alpha');
  assert.ok(r.reasons.includes('two dictionary words'));
  assert.deepEqual(r.words, ['buy', 'kosher']);
});

test('assessNameAlpha: containerinbox.com is alpha', () => {
  const r = assessNameAlpha('containerinbox.com');
  assert.equal(r.tier, 'alpha');
});

test('assessNameAlpha: loftclearance.com is alpha', () => {
  const r = assessNameAlpha('loftclearance.com');
  assert.equal(r.tier, 'alpha');
});

test('assessNameAlpha: ciprocity.com is standard (fails both forms)', () => {
  const r = assessNameAlpha('ciprocity.com');
  assert.equal(r.tier, 'standard');
});

test('assessNameAlpha: aiphotorestoration.com is standard (three or more words)', () => {
  const r = assessNameAlpha('aiphotorestoration.com');
  assert.equal(r.tier, 'standard');
  assert.ok(r.reasons.includes('three or more words'));
});

test('assessNameAlpha: dallascleaningservices.com is weak (length)', () => {
  const r = assessNameAlpha('dallascleaningservices.com');
  assert.equal(r.tier, 'weak');
  assert.ok(r.reasons.includes('length'));
});

test('assessNameAlpha: 4tube.casa is weak (non-alpha characters)', () => {
  const r = assessNameAlpha('4tube.casa');
  assert.equal(r.tier, 'weak');
});

test('assessNameAlpha: hdporn.cfd is standard', () => {
  const r = assessNameAlpha('hdporn.cfd');
  assert.equal(r.tier, 'standard');
});

test('assessNameAlpha: ar-15newsletter.com is weak (non-alpha characters)', () => {
  const r = assessNameAlpha('ar-15newsletter.com');
  assert.equal(r.tier, 'weak');
});

test('assessNameAlpha: fluxstore.app is alpha', () => {
  const r = assessNameAlpha('fluxstore.app');
  assert.equal(r.tier, 'alpha');
});

test('assessNameAlpha: kemel.education is standard (tld not in alpha tier)', () => {
  const r = assessNameAlpha('kemel.education');
  assert.equal(r.tier, 'standard');
});

test('assessNameAlpha: something.xyz is weak (zero-weight suffix)', () => {
  const r = assessNameAlpha('something.xyz');
  assert.equal(r.tier, 'weak');
});

test('assessNameAlpha: goodlocal.co.uk is alpha (two-label TLD lookup)', () => {
  const r = assessNameAlpha('goodlocal.co.uk');
  assert.equal(r.tier, 'alpha');
  assert.equal(r.tld, 'co.uk');
});

test('assessNameAlpha: ALPHA_TLDS is exported and frozen', () => {
  assert.ok(Array.isArray(ALPHA_TLDS));
  assert.ok(ALPHA_TLDS.includes('com'));
  assert.ok(Object.isFrozen(ALPHA_TLDS));
});

test('computeDomainQuality remains untouched and functional', () => {
  const r = computeDomainQuality({ domain: 'example.com', base_name: 'example', length: 7, tld: '.com' });
  assert.equal(typeof r.quality_score, 'number');
  assert.equal(typeof r.quality_reasons, 'string');
});
