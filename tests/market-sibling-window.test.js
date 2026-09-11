'use strict';

// Pure-function tests for the date-window scoped market sibling scan. Must never
// require server/index.js (it calls app.listen at load) and must never start a
// scan: market-sibling-scan-worker.js guards all side-effecting work behind
// `if (require.main === module)`, so requiring it here only exposes the pure
// exported helpers below.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMarketSiblingDateWindow,
  normalizeMarketSiblingDateWindow,
  marketSiblingTargetIdentity,
  selectCandidateBaseNames,
} = require('../server/market-sibling-scan-worker');

test('normalizeMarketSiblingDateWindow canonicalizes recognized values and rejects the rest', () => {
  assert.equal(normalizeMarketSiblingDateWindow('today'), 'today');
  assert.equal(normalizeMarketSiblingDateWindow('TOMORROW'), 'tomorrow');
  assert.equal(normalizeMarketSiblingDateWindow(' next24h '), 'next24h');
  assert.equal(normalizeMarketSiblingDateWindow('24h'), 'next24h');
  assert.equal(normalizeMarketSiblingDateWindow('next24'), 'next24h');
  assert.equal(normalizeMarketSiblingDateWindow('2026-09-15'), '2026-09-15');
  assert.equal(normalizeMarketSiblingDateWindow(''), null);
  assert.equal(normalizeMarketSiblingDateWindow(null), null);
  assert.equal(normalizeMarketSiblingDateWindow('any'), null);
  assert.equal(normalizeMarketSiblingDateWindow('garbage'), null);
  assert.equal(normalizeMarketSiblingDateWindow('2026-9-5'), null);
});

test('marketSiblingTargetIdentity folds a normalized window into the target-TLD key so windowed and whole-stream scans never collide', () => {
  assert.equal(marketSiblingTargetIdentity('.io,.co', 'today'), '.io,.co::window=today');
  assert.equal(marketSiblingTargetIdentity('.io,.co', ''), '.io,.co');
  assert.equal(marketSiblingTargetIdentity('.io,.co', null), '.io,.co');
  assert.equal(marketSiblingTargetIdentity('.io,.co', undefined), '.io,.co');
  assert.equal(marketSiblingTargetIdentity('.io,.co', 'garbage'), '.io,.co');
  assert.notEqual(
    marketSiblingTargetIdentity('.io,.co', 'today'),
    marketSiblingTargetIdentity('.io,.co', 'tomorrow'),
  );
  assert.notEqual(
    marketSiblingTargetIdentity('.io,.co', 'today'),
    marketSiblingTargetIdentity('.io,.co', null),
  );
});

test('parseMarketSiblingDateWindow resolves today/tomorrow as adjoining 24h local windows', () => {
  const tz = 'America/Los_Angeles';
  const today = parseMarketSiblingDateWindow('today', tz);
  const tomorrow = parseMarketSiblingDateWindow('tomorrow', tz);
  assert.ok(today && tomorrow);
  assert.equal(today.end, tomorrow.start, 'tomorrow should start exactly where today ends');
  assert.ok(Date.parse(today.start) < Date.parse(today.end));
  assert.match(today.label, /^\d{4}-\d{2}-\d{2}$/);
});

test('parseMarketSiblingDateWindow resolves next24h as a rolling window from now', () => {
  const before = Date.now();
  const window = parseMarketSiblingDateWindow('next24h');
  const after = Date.now();
  assert.ok(window);
  assert.equal(window.label, 'next24h');
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  assert.ok(start >= before && start <= after);
  assert.equal(end - start, 24 * 60 * 60 * 1000);
});

test('parseMarketSiblingDateWindow resolves an exact YYYY-MM-DD date to that local calendar day', () => {
  const window = parseMarketSiblingDateWindow('2026-09-15', 'America/Los_Angeles');
  assert.ok(window);
  assert.equal(window.label, '2026-09-15');
  assert.equal(window.start, '2026-09-15T07:00:00.000Z');
  assert.equal(window.end, '2026-09-16T07:00:00.000Z');
});

