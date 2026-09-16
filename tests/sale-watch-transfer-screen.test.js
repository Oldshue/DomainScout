'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { ensureReconstructionSchema } = require('../server/sale-watch-reconstruction');
const { screenWentLiveTransfers } = require('../server/sale-watch-transfer-screen');

const DAY = '2026-09-16';
const PREV_DAY = '2026-09-15';

function buildDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  return db;
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-transfer-screen-'));
}

function writeTape(dir, day, rows) {
  const nsDir = path.join(dir, day, 'ns');
  fs.mkdirSync(nsDir, { recursive: true });
  fs.writeFileSync(path.join(nsDir, 'movement.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function insertExistingCandidate(db, domain) {
  db.prepare(`
    INSERT INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, updated_at)
    VALUES (?, '2026-08-01', '2026-08-01', 'godaddy-auction', '2026-08-01', 'probing', '2026-08-05', 1, '2026-08-01T00:00:00Z')
  `).run(domain);
}

test('screenWentLiveTransfers admits a transfer-corroborated move and correctly skips every excluded row class', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  insertExistingCandidate(db, 'existing.example.com');

  const rows = [
    { domain: 'admit.example.com', selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', prev_ns: ['ns1.domaincontrol.com'], today_ns: ['ns1.hosta.com'], prev_provider: 'GoDaddy', today_provider: 'HostA' },
    { domain: 'notransfer.example.com', selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', prev_ns: ['ns1.dyna-ns.net'], today_ns: ['ns1.hostb.com'], prev_provider: 'Dynadot', today_provider: 'HostB' },
    { domain: 'existing.example.com', selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', prev_ns: ['ns1.registrar-servers.com'], today_ns: ['ns1.hostc.com'], prev_provider: 'Namecheap', today_provider: 'HostC' },
    { domain: 'departed.example.com', selection: 'departures', prev_class: 'seller', today_class: 'hosting', prev_ns: ['ns1.afternic.com'], today_ns: ['ns1.hostd.com'], prev_provider: 'Afternic', today_provider: 'HostD' },
    { domain: 'sale.xyz', selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', prev_ns: ['ns1.spaceship.net'], today_ns: ['ns1.hoste.com'], prev_provider: 'Spaceship', today_provider: 'HostE' },
  ];
  const cohortNs = ['ns1.bighost.com', 'ns2.bighost.com'];
  for (let i = 1; i <= 12; i += 1) {
    rows.push({
      domain: `cohort${String(i).padStart(2, '0')}.example.com`,
      selection: 'went-live', prev_class: 'registrar', today_class: 'hosting',
      prev_ns: ['ns1.registrar-servers.com'], today_ns: cohortNs,
      prev_provider: 'Namecheap', today_provider: 'BigHost',
    });
  }
  writeTape(dir, DAY, rows);

  const rdapCalls = [];
  const inspectRdap = async (domain) => {
    rdapCalls.push(domain);
    if (domain === 'admit.example.com') {
      return { checkedAt: new Date().toISOString(), registrar: 'Test Registrar Inc', transferAt: '2026-09-11T00:00:00Z', pendingTransfer: false, events: [{ action: 'transfer', date: '2026-09-11T00:00:00Z' }], statuses: [] };
    }
    if (domain === 'notransfer.example.com') {
      return { checkedAt: new Date().toISOString(), registrar: 'Some Registrar', transferAt: null, pendingTransfer: false, events: [], statuses: [] };
    }
    throw new Error(`unexpected inspectRdap call for ${domain}`);
  };

  const result = await screenWentLiveTransfers(db, { directory: dir, day: DAY, inspectRdap });

  assert.equal(result.day, DAY);
  assert.equal(result.scanned, 17);
  assert.equal(result.eligible, 2);
  assert.equal(result.checked, 2);
  assert.equal(result.admitted, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.exhausted, true);
  assert.ok(Number.isFinite(result.ms));

  assert.equal(rdapCalls.length, 2);
  assert.deepEqual([...rdapCalls].sort(), ['admit.example.com', 'notransfer.example.com']);

  const admitted = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('admit.example.com');
  assert.ok(admitted, 'admitted domain queued as a candidate');
  assert.equal(admitted.state, 'exited');
  assert.equal(admitted.last_stream, 'transfer-departure');
  assert.equal(admitted.next_probe_at, DAY);
  assert.equal(admitted.exit_observed_day, DAY);
  assert.equal(admitted.first_seen_day, PREV_DAY);
  assert.equal(admitted.probe_count, 0);
  const evidence = JSON.parse(admitted.evidence_json);
  assert.equal(evidence.tier, 'suspected');
  assert.deepEqual(evidence.sellerNameservers, ['ns1.domaincontrol.com']);
  assert.deepEqual(evidence.buyerNameservers, ['ns1.hosta.com']);
  assert.equal(evidence.reportDate, DAY);
  assert.equal(evidence.venue, 'GoDaddy');
  assert.equal(evidence.discovery.structurallyMoved, true);
  assert.equal(evidence.discovery.departureDate, DAY);
  assert.equal(evidence.discovery.registrarOrigin, true);
  assert.equal(evidence.discovery.rdap.registrar, 'Test Registrar Inc');
  assert.equal(evidence.discovery.movement.cohortSize, 1);
  assert.equal(evidence.discovery.transferEvidence.transferAt, '2026-09-11T00:00:00Z');
  assert.equal(evidence.discovery.transferEvidence.registrarChanged, false);
  assert.equal(evidence.discovery.transferEvidence.toRegistrar, 'Test Registrar Inc');

  const admittedObs = db.prepare("SELECT * FROM sale_watch_observations WHERE domain=? AND kind='movement'").all('admit.example.com');
  assert.equal(admittedObs.length, 1);

  const admittedScreen = db.prepare('SELECT * FROM sale_watch_transfer_screen WHERE domain=? AND day=?').get('admit.example.com', DAY);
  assert.ok(admittedScreen);
  assert.equal(admittedScreen.admitted, 1);

  const noTransferCandidate = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('notransfer.example.com');
  assert.equal(noTransferCandidate, undefined);
  const noTransferScreen = db.prepare('SELECT * FROM sale_watch_transfer_screen WHERE domain=? AND day=?').get('notransfer.example.com', DAY);
  assert.ok(noTransferScreen);
  assert.equal(noTransferScreen.admitted, 0);
  assert.equal(noTransferScreen.transfer_at, null);
  assert.equal(noTransferScreen.registrar, 'Some Registrar');

  for (const domain of ['existing.example.com', 'departed.example.com', 'sale.xyz', 'cohort01.example.com', 'cohort12.example.com']) {
    const screenRow = db.prepare('SELECT * FROM sale_watch_transfer_screen WHERE domain=? AND day=?').get(domain, DAY);
    assert.equal(screenRow, undefined, `${domain} should be skipped, not checked`);
  }
});

test('screenWentLiveTransfers with limit=1 walks the tape across two calls, exhausted true only once no eligible rows remain', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  const rows = [
    { domain: 'walk-a.example.com', selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', prev_ns: ['ns1.registrar-servers.com'], today_ns: ['ns1.walka.com'], prev_provider: 'Namecheap', today_provider: 'HostWalkA' },
    { domain: 'walk-b.example.com', selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', prev_ns: ['ns1.registrar-servers.com'], today_ns: ['ns1.walkb.com'], prev_provider: 'Namecheap', today_provider: 'HostWalkB' },
  ];
  writeTape(dir, DAY, rows);
  const inspectRdap = async () => ({ checkedAt: new Date().toISOString(), registrar: null, transferAt: null, pendingTransfer: false, events: [], statuses: [] });

  const first = await screenWentLiveTransfers(db, { directory: dir, day: DAY, limit: 1, inspectRdap });
  assert.equal(first.eligible, 2);
  assert.equal(first.checked, 1);
  assert.equal(first.exhausted, false);

  const second = await screenWentLiveTransfers(db, { directory: dir, day: DAY, limit: 1, inspectRdap });
  assert.equal(second.eligible, 1);
  assert.equal(second.checked, 1);
  assert.equal(second.exhausted, true);

  const total = db.prepare('SELECT COUNT(*) AS n FROM sale_watch_transfer_screen WHERE day=?').get(DAY).n;
  assert.equal(total, 2);
});

test('screenWentLiveTransfers counts a single RDAP failure as an error, records the row as checked, and inserts no candidate', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  writeTape(dir, DAY, [
    { domain: 'throws.example.com', selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', prev_ns: ['ns1.registrar-servers.com'], today_ns: ['ns1.throwshost.com'], prev_provider: 'Namecheap', today_provider: 'ThrowsHost' },
  ]);
  const inspectRdap = async () => { throw new Error('rdap unavailable'); };

  const result = await screenWentLiveTransfers(db, { directory: dir, day: DAY, inspectRdap });

  assert.equal(result.checked, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.admitted, 0);

  const screenRow = db.prepare('SELECT * FROM sale_watch_transfer_screen WHERE domain=? AND day=?').get('throws.example.com', DAY);
  assert.ok(screenRow);
  assert.equal(screenRow.admitted, 0);
  assert.equal(screenRow.transfer_at, null);

  const candidate = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('throws.example.com');
  assert.equal(candidate, undefined);
});
