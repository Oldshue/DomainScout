'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ensureReconstructionSchema } = require('../server/sale-watch-reconstruction');
const { rdapSweep } = require('../server/sale-watch-rdap-sweep');

const NOW = new Date('2026-09-16T20:20:00Z');

function buildDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  return db;
}

function insertCandidate(db, overrides = {}) {
  const evidence = overrides.evidence !== undefined ? overrides.evidence : {
    domain: overrides.domain || 'example.com',
    tier: 'suspected',
    sellerNameservers: ['ns1.afternic.com'],
    buyerNameservers: [],
    reportDate: overrides.exit_observed_day || '2026-09-10',
    venue: 'Afternic',
    discovery: {
      structurallyMoved: true,
      departureDate: overrides.exit_observed_day || '2026-09-10',
      movement: { cohortSize: overrides.cohortSize ?? 1, currentClass: 'other' },
    },
  };
  const row = {
    domain: 'example.com',
    first_seen_day: '2026-08-01',
    last_seen_day: '2026-09-10',
    last_stream: 'godaddy-auction',
    last_price: null,
    exit_observed_day: '2026-09-10',
    state: 'exited',
    next_probe_at: '2026-09-10',
    probe_count: 0,
    outcome: null,
    outcome_tier: null,
    evidence_json: JSON.stringify(evidence),
    updated_at: '2026-09-10T00:00:00Z',
    ...overrides,
  };
  delete row.evidence;
  delete row.cohortSize;
  db.prepare(`
    INSERT INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, last_price, exit_observed_day, state, next_probe_at, probe_count, outcome, outcome_tier, evidence_json, updated_at)
    VALUES (@domain, @first_seen_day, @last_seen_day, @last_stream, @last_price, @exit_observed_day, @state, @next_probe_at, @probe_count, @outcome, @outcome_tier, @evidence_json, @updated_at)
  `).run(row);
  return db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get(row.domain);
}

function getRow(db, domain) {
  return db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get(domain);
}

function near(iso, ms, toleranceMs = 5000) {
  return Math.abs(Date.parse(iso) - ms) < toleranceMs;
}

test('(a) transfer 5 days before exit, small cohort -> promoted for immediate full probe', async () => {
  const db = buildDb();
  insertCandidate(db, { domain: 'a.com', exit_observed_day: '2026-09-10', cohortSize: 3 });
  const inspectRdap = async () => ({
    transferAt: '2026-09-05T00:00:00Z', pendingTransfer: false, registrar: 'Example Registrar',
    registrarId: '1234', statuses: [], events: [], checkedAt: '2026-09-16T20:20:00Z',
  });
  const result = await rdapSweep(db, { now: NOW, inspectRdap });
  assert.deepEqual(result, { scanned: 1, checked: 1, transfers: 1, pending: 0, expirations: 0, deferred: 0, errors: 0, ms: result.ms });
  const row = getRow(db, 'a.com');
  assert.equal(row.probe_priority, 1);
  assert.ok(near(row.next_probe_at, NOW.getTime()), 'next_probe_at is ~now');
  const evidence = JSON.parse(row.evidence_json);
  assert.equal(evidence.discovery.rdap.registrar, 'Example Registrar');
  assert.deepEqual(evidence.discovery.transferEvidence, {
    transferAt: '2026-09-05T00:00:00Z', pendingTransfer: false, registrarChanged: false,
    observedAt: '2026-09-16T20:20:00Z', toRegistrar: 'Example Registrar',
  });
  const observations = db.prepare("SELECT * FROM sale_watch_observations WHERE domain=? AND kind='rdap'").all('a.com');
  assert.equal(observations.length, 1);
});

test('(b) large cohort (>=100), no transfer -> deferred to exit+14 off-market check', async () => {
  const db = buildDb();
  insertCandidate(db, { domain: 'b.com', exit_observed_day: '2026-09-10', cohortSize: 500 });
  const inspectRdap = async () => ({
    transferAt: null, pendingTransfer: false, registrar: null, registrarId: null,
    statuses: [], events: [], checkedAt: '2026-09-16T20:20:00Z',
  });
  const result = await rdapSweep(db, { now: NOW, inspectRdap });
  assert.equal(result.deferred, 1);
  assert.equal(result.transfers, 0);
  assert.equal(result.pending, 0);
  const row = getRow(db, 'b.com');
  assert.equal(row.probe_priority, 4);
  assert.equal(row.next_probe_at, '2026-09-24');
});

