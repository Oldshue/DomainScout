'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { hydrateProviderExtensionEvidence } = require('../server/provider-extension-evidence');
const { rowMatchesQuery } = require('../server/godaddy-query');

test('provider snapshots receive truthful exact and lower-bound extension evidence', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE base_tld_counts (base_name TEXT PRIMARY KEY, tld_count INTEGER);
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY, count INTEGER, taken_json TEXT, all_count INTEGER,
      source TEXT, checked_at TEXT, universe_id TEXT, universe_version TEXT,
      checked_count INTEGER, total_count INTEGER, completed_at TEXT,
      coverage_status TEXT, evidence_json TEXT, failures_json TEXT
    );
    INSERT INTO base_tld_counts VALUES ('lower', 3), ('exact', 7);
    INSERT INTO tld_check_cache VALUES
      ('exact', 7, '[".com"]', 100, 'fixture', '2026-08-18T00:00:00Z',
       'iana', 'v1', 100, 100, '2026-08-18T00:00:00Z', 'complete', '{}', '[]');
  `);
  // Unrelated provider fixture proves this is not hard-coded to GoDaddy.
  const rows = [
    { domain: 'lower.shop', tld: '.shop', stream: 'warehouse-market', tlds_taken: null },
    { domain: 'exact.dev', tld: '.dev', stream: 'warehouse-market', tlds_taken: null },
    { domain: 'sourceonly.net', tld: '.net', stream: 'warehouse-market', tlds_taken: null },
  ];
  const universe = { authoritative: true, id: 'iana', version: 'v1', tlds: Array.from({ length: 100 }, (_, index) => `.t${index}`), count: 100 };
  hydrateProviderExtensionEvidence(db, rows, universe, {
    now: new Date('2026-08-18T01:00:00Z'),
  });
  assert.deepEqual(rows.map(row => [row.tlds_taken, row.tlds_lower_bound, row.tlds_verified]), [
    [null, 3, false], [7, null, true], [null, 1, false],
  ]);
  assert.equal(rowMatchesQuery(rows[0], { minTlds: '3' }), true);
  assert.equal(rowMatchesQuery(rows[2], { minTlds: '3' }), false);
  assert.equal(rowMatchesQuery(rows[0], { maxTlds: '3' }), false, 'a lower bound cannot prove an upper bound');
  assert.equal(rowMatchesQuery(rows[1], { maxTlds: '7' }), true);
  db.close();
});

test('stale or timestamp-less complete receipts remain lower bounds', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE base_tld_counts (base_name TEXT PRIMARY KEY, tld_count INTEGER);
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY, count INTEGER, taken_json TEXT, all_count INTEGER,
      source TEXT, checked_at TEXT, universe_id TEXT, universe_version TEXT,
      checked_count INTEGER, total_count INTEGER, completed_at TEXT,
      coverage_status TEXT, evidence_json TEXT, failures_json TEXT
    );
    INSERT INTO base_tld_counts VALUES ('stale', 5), ('missingtime', 4);
    INSERT INTO tld_check_cache VALUES
      ('stale', 5, '[".com"]', 100, 'fixture', NULL, 'iana', 'v1', 100, 100,
       '2026-08-01T00:00:00Z', 'complete', '{}', '[]'),
      ('missingtime', 4, '[".net"]', 100, 'fixture', NULL, 'iana', 'v1', 100, 100,
       NULL, 'complete', '{}', '[]');
  `);
  const rows = [
    { domain: 'stale.com', tld: '.com' },
    { domain: 'missingtime.net', tld: '.net' },
  ];
  const universe = { authoritative: true, id: 'iana', version: 'v1', tlds: Array.from({ length: 100 }, (_, index) => `.t${index}`), count: 100 };
  hydrateProviderExtensionEvidence(db, rows, universe, {
    now: new Date('2026-08-18T01:00:00Z'), maxAgeMs: 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(rows.map(row => [row.tlds_taken, row.tlds_lower_bound, row.tlds_verified]), [
    [null, 5, false], [null, 4, false],
  ]);
  db.close();
});

test('large provider projection uses the covering count index without random receipt probes', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE base_tld_counts (base_name TEXT PRIMARY KEY, tld_count INTEGER);
    CREATE INDEX idx_base_tld_counts_count ON base_tld_counts(tld_count DESC, base_name);
    CREATE TABLE tld_check_cache (base_name TEXT PRIMARY KEY);
    INSERT INTO base_tld_counts VALUES ('three', 3), ('one', 1), ('unrelated', 9);
  `);
  const rows = [
    { domain: 'three.com', tld: '.com' },
    { domain: 'one.shop', tld: '.shop' },
    { domain: 'preserved.dev', tld: '.dev', tlds_taken: 7, tlds_verified: true },
  ];
  hydrateProviderExtensionEvidence(db, rows, { authoritative: false }, { scanThreshold: 2 });
  assert.deepEqual(rows.map(row => row.tlds_lower_bound), [3, 1, 7]);
  hydrateProviderExtensionEvidence(db, rows, { authoritative: false }, { scanThreshold: 2 });
  assert.deepEqual(rows.map(row => row.tlds_lower_bound), [3, 1, 7], 'large projection is idempotent');
  assert.equal(rowMatchesQuery(rows[0], { minTlds: '3' }), true);
  assert.equal(rowMatchesQuery(rows[1], { minTlds: '3' }), false);
  db.close();
});
