'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAvailabilityUrl,
  chunkAvailabilityDomains,
  normalizeAvailabilityCheckType,
  sanitizeAvailabilityDomains,
} = require('../server/registration-availability');

test('availability checks expose explicit fast and authoritative modes', () => {
  assert.equal(normalizeAvailabilityCheckType('full'), 'FULL');
  assert.equal(normalizeAvailabilityCheckType('FAST'), 'FAST');
  assert.equal(normalizeAvailabilityCheckType('guess'), 'FAST');
  assert.match(buildAvailabilityUrl('FULL'), /checkType=FULL$/);
});

test('authoritative checks use bounded provider batches without changing suffix semantics', () => {
  const domains = [
    'cedar-safety.org', 'invoice-robot.net', 'route.co', 'micrograph.co', 'northstar.dev',
    'bluebird.app', 'atlas.ai', 'signal.io', 'openanswer.co', 'vectortrust.co', 'agenticgraph.co',
  ];
  assert.deepEqual(chunkAvailabilityDomains(domains, 'FULL').map(chunk => chunk.length), [10, 1]);
  assert.deepEqual(chunkAvailabilityDomains(domains, 'FAST').map(chunk => chunk.length), [11]);
});

test('availability batches remain suffix-neutral for unrelated registrations', () => {
  assert.deepEqual(
    sanitizeAvailabilityDomains(['cedar-safety.org', 'invoice-robot.net', 'not a domain', 42]),
    ['cedar-safety.org', 'invoice-robot.net'],
  );
});