test('(c) small cohort, no transfer -> next_probe_at/probe_priority left untouched', async () => {
  const db = buildDb();
  insertCandidate(db, { domain: 'c.com', exit_observed_day: '2026-09-10', cohortSize: 2, next_probe_at: '2026-09-10T00:00:00Z' });
  const before = getRow(db, 'c.com');
  const inspectRdap = async () => ({
    transferAt: null, pendingTransfer: false, registrar: null, registrarId: null,
    statuses: [], events: [], checkedAt: '2026-09-16T20:20:00Z',
  });
  const result = await rdapSweep(db, { now: NOW, inspectRdap });
  assert.equal(result.deferred, 0);
  assert.equal(result.transfers, 0);
  const row = getRow(db, 'c.com');
  assert.equal(row.next_probe_at, before.next_probe_at);
  assert.equal(row.probe_priority, before.probe_priority);
});

test('(d) pendingTransfer true -> promoted for immediate full probe', async () => {
  const db = buildDb();
  insertCandidate(db, { domain: 'd.com', exit_observed_day: '2026-09-10', cohortSize: 1 });
  const inspectRdap = async () => ({
    transferAt: null, pendingTransfer: true, registrar: 'Other Registrar', registrarId: null,
    statuses: ['pendingTransfer'], events: [], checkedAt: '2026-09-16T20:20:00Z',
  });
  const result = await rdapSweep(db, { now: NOW, inspectRdap });
  assert.equal(result.pending, 1);
  const row = getRow(db, 'd.com');
  assert.equal(row.probe_priority, 1);
  assert.ok(near(row.next_probe_at, NOW.getTime()));
});

test('(e) redemptionPeriod status -> parked-watch/expiration/+45d', async () => {
  const db = buildDb();
  insertCandidate(db, { domain: 'e.com', exit_observed_day: '2026-09-10', cohortSize: 1 });
  const inspectRdap = async () => ({
    transferAt: null, pendingTransfer: false, registrar: null, registrarId: null,
    statuses: ['redemptionPeriod'], events: [], checkedAt: '2026-09-16T20:20:00Z',
  });
  const result = await rdapSweep(db, { now: NOW, inspectRdap });
  assert.equal(result.expirations, 1);
  const row = getRow(db, 'e.com');
  assert.equal(row.state, 'parked-watch');
  assert.equal(row.outcome, 'expiration');
  assert.equal(row.probe_priority, 5);
  assert.ok(near(row.next_probe_at, NOW.getTime() + 45 * 86400000));
});

test('(f) inspectRdap throws -> errors 1, rdap error stored, row excluded from a second sweep', async () => {
  const db = buildDb();
  insertCandidate(db, { domain: 'f.com', exit_observed_day: '2026-09-10', cohortSize: 1 });
  const inspectRdap = async () => { throw new Error('registry unreachable'); };
  const result = await rdapSweep(db, { now: NOW, inspectRdap });
  assert.equal(result.errors, 1);
  assert.equal(result.scanned, 1);
  const row = getRow(db, 'f.com');
  const evidence = JSON.parse(row.evidence_json);
  assert.equal(evidence.discovery.rdap.error, 'registry unreachable');
  assert.ok(evidence.discovery.rdap.checkedAt);

  const second = await rdapSweep(db, { now: NOW, inspectRdap: async () => { throw new Error('should not be called'); } });
  assert.equal(second.scanned, 0);
});

test('(g) probe_count 1 is excluded from the population', async () => {
  const db = buildDb();
  insertCandidate(db, { domain: 'g.com', exit_observed_day: '2026-09-10', cohortSize: 1, probe_count: 1 });
  const inspectRdap = async () => { throw new Error('should not be called'); };
  const result = await rdapSweep(db, { now: NOW, inspectRdap });
  assert.equal(result.scanned, 0);
});

test('(h) limit walks the population in exit-day-desc, domain-asc order across bounded calls', async () => {
  const db = buildDb();
  insertCandidate(db, { domain: 'h1.com', exit_observed_day: '2026-09-08', cohortSize: 1 });
  insertCandidate(db, { domain: 'h2.com', exit_observed_day: '2026-09-10', cohortSize: 1 });
  insertCandidate(db, { domain: 'h3.com', exit_observed_day: '2026-09-09', cohortSize: 1 });
  const seen = [];
  const inspectRdap = async (domain) => {
    seen.push(domain);
    return { transferAt: null, pendingTransfer: false, registrar: null, registrarId: null, statuses: [], events: [], checkedAt: '2026-09-16T20:20:00Z' };
  };
  const first = await rdapSweep(db, { now: NOW, inspectRdap, limit: 2 });
  assert.equal(first.scanned, 2);
  assert.deepEqual(seen.slice().sort(), ['h2.com', 'h3.com'].sort());

  const second = await rdapSweep(db, { now: NOW, inspectRdap, limit: 2 });
  assert.equal(second.scanned, 1);
  assert.equal(seen[seen.length - 1], 'h1.com');
});
