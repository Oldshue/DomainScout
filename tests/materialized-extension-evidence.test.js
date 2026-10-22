'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  normalizeLogicalTld,
  parseEvidenceRequest,
  parseIndexedPositiveObservations,
  parseRegistryWhoisReceipts,
  persistRegistrarEvidence,
  readPositiveExtensionEvidence,
} = require('../server/materialized-extension-evidence');

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sibling_tld_status (
      base_name TEXT NOT NULL, tld TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, checked_at TEXT NOT NULL,
      PRIMARY KEY (base_name, tld)
    ) WITHOUT ROWID;
    CREATE TABLE cctld_taken_idx (
      tld TEXT NOT NULL, base_name TEXT NOT NULL,
      PRIMARY KEY (tld, base_name)
    ) WITHOUT ROWID;
  `);
  return db;
}

test('logical suffix normalization preserves multi-label public suffixes', () => {
  assert.equal(normalizeLogicalTld('co.uk'), '.co.uk');
  assert.equal(normalizeLogicalTld('.CO.KR'), '.co.kr');
  assert.equal(normalizeLogicalTld('co..uk'), null);
});

test('evidence requests are generic, bounded, and reject duplicate cells', () => {
  assert.deepEqual(parseEvidenceRequest({ baseNames: ['agentwall', 'orchard'], tlds: ['com', 'co.uk'] }), {
    baseNames: ['agentwall', 'orchard'], tlds: ['.com', '.co.uk'],
  });
  assert.match(parseEvidenceRequest({ baseNames: ['orchard'], tlds: ['ai', '.ai'] }).error, /unique/);
  assert.match(parseEvidenceRequest({ baseNames: ['orchard'], tlds: ['co..uk'] }).error, /valid/);
});

test('registrar reconciliation persists exact positives and negatives and materializes only fresh positives', () => {
  const db = fixtureDb();
  const request = { baseNames: ['agentwall', 'orchard'], tlds: ['.com', '.co.uk'] };
  const rows = persistRegistrarEvidence(db, request, [
    { domain: 'agentwall.com', status: 'registered' },
    { domain: 'agentwall.co.uk', status: 'registered' },
    { domain: 'orchard.com', status: 'available' },
    { domain: 'orchard.co.uk', status: 'unknown' },
    { domain: 'not-requested.com', status: 'registered' },
  ], '2026-10-21T12:00:00.000Z');
  assert.equal(rows.length, 3);
  assert.deepEqual(db.prepare('SELECT tld, base_name FROM cctld_taken_idx ORDER BY tld').all(), [
    { tld: '.co.uk', base_name: 'agentwall' },
    { tld: '.com', base_name: 'agentwall' },
  ]);

  db.prepare("UPDATE sibling_tld_status SET checked_at='2025-01-01T00:00:00.000Z' WHERE base_name='agentwall' AND tld='.com'").run();
  const evidence = readPositiveExtensionEvidence(db, ['agentwall', 'orchard'], { maxAgeHours: 24 * 30 });
  assert.deepEqual(evidence.get('agentwall').map(item => item.tld), ['.co.uk']);
  assert.equal(evidence.has('orchard'), false);
  db.close();
});

test('hashed registry WHOIS receipts are bounded to the requested matrix', () => {
  const request = { baseNames: ['agentwall'], tlds: ['.com', '.co.uk'] };
  const receipt = {
    domain: 'agentwall.co.uk', status: 'registered', server: 'whois.nic.uk',
    source: 'registry-whois:whois.nic.uk', checkedAt: '2026-10-22T00:00:00Z',
    bytes: 123, sha256: 'a'.repeat(64),
  };
  const valid = parseRegistryWhoisReceipts({ receipts: [receipt] }, request, { now: Date.parse('2026-10-22T01:00:00Z') });
  assert.equal(valid.rows.length, 1);
  assert.match(parseRegistryWhoisReceipts({ receipts: [{ ...receipt, domain: 'other.co.uk' }] }, request, { now: Date.parse('2026-10-22T01:00:00Z') }).error, /outside/);
});

test('indexed observations are positive-only, fresh, and source typed', () => {
  const request = { baseNames: ['agentwall'], tlds: ['.dev'] };
  const observation = { domain: 'agentwall.dev', status: 'registered', source: 'https://index.example/search?q=agentwall', checkedAt: '2026-10-22T00:00:00Z' };
  const valid = parseIndexedPositiveObservations({ observations: [observation] }, request, { now: Date.parse('2026-10-22T01:00:00Z') });
  assert.equal(valid.rows[0].source, 'indexed-observation:index.example');
  assert.match(parseIndexedPositiveObservations({ observations: [{ ...observation, status: 'available' }] }, request, { now: Date.parse('2026-10-22T01:00:00Z') }).error, /only registered/);
});
