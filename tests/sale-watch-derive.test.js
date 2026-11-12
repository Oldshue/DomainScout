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

test('other extensions: shown only as a verified whole-root count, never an estimate', () => {
  const { deriveRow: derive } = require('../server/sale-watch-derive');
  const base = { domain: 'brightpath.com', venue: 'Dan.com', sellerNameservers: ['ns1.dan.com'] };
  const verified = derive({ ...base, discovery: { otherExtensions: { count: 7, verified: true } } });
  assert.equal(verified.otherExtensions, 7);
  assert.equal(verified.otherExtensionsBand, '5-19 other');
  for (const discovery of [{ otherExtensions: { count: 7, verified: false } }, { otherExtensions: { count: 7 } }, { otherExtensionsTaken: 7 }, { extensionCount: 7 }, { otherExtensions: 7 }, {}]) {
    const row = derive({ ...base, discovery });
    assert.equal(row.otherExtensions, null, JSON.stringify(discovery));
    assert.equal(row.otherExtensionsBand, null);
  }
});

test('every venue the ledger can emit has a tape; only names in no table are unknown noise', () => {
  const d = require('../server/sale-watch-derive');
  const nsc = require('../server/nameserver-classes');
  const want = { aftermarket: [...nsc.SELLER_NAMESERVERS, ...nsc.PARKING_NAMESERVERS], builder: nsc.REGISTRAR_DEFAULT_NAMESERVERS };
  for (const [tape, list] of Object.entries(want)) {
    for (const e of list) {
      const row = d.deriveRow({ domain: 'brightpath.com', venue: e.provider, sellerNameservers: [] });
      assert.equal(row.venueKnown, true, e.provider);
      assert.notEqual(row.tape, 'noise', `${e.provider} must not fall into noise by omission`);
      if (tape === 'aftermarket') assert.equal(row.tape, 'aftermarket', e.provider);
      const byNs = d.deriveRow({ domain: 'brightpath.com', venue: null, sellerNameservers: [e.nameserver.includes('.') ? (e.nameserver.split('.').length > 2 ? e.nameserver : `ns1.${e.nameserver}`) : e.nameserver] });
      assert.equal(byNs.venueKnown, true, `ns ${e.nameserver}`);
    }
  }
  for (const e of nsc.HOSTING_NAMESERVERS) assert.equal(d.deriveRow({ domain: 'a.com', venue: e.provider }).venueKnown, true, e.provider);
  const joined = d.deriveRow({ domain: 'a.com', venue: 'Bodis / Nameshift' });
  assert.equal(joined.tape, 'aftermarket');
  const unknown = d.deriveRow({ domain: 'a.com', venue: 'Weird Market', sellerNameservers: ['ns1.weirdmarket.example'] });
  assert.equal(unknown.tape, 'noise');
  assert.equal(unknown.venueKnown, false);
});
