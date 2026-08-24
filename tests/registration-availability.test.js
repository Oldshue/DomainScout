'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAvailabilityUrl,
  normalizeAvailabilityCheckType,
  sanitizeAvailabilityDomains,
} = require('../server/registration-availability');

test('availability checks expose explicit fast and authoritative modes', () => {
  assert.equal(normalizeAvailabilityCheckType('full'), 'FULL');
  assert.equal(normalizeAvailabilityCheckType('FAST'), 'FAST');
  assert.equal(normalizeAvailabilityCheckType('guess'), 'FAST');
  assert.match(buildAvailabilityUrl('FULL'), /checkType=FULL$/);
});

test('availability batches remain suffix-neutral for unrelated registrations', () => {
  assert.deepEqual(
    sanitizeAvailabilityDomains(['cedar-safety.org', 'invoice-robot.net', 'not a domain', 42]),
    ['cedar-safety.org', 'invoice-robot.net'],
  );
});