test('parseMarketSiblingDateWindow returns null for empty/any/unrecognized input (whole-stream, unchanged semantics)', () => {
  assert.equal(parseMarketSiblingDateWindow(''), null);
  assert.equal(parseMarketSiblingDateWindow(undefined), null);
  assert.equal(parseMarketSiblingDateWindow('any'), null);
  assert.equal(parseMarketSiblingDateWindow('not-a-date'), null);
  assert.equal(parseMarketSiblingDateWindow('09/15/2026'), null);
});

function fixtureIndex(rows) {
  const compactColumns = ['domain', 'tld', 'auction_end'];
  const compactColumnIndex = Object.fromEntries(compactColumns.map((c, i) => [c, i]));
  return {
    compactColumnIndex,
    compactRows: rows.map(([domain, tld, auctionEnd]) => [domain, tld, auctionEnd]),
  };
}

test('selectCandidateBaseNames with no dateWindow keeps every still-open candidate regardless of sourceTlds filter (whole-stream, unchanged behavior)', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  const index = fixtureIndex([
    ['alpha.com', '.com', '2026-09-12T00:00:00.000Z'],
    ['beta.net', '.net', '2026-09-20T00:00:00.000Z'],
    ['gamma.com', '.com', '2026-09-01T00:00:00.000Z'], // already ended, excluded
  ]);
  const names = selectCandidateBaseNames(index, { now });
  assert.deepEqual(names, ['alpha', 'beta']);
});

test('selectCandidateBaseNames filters by sourceTlds exactly like the pre-window behavior', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  const index = fixtureIndex([
    ['alpha.com', '.com', '2026-09-12T00:00:00.000Z'],
    ['beta.net', '.net', '2026-09-20T00:00:00.000Z'],
  ]);
  const names = selectCandidateBaseNames(index, { sourceTlds: new Set(['.com']), now });
  assert.deepEqual(names, ['alpha']);
});

test('selectCandidateBaseNames with a dateWindow keeps only candidates whose auction_end falls inside that window', () => {
  const now = Date.parse('2026-09-11T00:00:00.000Z');
  const dateWindow = { start: '2026-09-11T07:00:00.000Z', end: '2026-09-12T07:00:00.000Z', label: '2026-09-11' };
  const index = fixtureIndex([
    ['before.com', '.com', '2026-09-11T06:59:59.000Z'], // just before window start, excluded
    ['inside-early.com', '.com', '2026-09-11T07:00:00.000Z'], // exactly window start, included
    ['inside-late.com', '.com', '2026-09-12T06:59:59.000Z'], // just before window end, included
    ['after.com', '.com', '2026-09-12T07:00:00.000Z'], // exactly window end, excluded (half-open)
    ['wayafter.com', '.com', '2026-09-20T00:00:00.000Z'], // far outside, excluded
  ]);
  const names = selectCandidateBaseNames(index, { dateWindow, now });
  assert.deepEqual(names, ['inside-early', 'inside-late']);
});

test('selectCandidateBaseNames never includes a candidate whose auction has already ended, even inside the requested window', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  const dateWindow = { start: '2026-09-11T07:00:00.000Z', end: '2026-09-12T07:00:00.000Z', label: '2026-09-11' };
  const index = fixtureIndex([
    ['ended.com', '.com', '2026-09-11T10:00:00.000Z'], // inside window but already past `now`
  ]);
  const names = selectCandidateBaseNames(index, { dateWindow, now });
  assert.deepEqual(names, []);
});

test('selectCandidateBaseNames dedupes multiple TLD rows for the same base name', () => {
  const now = Date.parse('2026-09-11T00:00:00.000Z');
  const index = fixtureIndex([
    ['alpha.com', '.com', '2026-09-20T00:00:00.000Z'],
    ['alpha.net', '.net', '2026-09-21T00:00:00.000Z'],
  ]);
  const names = selectCandidateBaseNames(index, { now });
  assert.deepEqual(names, ['alpha']);
});
