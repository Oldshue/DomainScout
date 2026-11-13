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
      if (e.provider === 'ParkLogic') assert.equal(row.tape, 'noise', 'ParkLogic proves parking, not seller origin');
      else assert.notEqual(row.tape, 'noise', `${e.provider} must not fall into noise by omission`);
      if (tape === 'aftermarket' && !d.REGISTRAR_DEFAULT_PARKING.includes(e.provider) && e.provider !== 'ParkLogic') assert.equal(row.tape, 'aftermarket', e.provider);
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
    const want = venue === 'ParkLogic' ? null : venue === 'Spaceship Parking' || venue === 'Dynadot Parking' ? 'registrar default parking' : 'resale marketplace or reseller';
    assert.equal(d.venueClass(venue), want, venue);
  }
  // Old rule put every production string on aftermarket; the parking rows now reach builder.
  const builderRows = Object.entries(PRODUCTION_VENUES).filter(([v]) => d.tapeForRow({ venue: v, reportDate: '2026-10-20' }).tape === 'builder').reduce((n, [, c]) => n + c, 0);
  assert.equal(builderRows, 338 + 165);
});

test('tape per row: registrar default parking is reseller tape only with stored transfer evidence; marketplace venues unchanged', () => {
  const day = '2026-10-20';
  const at = created => ({ discovery: { rdap: { createdAt: created } } });
  // marketplace / reseller venues: unchanged (fresh registration => builder, else aftermarket)
  assert.equal(d.tapeForRow({ venue: 'Afternic', reportDate: day, ...at('2026-07-22T00:00:00Z') }).tape, 'builder');
  assert.equal(d.tapeForRow({ venue: 'Sedo', reportDate: day }).tape, 'aftermarket');
  assert.equal(d.tapeForRow({ venue: 'Sedo', reportDate: day, ...at('2012-01-01') }).tape, 'aftermarket');
  // registrar default parking, every production parking string, any registration age, no transfer => builder
  for (const venue of ['Spaceship Parking', 'Dynadot Parking']) {
    for (const reg of [null, '2026-09-01', '2025-03-01', '2019-05-01']) {
      const placed = d.tapeForRow({ venue, reportDate: day, ...(reg ? at(reg) : {}) });
      assert.equal(placed.tape, 'builder', `${venue} reg ${reg}`);
      assert.equal(placed.olderName, undefined, 'no older name tag');
    }
  }
  // registrar default parking WITH stored transfer evidence => aftermarket
  const old = at('2019-05-01').discovery;
  assert.equal(d.tapeForRow({ venue: 'Spaceship Parking', reportDate: day, discovery: { ...old, transferEvidence: { registrarChanged: true, observedAt: '2026-10-25T00:00:00Z' } } }).tape, 'aftermarket', 'recorded registrar change after departure');
  assert.equal(d.tapeForRow({ venue: 'Spaceship Parking', reportDate: day, discovery: { ...old, transferEvidence: { registrarChanged: true, observedAt: '2026-01-01T00:00:00Z' } } }).tape, 'builder', 'registrar change before departure is not evidence');
  assert.equal(d.tapeForRow({ venue: 'Dynadot Parking', reportDate: day, discovery: { rdap: { createdAt: '2025-01-01', pendingTransfer: true } } }).tape, 'aftermarket', 'transfer in progress');
  assert.equal(d.tapeForRow({ venue: 'Dynadot Parking', reportDate: day, discovery: { rdap: { createdAt: '2025-01-01', transferAt: '2026-10-22T00:00:00Z' } } }).tape, 'aftermarket', 'completed transfer after departure');
  assert.equal(d.tapeForRow({ venue: 'Dynadot Parking', reportDate: day, discovery: { rdap: { createdAt: '2025-01-01', transferAt: '2025-06-01T00:00:00Z' } } }).tape, 'builder', 'old transfer before departure');
  assert.equal(d.tapeForRow({ venue: 'Spaceship Parking', reportDate: day, classification: 'transfer-completed' }).tape, 'aftermarket');
  const row = d.deriveRow({ domain: 'brightpath.com', venue: 'Spaceship Parking', reportDate: day, ...at('2019-05-01') });
  assert.equal(row.tape, 'builder');
  assert.equal(row.olderName, undefined);
  assert.equal(row.venueClass, 'registrar default parking');
});

