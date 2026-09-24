'use strict';
// One-off evidence script for the Sale Watch owner-migration PR: runs the
// shipped sale-evidence-v12 classifier against fixture rows shaped exactly
// like the seven reported false-positive domains plus the alwaysready.org
// control case, and prints a before(v11)/after(v12) tier table. Not part of
// the test suite; run manually for PR evidence.
const { assessSaleEntry, VERSION } = require('../server/sale-watch-evidence');
const now = new Date('2026-09-25T00:00:00Z');

function ownerMigrationFixture(domain, sellerNs, buyerNs, day) {
  return {
    domain, tier: 'probable', classification: 'likely-sale',
    reportDate: day, lastObservedAt: now.toISOString(),
    sellerNameservers: sellerNs, buyerNameservers: buyerNs,
    venue: null,
    discovery: {
      structurallyMoved: true, departureDate: day, buyerUse: true,
      homepage: { active: true, status: 200, title: domain.split('.')[0], finalUrl: `https://${domain}` },
      rdap: { registrar: 'Cloudflare, Inc.', registrarId: '1910', transferAt: day, checkedAt: now.toISOString(), statuses: [] },
    },
  };
}

const fixtures = [
  ownerMigrationFixture('saintjohnsbible.org', ['ns55.domaincontrol.com', 'ns56.domaincontrol.com'], ['bob.ns.cloudflare.com', 'alice.ns.cloudflare.com'], '2026-09-24'),
  ownerMigrationFixture('globalbibleinitiative.org', ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'], ['jeff.ns.cloudflare.com', 'kallie.ns.cloudflare.com'], '2026-09-24'),
  ownerMigrationFixture('freejesusfilm.org', ['ns53.worldnic.com', 'ns54.worldnic.com'], ['ingrid.ns.cloudflare.com', 'terry.ns.cloudflare.com'], '2026-09-24'),
  ownerMigrationFixture('logos373.org', ['ns1.dns-parking.com', 'ns2.dns-parking.com'], ['poppy.ns.cloudflare.com', 'alfred.ns.cloudflare.com'], '2026-09-24'),
  ownerMigrationFixture('secondnile.org', ['ns0.transip.net', 'ns1.transip.nl'], ['sergi.ns.cloudflare.com', 'vita.ns.cloudflare.com'], '2026-09-24'),
  ownerMigrationFixture('jim-reeves.org', ['ns-1472.awsdns-56.org', 'ns-234.awsdns-29.com'], ['fiona.ns.cloudflare.com', 'kellen.ns.cloudflare.com'], '2026-09-24'),
  ownerMigrationFixture('newspring.college', ['ns61.domaincontrol.com', 'ns62.domaincontrol.com'], ['agustin.ns.cloudflare.com', 'gloria.ns.cloudflare.com'], '2026-09-24'),
];

const control = {
  domain: 'alwaysready.org', tier: 'probable', classification: 'likely-sale',
  reportDate: '2026-09-24', lastObservedAt: now.toISOString(),
  sellerNameservers: ['ns1.afternic.com', 'ns2.afternic.com'],
  buyerNameservers: ['hassan.ns.cloudflare.com', 'lilyana.ns.cloudflare.com'],
  venue: 'Afternic',
  discovery: {
    structurallyMoved: true, departureDate: '2026-09-24', buyerUse: true,
    homepage: { active: true, status: 200, title: 'Always Ready', finalUrl: 'https://alwaysready.org' },
    rdap: { registrar: 'Cloudflare, Inc.', registrarId: '1910', transferAt: '2026-09-24', checkedAt: now.toISOString(), statuses: [] },
  },
};

const rows = [...fixtures, control];
console.log(`classifier VERSION: ${VERSION}`);
console.log('');
console.log('domain'.padEnd(28), 'BEFORE (v11, as reported)'.padEnd(28), 'AFTER (v12, this fix)'.padEnd(24), 'classification');
console.log('-'.repeat(110));
for (const row of rows) {
  const before = { tier: row.tier, classification: row.classification };
  const after = assessSaleEntry(row, { now });
  console.log(
    row.domain.padEnd(28),
    `${before.tier}/${before.classification}`.padEnd(28),
    after.tier.padEnd(24),
    after.classification,
  );
}
console.log('');
console.log('Full after-state detail:');
for (const row of rows) {
  const after = assessSaleEntry(row, { now });
  console.log(`\n${row.domain}: tier=${after.tier} classification=${after.classification}`);
  console.log(`  rationale: ${after.rationale}`);
}
