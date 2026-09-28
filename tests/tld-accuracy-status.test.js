'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { buildTldAccuracyStatus } = require('../server/tld-accuracy-status');

const universe = {
  id: 'iana-root-tlds', version: 'v-test', count: 3, authoritative: true,
  tlds: ['.com', '.net', '.io'], indexedTlds: ['.net'], dnsTlds: ['.com', '.io'],
};

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE domains (base_name TEXT, stream TEXT, auction_end TEXT);
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY, count INTEGER, taken_json TEXT, all_count INTEGER, source TEXT, checked_at TEXT,
      universe_id TEXT, universe_version TEXT, checked_count INTEGER, total_count INTEGER, completed_at TEXT,
      coverage_status TEXT, evidence_json TEXT, failures_json TEXT
    );
  `);
  return db;
}

function receipt(db, base, { complete = true, failures = '[]', version = universe.version } = {}) {
  db.prepare(`INSERT INTO tld_check_cache VALUES (?, 1, '[".net"]', 3, 's', 'now', ?, ?, ?, 3, 'now', ?, '[]', ?)`)
    .run(base, universe.id, version, complete ? 3 : 2, complete ? 'complete' : 'partial', failures);
}

test('per-stream totals include snapshot-only closeout rows and dedupe against domains', () => {
  const db = fixtureDb();
  const future = '2999-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO domains VALUES (?, ?, ?)').run('alpha', 'godaddy-auction', future);
  db.prepare('INSERT INTO domains VALUES (?, ?, ?)').run('beta', 'godaddy-auction', future);
  db.prepare('INSERT INTO domains VALUES (?, ?, ?)').run('ended', 'godaddy-auction', '2000-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO domains VALUES (?, ?, ?)').run('gamma', 'godaddy-closeout', null);
  receipt(db, 'alpha');
  receipt(db, 'gamma');
  receipt(db, 'delta');
  receipt(db, 'partial', { complete: false });
  receipt(db, 'failed', { failures: '[{"tld":".io"}]' });
  receipt(db, 'oldversion', { version: 'old' });

  const snapshots = {
    'godaddy-closeout': { rows: [
      { domain: 'gamma.com', auction_end: null },      // already in domains → counted once
      { domain: 'delta.com', auction_end: null },      // verified
      { domain: 'partial.com', auction_end: null },    // not verified
      { domain: 'failed.com', auction_end: null },     // not verified (failures)
      { domain: 'oldversion.com', auction_end: null }, // not verified (stale universe)
    ] },
    'godaddy-auction': null,
  };
  const released = [];
  const status = buildTldAccuracyStatus({
    database: db, universe,
    readSnapshotIndex: stream => snapshots[stream],
    releaseSnapshotIndex: stream => released.push(stream),
    zoneTruth: { source: 'universe-summary', asOf: '2026-09-28', exactForAbsentLabels: true, anchorTlds: ['.com'], zoneTldSet: () => new Set(['.com', '.net']) },
  });

  assert.deepEqual(status.streams['godaddy-auction'], { total: 2, verified: 1, remaining: 1, sources: ['domains'] });
  assert.equal(status.streams['godaddy-closeout'].total, 5);
  assert.equal(status.streams['godaddy-closeout'].verified, 2);
  assert.equal(status.streams['godaddy-closeout'].remaining, 3);
  assert.deepEqual(status.streams['godaddy-closeout'].sources, ['domains', 'snapshot']);
  assert.equal(status.streams['godaddy-closeout'].snapshotRows, 5);
  assert.equal(status.streams['namecheap-auction'].total, 0);
  assert.equal(status.total, 7);
  assert.equal(status.verified, 3);
  assert.equal(status.remaining, 4);
  assert.deepEqual(released, ['godaddy-closeout']);
  assert.deepEqual(status.zoneTruth, {
    source: 'universe-summary', asOf: '2026-09-28', zoneTlds: 2, exactForAbsentLabels: true,
    anchorTlds: ['.com'], indexedCount: 1, dnsCount: 2,
  });
  db.close();
});

test('snapshot read failures are reported, never counted as verified', () => {
  const db = fixtureDb();
  const status = buildTldAccuracyStatus({
    database: db, universe,
    readSnapshotIndex: () => { throw new Error('boom'); },
  });
  assert.equal(status.total, 0);
  assert.equal(status.snapshotErrors.length, 2);
  assert.match(status.snapshotErrors[0].error, /boom/);
  db.close();
});
