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
  assert.equal(d.homepageState(null), 'site not checked');
  assert.equal(d.homepageState({ parked: true }), 'parked');
  assert.equal(d.homepageState({ active: true, status: 200, purpose: { forSale: true } }), 'for sale');
  assert.equal(d.homepageState({ active: true, status: 200, placeholder: true }), 'no site yet');
  assert.equal(d.homepageState({ active: true, status: 503 }), 'no site yet');
  for (const h of [null, { parked: true }, { active: true, status: 200 }, { error: 'x' }]) assert.ok(d.HOMEPAGE_STATES.includes(d.homepageState(h)));
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
      if (tape === 'aftermarket' && !d.REGISTRAR_DEFAULT_PARKING.includes(e.provider)) assert.equal(row.tape, 'aftermarket', e.provider);
      if (tape === 'builder' || d.REGISTRAR_DEFAULT_PARKING.includes(e.provider)) assert.equal(row.tape, 'builder', `${e.provider} with no registration date`);
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

// Production venue strings (14-day alpha counts in the operator probe) and the
// one venue-class rule: registrar default parking vs resale marketplace or reseller.
const PRODUCTION_VENUES = Object.freeze({
  'Spaceship Parking': 338, Afternic: 292, 'Dynadot Parking': 165, 'HugeDomains / NameBright internal': 114,
  'HugeDomains / NameBright': 56, Atom: 48, BrandBucket: 46, ParkLogic: 42, Sedo: 30, 'Above.com': 28,
  BuyDomains: 24, Dan: 22, ParkingCrew: 14, 'Atom / Squadhelp': 11, Juming: 10, Moniker: 9, Parktons: 8,
  SSLParking: 4, Ztomy: 3, Nameshift: 3, Epik: 2, Efty: 2,
  Bodis: 0, 'Uniregistry Market': 0, 'DCC DNS lander': 0, 'NamePros DNS': 0,
});

test('venue class over exactly the production venue strings', () => {
  for (const venue of Object.keys(PRODUCTION_VENUES)) {
    const want = venue === 'Spaceship Parking' || venue === 'Dynadot Parking' ? 'registrar default parking' : 'resale marketplace or reseller';
    assert.equal(d.venueClass(venue), want, venue);
  }
  // Old rule put every production string on aftermarket; the parking rows now reach builder.
  const builderRows = Object.entries(PRODUCTION_VENUES).filter(([v]) => d.tapeForRow({ venue: v, reportDate: '2026-10-20' }).tape === 'builder').reduce((n, [, c]) => n + c, 0);
  assert.equal(builderRows, 338 + 165);
});

test('tape per row from venue class and registration date (90-day rule)', () => {
  const day = '2026-10-20';
  const at = created => ({ discovery: { rdap: { createdAt: created } } });
  // builder: registered <= 90 days before departure, any venue
  assert.equal(d.tapeForRow({ venue: 'Afternic', reportDate: day, ...at('2026-07-22T00:00:00Z') }).tape, 'builder');
  assert.equal(d.tapeForRow({ venue: 'Spaceship Parking', reportDate: day, ...at('2026-09-01') }).tape, 'builder');
  // builder: registrar default parking with no known registration date
  const unknown = d.tapeForRow({ venue: 'Dynadot Parking', reportDate: day });
  assert.equal(unknown.tape, 'builder');
  assert.equal(unknown.olderName, false);
  // aftermarket: marketplace / reseller with no or old registration date
  assert.equal(d.tapeForRow({ venue: 'Sedo', reportDate: day }).tape, 'aftermarket');
  assert.equal(d.tapeForRow({ venue: 'Sedo', reportDate: day, ...at('2012-01-01') }).tape, 'aftermarket');
  // aftermarket + 'older name': registrar default parking, registered > 90 days before departure
  const older = d.tapeForRow({ venue: 'Spaceship Parking', reportDate: day, ...at('2019-05-01') });
  assert.equal(older.tape, 'aftermarket');
  assert.equal(older.olderName, true);
  const row = d.deriveRow({ domain: 'brightpath.com', venue: 'Spaceship Parking', reportDate: day, ...at('2019-05-01') });
  assert.equal(row.tape, 'aftermarket');
  assert.equal(row.olderName, true);
  assert.equal(row.venueClass, 'registrar default parking');
});

test('soldReason: one branch per reason; everything else is a candidate', () => {
  const base = { domain: 'brightpath.com', venue: 'Afternic', reportDate: '2026-11-01', discovery: { homepage: { title: 'BrightPath' } } };
  const built = { buyerUse: true, identity: { aligned: true } };
  const r = e => d.soldReason({ ...base, ...e });
  assert.equal(r({ classification: 'likely-sale', assessment: { basis: 'built' } }), 'transfer + built site');
  assert.equal(r({ classification: 'likely-sale', assessment: { basis: 'transfer' } }), 'registrar transfer');
  assert.equal(r({ classification: 'likely-sale', assessment: { basis: 'off-market' } }), 'off market 14+ days');
  assert.equal(r({ classification: 'transfer-completed', assessment: built }), 'transfer + built site');
  assert.equal(r({ classification: 'transfer-completed', assessment: {} }), 'registrar transfer');
  assert.equal(r({ classification: 'transfer-in-progress', assessment: {} }), 'transfer in progress');
  assert.equal(r({ classification: 'transfer-in-progress', venue: 'Spaceship Parking', assessment: {} }), null, 'in progress from registrar default parking is a candidate');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: built }), 'buyer site live');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: { buyerUse: true, identity: { aligned: false } } }), null);
  assert.equal(r({ classification: 'acquisition-candidate', assessment: { ...built, relisted: true } }), null, 'relisted');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: built, discovery: { homepage: { title: 'This domain is for sale' } } }), null, 'parking or template title');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: { ...built, delegation: { expiration: true } } }), null, 'expiry');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: built, discovery: { homepage: { title: 'BrightPath' }, kit: { size: 4 } } }), null, 'portfolio move');
  assert.equal(r({ classification: 'unconfirmed-move', assessment: built }), null);
  assert.deepEqual([...d.SOLD_REASONS], ['transfer + built site', 'registrar transfer', 'transfer in progress', 'buyer site live', 'off market 14+ days']);
  const row = d.deriveRow({ ...base, classification: 'transfer-completed', assessment: {} });
  assert.equal(row.sold, true);
  assert.equal(row.soldReason, 'registrar transfer');
});