test('lmwebui.com shape: default parking, registered 2025, site live, no transfer => builder tape, live: own site built', () => {
  const entry = { domain: 'lmwebui.com', venue: 'Spaceship Parking', sellerNameservers: ['launch1.spaceship.net', 'launch2.spaceship.net'], buyerNameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], reportDate: '2026-11-10',
    classification: 'acquisition-candidate', rationale: 'Matching site observed; owner development is still possible.',
    assessment: { buyerUse: true, identity: { aligned: true } },
    discovery: { departureDate: '2026-11-10', rdap: { registrar: 'Spaceship, Inc.', events: [{ action: 'registration', date: '2025-04-02T00:00:00Z' }] }, homepage: { active: true, status: 200, title: 'LM WebUI' } } };
  const row = d.deriveRow(entry);
  assert.equal(row.venueClass, 'registrar default parking');
  assert.equal(row.registeredYear, 2025);
  assert.equal(row.tape, 'builder');
  assert.equal(row.leadReason, 'branded site launched', 'the screen reads this as an observed branded launch on the builder tape');
  assert.equal(row.sold, false, 'a launch is not presented as a completed sale');
  assert.equal(row.olderName, undefined);
});

test('leadReason: likely purchases, pending transfers and branded launches stay distinct', () => {
  const base = { domain: 'brightpath.com', venue: 'Afternic', reportDate: '2026-11-01', discovery: { homepage: { title: 'BrightPath' } } };
  const built = { buyerUse: true, identity: { aligned: true } };
  const r = e => d.leadReason({ ...base, ...e });
  assert.equal(r({ classification: 'likely-sale', assessment: { basis: 'built' } }), 'transfer + branded site');
  assert.equal(r({ classification: 'likely-sale', assessment: { basis: 'transfer' } }), 'marketplace exit + registrar transfer');
  assert.equal(r({ classification: 'likely-sale', assessment: { basis: 'off-market' } }), 'off market 14+ days');
  assert.equal(r({ classification: 'transfer-completed', assessment: built }), 'transfer + branded site');
  assert.equal(r({ classification: 'transfer-completed', assessment: {} }), 'marketplace exit + registrar transfer');
  assert.equal(r({ classification: 'transfer-in-progress', assessment: {} }), 'transfer pending');
  assert.equal(r({ classification: 'transfer-in-progress', venue: 'Spaceship Parking', assessment: {} }), null, 'in progress from registrar default parking is a candidate');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: built }), 'branded site launched');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: { buyerUse: true, identity: { aligned: false } } }), null);
  assert.equal(r({ classification: 'acquisition-candidate', assessment: { ...built, relisted: true } }), null, 'relisted');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: built, discovery: { homepage: { title: 'This domain is for sale' } } }), null, 'parking or template title');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: { ...built, delegation: { expiration: true } } }), null, 'expiry');
  assert.equal(r({ classification: 'acquisition-candidate', assessment: built, discovery: { homepage: { title: 'BrightPath' }, kit: { size: 4 } } }), null, 'portfolio move');
  assert.equal(r({ classification: 'unconfirmed-move', assessment: built }), null);
  assert.deepEqual([...d.LEAD_REASONS], ['transfer + branded site', 'marketplace exit + registrar transfer', 'transfer pending', 'branded site launched', 'off market 14+ days']);
  const row = d.deriveRow({ ...base, classification: 'transfer-completed', assessment: {} });
  assert.equal(row.lead, true);
  assert.equal(row.leadReason, 'marketplace exit + registrar transfer');
  assert.equal(row.sold, false, 'transfer-completed is a lead, not a completed-sale claim');
  assert.equal(row.soldReason, null);
});

