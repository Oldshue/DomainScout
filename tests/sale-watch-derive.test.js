'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../server/sale-watch-derive');

test('one venue table decides the tape; unknown venues are noise', () => {
  assert.equal(d.tapeForVenue('Afternic'), 'aftermarket');
  assert.equal(d.tapeForVenue(null, ['ns1.sedo.com']), 'aftermarket');
  assert.equal(d.tapeForVenue(null, ['ns55.domaincontrol.com']), 'builder');
  assert.equal(d.tapeForVenue('somewhere else', ['ns1.example.net']), 'noise');
  assert.ok(d.VENUE_TAPES.every(row => d.TAPES.includes(row.tape)));
});

test('deriveRow gives plain derived fields from stored evidence only', () => {
  const row = d.deriveRow({
    domain: 'bright-path9.co.uk', tier: 'probable', venue: 'Afternic', sellerNameservers: ['ns1.afternic.com'],
    buyerTitle: 'BrightPath', buyerUrl: 'https://bright-path9.co.uk/',
    discovery: { homepage: { active: true, status: 200 }, rdap: { registrar: 'Example Registrar', createdAt: '2014-03-02T00:00:00Z' }, movement: { prevDay: '2026-11-01', day: '2026-11-02' } },
    reconstruction: { observations: [{ at: '2026-11-03T05:00:00Z', kind: 'probe', registrar: 'Example Registrar' }] },
  });
  assert.equal(row.tape, 'aftermarket');
  assert.equal(row.extension, 'co.uk');
  assert.equal(row.length, 12);
  assert.equal(row.lengthBand, '12+');
  assert.equal(row.hasHyphen, true);
  assert.equal(row.hasDigit, true);
  assert.equal(row.homepageState, 'live site');
  assert.equal(row.registeredYear, 2014);
  assert.equal(row.registrar, 'Example Registrar');
  assert.equal(row.otherExtensions, null);
  assert.equal(row.timeline.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(row)), row, 'plain, structured-clone-safe data');
});

test('homepage states and length bands', () => {
  assert.equal(d.homepageState(null), 'not checked');
  assert.equal(d.homepageState({ parked: true }), 'parked');
  assert.equal(d.homepageState({ active: true, status: 503 }), 'unreachable');
  assert.equal(d.lengthBand(4), '1-4');
  assert.equal(d.lengthBand(7), '7-8');
});
