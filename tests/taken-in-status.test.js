'use strict';

const assert = require('assert');
const {
  STATUS,
  normalizeTld,
  cacheCoversTld,
  resolveTakenInStatus,
  aggregateTakenInStatus,
  statusSortWeight,
} = require('../server/taken-in-status');

const universe = { count: 1200, source: 'supported-zone+full-dns:current' };

assert.strictEqual(normalizeTld('DEV'), '.dev');
assert.strictEqual(normalizeTld('not a tld'), null);

// Reproduction: a recently dropped .ai base with no evidence about the sibling
// extension is unchecked. Missing data is never presented as "not taken".
assert.strictEqual(resolveTakenInStatus({}, '.ai', universe), STATUS.UNCHECKED);

assert.strictEqual(
  resolveTakenInStatus({ zoneAuthoritative: true, zoneTaken: false }, '.dev', universe),
  STATUS.NOT_TAKEN
);
assert.strictEqual(
  resolveTakenInStatus({ zoneAuthoritative: true, zoneTaken: true }, '.app', universe),
  STATUS.TAKEN
);

const partial = { source: 'dns-focus:ai+io+co', all_count: 3, taken_json: '[".ai"]' };
assert.strictEqual(cacheCoversTld(partial, '.ai', universe), true);
assert.strictEqual(cacheCoversTld(partial, '.dev', universe), false);
assert.strictEqual(
  resolveTakenInStatus({ cacheRow: partial }, '.dev', universe),
  STATUS.UNCHECKED,
  'a partial cache row must not prove an unrelated TLD is not taken'
);

const complete = { source: universe.source, all_count: universe.count, taken_json: '[".app"]' };
assert.strictEqual(resolveTakenInStatus({ cacheRow: complete }, '.dev', universe), STATUS.NOT_TAKEN);

// Unrelated-capability fixture: .shop follows the same evidence contract.
assert.strictEqual(resolveTakenInStatus({ zoneTaken: true }, '.shop', universe), STATUS.TAKEN);
assert.strictEqual(resolveTakenInStatus({ zoneAuthoritative: true }, '.shop', universe), STATUS.NOT_TAKEN);

assert.strictEqual(aggregateTakenInStatus([STATUS.NOT_TAKEN, STATUS.UNCHECKED]), STATUS.UNCHECKED);
assert.strictEqual(aggregateTakenInStatus([STATUS.NOT_TAKEN, STATUS.TAKEN]), STATUS.TAKEN);
assert.ok(statusSortWeight(STATUS.NOT_TAKEN) < statusSortWeight(STATUS.UNCHECKED));
assert.ok(statusSortWeight(STATUS.UNCHECKED) < statusSortWeight(STATUS.TAKEN));

console.log('taken-in-status.test.js: all assertions passed');