test('buyer title: HTML entities decoded once server-side, whitespace collapsed', () => {
  assert.equal(d.cleanTitle('SECOND SONS CANADA &#8211; OUR PEOPLE, OUR HOME, OUR FUTURE'), 'SECOND SONS CANADA – OUR PEOPLE, OUR HOME, OUR FUTURE');
  assert.equal(d.cleanTitle('Bright &#x2014; Path'), 'Bright — Path', 'hex entity');
  assert.equal(d.cleanTitle('Tom &amp; Jerry&rsquo;s &nbsp; Shop'), 'Tom & Jerry’s Shop', 'named entities and whitespace');
  assert.equal(d.cleanTitle('&amp;lt;b&amp;gt;'), '&lt;b&gt;', 'decoded exactly once');
  assert.equal(d.cleanTitle('&lt;script&gt;x&lt;/script&gt;'), '<script>x</script>', 'markup characters are plain text after decoding');
  assert.equal(d.cleanTitle('A &bogus; B'), 'A &bogus; B', 'unknown entity kept');
  assert.equal(d.cleanTitle('   '), null);
  assert.equal(d.cleanTitle(null), null);
  const row = d.deriveRow({ domain: 'secondsons.ca', buyerTitle: '  SECOND SONS &#8211;\n OUR HOME ' });
  assert.equal(row.buyerTitle, 'SECOND SONS – OUR HOME');
});

test('registration date: every stored source (RDAP registration events, assessment and reconstruction rdap) drives registeredYear and the 90-day builder rule', () => {
  const base = { domain: 'brightpath.com', venue: 'Afternic', sellerNameservers: ['ns1.afternic.com'], reportDate: '2026-11-01' };
  const ev = d.deriveRow({ ...base, discovery: { rdap: { events: [{ action: 'last changed', date: '2026-10-30T00:00:00Z' }, { action: 'registration', date: '2011-05-04T00:00:00Z' }] } } });
  assert.equal(ev.registeredYear, 2011, 'stored rdapEvidence { action, date } registration event');
  assert.equal(ev.registeredDate, '2011-05-04');
  assert.equal(ev.registeredYearBand, '2010-2019');
  assert.equal(ev.tape, 'aftermarket');
  const raw = d.deriveRow({ ...base, assessment: { rdap: { events: [{ eventAction: 'registration', eventDate: '2026-09-15T00:00:00Z' }] } } });
  assert.equal(raw.registeredYear, 2026, 'raw RDAP eventAction/eventDate');
  assert.equal(raw.tape, 'builder', 'registered <= 90 days before departure');
  const obs = d.deriveRow({ ...base, reconstruction: { observations: [{ at: '2026-11-02T00:00:00Z', kind: 'probe', rdap: { events: [{ action: 'registration', date: '2026-10-01T00:00:00Z' }] } }] } });
  assert.equal(obs.registeredDate, '2026-10-01', 'reconstruction observation rdap');
  assert.equal(obs.tape, 'builder');
  const parking = d.deriveRow({ ...base, venue: 'Spaceship Parking', sellerNameservers: [], discovery: { rdap: { events: [{ action: 'registration', date: '2019-01-01T00:00:00Z' }] } } });
  assert.equal(parking.tape, 'builder', 'old registration leaving default parking with no transfer evidence is builder');
  assert.equal(parking.registeredYear, 2019, 'registration from a stored event');
  const none = d.deriveRow({ ...base, discovery: { rdap: { events: [{ action: 'transfer', date: '2026-10-30T00:00:00Z' }] } } });
  assert.equal(none.registeredYear, null, 'transfer or last-changed dates are never a registration date');
  assert.equal(none.registeredDate, null);
});

test('buyer host: a live site with no stored title shows its final host; titled or not-live rows do not', () => {
  const base = { domain: 'brightpath.com', venue: 'Afternic', reportDate: '2026-11-01', buyerUrl: 'https://brightpath.com/' };
  const live = { active: true, status: 200, finalUrl: 'https://www.brightpath-health.io/home' };
  assert.equal(d.deriveRow({ ...base, discovery: { homepage: live } }).buyerHost, 'brightpath-health.io');
  assert.equal(d.deriveRow({ ...base, discovery: { homepage: { active: true, status: 200 } } }).buyerHost, 'brightpath.com', 'falls back to the stored buyer URL');
  assert.equal(d.deriveRow({ ...base, buyerTitle: 'BrightPath', discovery: { homepage: live } }).buyerHost, null);
  assert.equal(d.deriveRow({ ...base, discovery: { homepage: { ...live, placeholder: true } } }).buyerHost, null, 'no site yet');
  assert.equal(d.deriveRow({ ...base, discovery: { homepage: { ...live, parked: true } } }).buyerHost, null);
});
