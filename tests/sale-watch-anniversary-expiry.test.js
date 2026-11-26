'use strict';

// Registration-anniversary expiries (2026-11-25): a name that leaves seller
// DNS for registrar-default DNS just after its registration anniversary, with
// no registrar transfer and no built site, lapsed. It is an expiration, never
// a likely sale, however long it then stays off the market.

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessSaleEntry, anniversaryExpiry, ledgerVerdict, ANNIVERSARY_EXPIRY_DAYS } = require('../server/sale-watch-evidence');

const AFTERNIC = ['ns1.afternic.com', 'ns2.afternic.com'];
const GODADDY = ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'];

function entry(domain, { created, left, statuses = [], registrar = 'GoDaddy.com, LLC', after = GODADDY, events = null, discovery = {} } = {}) {
  return {
    domain, sellerNameservers: AFTERNIC, buyerNameservers: after, reportDate: left, lastObservedAt: '2026-12-09T00:00:00Z',
    discovery: {
      structurallyMoved: true, departureDate: left,
      movement: { day: left, currentClass: 'registrar', currentNameservers: after },
      rdap: { checkedAt: '2026-12-09T00:00:00Z', statuses, registrar, events: events || (created ? [{ action: 'registration', date: `${created}T18:04:11Z` }] : []) },
      ...discovery,
    },
  };
}
const NOW = new Date('2026-12-10T00:00:00Z');
const assess = e => assessSaleEntry(e, { now: NOW });

test('GoDaddy name that left Afternic six days after its anniversary is an expiration, not a likely sale', () => {
  for (const [domain, created, left] of [['computeliquid.com', '2025-11-07', '2026-11-13'], ['inferenceindexing.com', '2025-11-19', '2026-11-25'], ['gpupower.com', '2021-11-12', '2026-11-18']]) {
    const a = assess(entry(domain, { created, left, statuses: ['client renew prohibited', 'client update prohibited'] }));
    assert.equal(a.classification, 'expiration', domain);
    assert.equal(a.tier, 'excluded', domain);
    assert.equal(a.assessment.basis, 'anniversary');
    const anniversary = `2026-${created.slice(5)}`;
    assert.ok(a.rationale.includes(anniversary), `rationale states the anniversary date ${anniversary}: ${a.rationale}`);
    assert.match(a.rationale, /6 days after its registration anniversary/);
    assert.equal(ledgerVerdict(a), 'expired');
  }
  // The same footprint with no status at all: the anniversary alone decides.
  const bare = assess(entry('computeliquid.com', { created: '2025-11-07', left: '2026-11-13' }));
  assert.equal(bare.classification, 'expiration');
  // Namecheap / DreamHost: one day after the anniversary.
  const next = assess(entry('computevector.com', { created: '2024-11-17', left: '2026-11-18', registrar: 'NameCheap, Inc.', after: ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'] }));
  assert.equal(next.classification, 'expiration');
  assert.match(next.rationale, /1 day after its registration anniversary on 2026-11-17/);
});

test('a non-anniversary Afternic departure is still a likely sale after 14 days off the market', () => {
  const a = assess(entry('steadysale.com', { created: '2015-05-15', left: '2026-11-18' }));
  assert.equal(a.classification, 'likely-sale');
  assert.equal(a.tier, 'probable');
  assert.equal(a.assessment.basis, 'off-market');
  assert.equal(ledgerVerdict(a), 'sold');
});

test('an expiry registry status alone marks the lapse; the registration date is never guessed', () => {
  for (const status of ['auto renew period', 'redemption period', 'pending delete']) {
    const a = assess(entry('statusonly.com', { created: '2015-05-15', left: '2026-11-18', statuses: [status] }));
    assert.equal(a.classification, 'expiration', status);
  }
  // 'client renew prohibited' is GoDaddy's standing lock on every name (godaddy.com
  // carries it with an expiry in 2032): away from the anniversary it decides nothing.
  const locked = assess(entry('lockedsale.com', { created: '2015-05-15', left: '2026-11-18', statuses: ['client delete prohibited', 'client renew prohibited', 'client transfer prohibited', 'client update prohibited'] }));
  assert.equal(locked.classification, 'likely-sale');
  // No registration date stored and no expiry status: nothing to infer from.
  const unknown = assess(entry('nodate.com', { created: null, left: '2026-11-18' }));
  assert.equal(unknown.classification, 'likely-sale');
  // The stored expiration event's month and day stand in when no registration event is stored.
  const viaExpiry = assess(entry('expiryevent.com', { left: '2026-11-18', events: [{ action: 'expiration', date: '2027-11-12T00:00:00Z' }] }));
  assert.equal(viaExpiry.classification, 'expiration');
  assert.match(viaExpiry.rationale, /6 days after its yearly expiry date on 2026-11-12/);
});

test('a registrar transfer or a built site near the anniversary is not an expiry', () => {
  const transferred = assess(entry('movedregistrar.com', { created: '2020-11-07', left: '2026-11-13', discovery: {} }));
  assert.equal(transferred.classification, 'expiration');
  const withTransfer = entry('movedregistrar.com', { created: '2020-11-07', left: '2026-11-13', registrar: 'Squarespace Domains', after: ['ns1.example-host.net', 'ns2.example-host.net'] });
  withTransfer.discovery.rdap.events.push({ action: 'transfer', date: '2026-11-14T00:00:00Z' });
  withTransfer.discovery.rdap.transferAt = '2026-11-14T00:00:00Z';
  assert.equal(assess(withTransfer).classification, 'likely-sale');
});

test('anniversaryExpiry: 0 to 21 days after a yearly anniversary, never the registration day itself', () => {
  const rdap = created => ({ events: [{ action: 'registration', date: `${created}T00:00:00Z` }] });
  assert.equal(ANNIVERSARY_EXPIRY_DAYS, 21);
  assert.deepEqual(anniversaryExpiry(rdap('2021-11-12'), '2026-11-18'), { anniversary: '2026-11-12', daysAfter: 6, registeredDay: '2021-11-12', basis: 'registration' });
  // The stored expiration date is the term's real end when it differs from the registration date.
  const moved = { events: [{ action: 'registration', date: '1999-03-02T00:00:00Z' }, { action: 'expiration', date: '2027-11-01T00:00:00Z' }] };
  assert.deepEqual(anniversaryExpiry(moved, '2026-11-06'), { anniversary: '2026-11-01', daysAfter: 5, registeredDay: '1999-03-02', basis: 'expiration' });
  assert.equal(anniversaryExpiry(moved, '2026-03-08'), null, 'the registration month and day is not the term end here');
  assert.equal(anniversaryExpiry(rdap('2021-11-12'), '2026-11-12').daysAfter, 0);
  assert.equal(anniversaryExpiry(rdap('2021-11-12'), '2026-12-03').daysAfter, 21);
  assert.equal(anniversaryExpiry(rdap('2021-11-12'), '2026-12-04'), null);
  assert.equal(anniversaryExpiry(rdap('2021-11-12'), '2026-11-11'), null, 'before the anniversary');
  // Across a year boundary: registered 20 December, left 10 January.
  assert.deepEqual(anniversaryExpiry(rdap('2022-12-20'), '2026-01-10'), { anniversary: '2025-12-20', daysAfter: 21, registeredDay: '2022-12-20', basis: 'registration' });
  // A name registered three weeks ago has no anniversary yet.
  assert.equal(anniversaryExpiry(rdap('2026-11-01'), '2026-11-18'), null);
  assert.equal(anniversaryExpiry({}, '2026-11-18'), null);
});
