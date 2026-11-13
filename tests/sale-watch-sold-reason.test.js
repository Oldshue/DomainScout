'use strict';

// Every promoted row carries a truthful lead reason. Only likely-sale keeps
// the legacy sold compatibility flag; transfers and launches stay distinct.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const d = require('../server/sale-watch-derive');
const ins = require('../server/sale-watch-insights');
const snap = require('../server/sale-watch-daily-snapshot');

const VENUES = ['Spaceship Parking', 'Dynadot Parking', 'Afternic', 'Sedo', 'HugeDomains / NameBright', 'Atom', 'ParkLogic', 'Weird Market'];
const CLASSES = ['likely-sale', 'transfer-completed', 'transfer-in-progress', 'acquisition-candidate', 'transferred-and-built', 'unconfirmed-move', null];
const EVIDENCE = { none: {}, pending: { rdap: { pendingTransfer: true } }, changed: { transferEvidence: { registrarChanged: true, observedAt: '2026-11-11T00:00:00Z' } }, transferAt: { rdap: { transferAt: '2026-11-11T00:00:00Z' } } };
const REG = { fresh: '2026-10-01', y2025: '2025-04-01', old: '2012-01-01', unknown: null };
function* matrix() {
  for (const venue of VENUES) for (const classification of CLASSES) for (const [ek, ev] of Object.entries(EVIDENCE)) for (const [rk, reg] of Object.entries(REG)) for (const built of [true, false]) {
    yield { key: `${venue}|${classification}|${ek}|${rk}|${built}`, entry: { domain: 'brightpath.com', venue, reportDate: '2026-11-10', classification,
      discovery: { homepage: { active: true, status: 200, title: 'BrightPath' }, ...ev, rdap: { ...(ev.rdap || {}), ...(reg ? { createdAt: reg } : {}) } },
      assessment: built ? { buyerUse: true, identity: { aligned: true } } : {} } };
  }
}

test('every promoted row has a reason; aftermarket branded launches require seller origin', () => {
  const live = new Set();
  for (const { key, entry } of matrix()) {
    const row = d.deriveRow(entry);
    if (row.lead) assert.ok(row.leadReason, `${key}: lead without a reason`);
    if (row.tape === 'aftermarket' && row.leadReason === 'branded site launched') {
      assert.equal(row.venueClass, 'resale marketplace or reseller', key);
      live.add(`${row.venueClass}|${entry.classification}`);
    }
  }
  assert.deepEqual([...live], ['resale marketplace or reseller|acquisition-candidate']);
  // Registrar default parking with transfer evidence is on the reseller tape, but a
  // live site alone there is not a sale reason.
  const parked = d.deriveRow({ domain: 'x.com', venue: 'Spaceship Parking', reportDate: '2026-11-10', classification: 'acquisition-candidate', discovery: { rdap: { pendingTransfer: true }, homepage: { title: 'X' } }, assessment: { buyerUse: true, identity: { aligned: true } } });
  assert.equal(parked.tape, 'aftermarket');
  assert.equal(parked.soldReason, null);
});

test('screen: a row is actionable only with the new stored lead contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const body = source.match(/_saleWatchSold\(row\) \{[\s\S]*?\n  \},/)[0];
  const sold = row => vm.runInNewContext(`({ ${body} })._saleWatchSold(row)`, { row });
  assert.equal(sold({ classification: 'likely-sale', derived: { probablySold: true } }), false, 'legacy classification fallback is rejected');
  assert.equal(sold({ derived: { sold: true, soldReason: 'registrar transfer' } }), false, 'legacy sold reason is rejected');
  assert.equal(sold({ derived: { lead: true } }), false, 'lead without reason');
  assert.equal(sold({ derived: { lead: true, leadReason: 'transfer pending' } }), true);
  assert.equal(sold({ derived: { lead: false, leadReason: 'transfer pending' } }), false);
});

test('server: lead counts need a reason; an old snapshot contract is dropped for a rebuild', () => {
  const rows = [
    { domain: 'a.com', reportDate: '2026-11-12', classification: 'transfer-in-progress', derived: { tape: 'aftermarket', lead: true, leadReason: 'transfer pending', sold: false, soldReason: null } },
    { domain: 'b.com', reportDate: '2026-11-12', derived: { tape: 'aftermarket', lead: true, leadReason: null, sold: false, soldReason: null } },
  ];
  const s = { schema: ins.SNAPSHOT_SCHEMA, status: 'ready', generatedAt: '2026-11-12T12:00:00Z', from: '2026-10-30', to: '2026-11-12', rows };
  const page = ins.serveDailyFromSnapshot(s, { from: s.from, to: s.to, tape: 'aftermarket' });
  assert.equal(page.window.leads.aftermarket, 1);
  assert.equal(page.window.likelyPurchases.aftermarket, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sold-'));
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, JSON.stringify({ ...s, rows: [{ domain: 'c.com', reportDate: '2026-11-12', derived: { tape: 'aftermarket', probablySold: true } }] }));
  assert.equal(snap.readSnapshotFile(file), null);
  fs.writeFileSync(file, JSON.stringify(s));
  assert.ok(snap.readSnapshotFile(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registrar-parking transfer stays lower-signal; seller-departure pending transfer is promoted separately', () => {
  const e = { domain: 'parkmove.com', venue: 'Spaceship Parking', reportDate: '2026-11-12', classification: 'transfer-in-progress', discovery: { rdap: { pendingTransfer: true } } };
  const derived = d.deriveRow(e);
  assert.equal(derived.tape, 'aftermarket', 'pending transfer keeps it on the reseller tape');
  assert.equal(derived.leadReason, null, 'registrar parking is not seller-origin evidence');
  const rows = [
    { domain: 'parkmove.com', reportDate: '2026-11-12', classification: 'transfer-in-progress', evidenceRank: 0, derived },
    { domain: 'sedomove.com', reportDate: '2026-11-12', classification: 'transfer-in-progress', evidenceRank: 0, derived: d.deriveRow({ ...e, domain: 'sedomove.com', venue: 'Sedo' }) },
  ];
  const page = ins.assembleDaily({ rows }, { from: '2026-11-01', to: '2026-11-12', tape: 'aftermarket' });
  assert.deepEqual(page.window.classes, { likelySale: 0, transferCompleted: 0, transferInProgress: 1, candidate: 1 });
  assert.deepEqual(page.days[0].rows.map(r => r.domain), ['sedomove.com', 'parkmove.com'], 'reasonless row ranks with candidates');
});
