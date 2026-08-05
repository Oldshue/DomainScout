'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeTakenInMatch,
  normalizeTargetTlds,
  buildAuthoritativeSiblingCoverage,
} = require('../server/taken-in-coverage');

const HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 48 * HOUR_MS;

function isoMsAgo(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

test('normalizeTakenInMatch: default is all', () => {
  assert.equal(normalizeTakenInMatch(undefined), 'all');
  assert.equal(normalizeTakenInMatch(null), 'all');
  assert.equal(normalizeTakenInMatch(''), 'all');
  assert.equal(normalizeTakenInMatch('bogus'), 'all');
  assert.equal(normalizeTakenInMatch(42), 'all');
});

test('normalizeTakenInMatch: explicit any normalization is case-insensitive', () => {
  assert.equal(normalizeTakenInMatch('any'), 'any');
  assert.equal(normalizeTakenInMatch('ANY'), 'any');
  assert.equal(normalizeTakenInMatch('  Any  '), 'any');
});

test('normalizeTakenInMatch: explicit all normalization is case-insensitive', () => {
  assert.equal(normalizeTakenInMatch('all'), 'all');
  assert.equal(normalizeTakenInMatch('ALL'), 'all');
});

test('normalizeTargetTlds: normalizes leading dots/case, sorts, dedupes', () => {
  const result = normalizeTargetTlds(['.Dev', 'app', '.APP', 'dev', ' .bio ', '.bio']);
  assert.deepEqual(result, ['app', 'bio', 'dev']);
});

test('normalizeTargetTlds: ignores non-string/empty entries', () => {
  const result = normalizeTargetTlds(['dev', null, 42, '', '.', undefined]);
  assert.deepEqual(result, ['dev']);
});

test('buildAuthoritativeSiblingCoverage: fresh complete coverage for all targets', () => {
  const nowMs = Date.now();
  const zoneRows = [
    { tld: 'dev', record_count: 1000, file_date: isoMsAgo(1 * HOUR_MS) },
    { tld: 'app', record_count: 500, file_date: isoMsAgo(2 * HOUR_MS) },
  ];
  const receipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['dev', 'app'],
    zoneRows,
    nowMs,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(receipt.complete, true);
  assert.equal(receipt.status, 'complete');
  assert.deepEqual(receipt.coveredTlds, ['app', 'dev']);
  assert.deepEqual(receipt.missingTlds, []);
  assert.deepEqual(receipt.staleTlds, []);
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.action, null);
  assert.equal(receipt.evidence, 'czds-zone-index');
  assert.equal(receipt.maxAgeMs, MAX_AGE_MS);
});

test('buildAuthoritativeSiblingCoverage: missing .dev and .app zone rows -> evidence gap', () => {
  const nowMs = Date.now();
  const zoneRows = [
    { tld: 'com', record_count: 1000, file_date: isoMsAgo(1 * HOUR_MS) },
  ];
  const receipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['dev', 'app'],
    zoneRows,
    nowMs,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(receipt.complete, false);
  assert.equal(receipt.status, 'evidence-gap');
  assert.deepEqual(receipt.missingTlds, ['app', 'dev']);
  assert.equal(receipt.retryable, true);
  assert.equal(receipt.action, 'request-zone-access');
});

test('buildAuthoritativeSiblingCoverage: stale .com zone (older than 48h) -> evidence gap', () => {
  const nowMs = Date.now();
  const zoneRows = [
    { tld: 'com', record_count: 1000, file_date: isoMsAgo(49 * HOUR_MS) },
  ];
  const receipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['com'],
    zoneRows,
    nowMs,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(receipt.complete, false);
  assert.deepEqual(receipt.staleTlds, ['com']);
  assert.equal(receipt.retryable, true);
  assert.equal(receipt.action, 'refresh');
});

test('buildAuthoritativeSiblingCoverage: malformed file_date is treated as not authoritative', () => {
  const nowMs = Date.now();
  const zoneRows = [
    { tld: 'xyz', record_count: 10, file_date: 'not-a-date' },
  ];
  const receipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['xyz'],
    zoneRows,
    nowMs,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(receipt.complete, false);
  assert.deepEqual(receipt.staleTlds, ['xyz']);
});

test('buildAuthoritativeSiblingCoverage: malformed/zero record_count is treated as missing', () => {
  const nowMs = Date.now();
  const zoneRows = [
    { tld: 'xyz', record_count: 0, file_date: isoMsAgo(1 * HOUR_MS) },
    { tld: 'abc', record_count: 'not-a-number', file_date: isoMsAgo(1 * HOUR_MS) },
  ];
  const receipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['xyz', 'abc'],
    zoneRows,
    nowMs,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(receipt.complete, false);
  assert.deepEqual(receipt.missingTlds, ['abc', 'xyz']);
});

test('buildAuthoritativeSiblingCoverage: 48-hour boundary is inclusive; just past is stale', () => {
  const nowMs = Date.now();
  const insideRows = [
    { tld: 'net', record_count: 5, file_date: isoMsAgo(MAX_AGE_MS - 1000) },
  ];
  const insideReceipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['net'],
    zoneRows: insideRows,
    nowMs,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(insideReceipt.complete, true);

  const outsideRows = [
    { tld: 'net', record_count: 5, file_date: isoMsAgo(MAX_AGE_MS + 1000) },
  ];
  const outsideReceipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['net'],
    zoneRows: outsideRows,
    nowMs,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(outsideReceipt.complete, false);
  assert.deepEqual(outsideReceipt.staleTlds, ['net']);
});

test('buildAuthoritativeSiblingCoverage: unrelated fresh .bio fixture does not satisfy .dev target', () => {
  const nowMs = Date.now();
  const zoneRows = [
    { tld: 'bio', record_count: 300, file_date: isoMsAgo(1 * HOUR_MS) },
  ];
  const receipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['dev'],
    zoneRows,
    nowMs,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(receipt.complete, false);
  assert.deepEqual(receipt.missingTlds, ['dev']);
  assert.equal(Object.prototype.hasOwnProperty.call(receipt.fileDates, 'bio'), false);
});

test('buildAuthoritativeSiblingCoverage: receipt always carries action/retryable fields', () => {
  const completeReceipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['dev'],
    zoneRows: [{ tld: 'dev', record_count: 1, file_date: isoMsAgo(1000) }],
    nowMs: Date.now(),
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(completeReceipt, 'retryable'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(completeReceipt, 'action'), true);

  const gapReceipt = buildAuthoritativeSiblingCoverage({
    targetTlds: ['dev'],
    zoneRows: [],
    nowMs: Date.now(),
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(gapReceipt.retryable, true);
  assert.equal(gapReceipt.action, 'request-zone-access');
});

test('bounded source assertion: /api/domains exposes takenInMatch, takenInEvidence, siblingCoverage on every request and fails closed with domains:[]', () => {
  const indexPath = path.join(__dirname, '..', 'server', 'index.js');
  const src = fs.readFileSync(indexPath, 'utf8');

  assert.match(src, /takenInMatch/);
  assert.match(src, /takenInEvidence/);
  assert.match(src, /siblingCoverage/);
  assert.match(src, /normalizeTakenInMatch/);
  assert.match(src, /buildAuthoritativeSiblingCoverage/);
  assert.match(src, /domains:\s*\[\]/);
  assert.match(src, /totalCapped:\s*false/);
  assert.match(src, /mode:\s*partialTakenInAllowed\s*\?\s*'partial'\s*:\s*'complete'/);
  assert.match(src, /takenInMatch === 'any' \? ' OR ' : ' AND '/);
});
