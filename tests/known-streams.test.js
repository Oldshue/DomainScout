'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldUseCachedTotal } = require('../server/known-streams');

// Evidence: GET /api/domains?stream=pending-delete answered total 0 and no rows
// while stream=all returned rows whose own stream field is pending-delete. The
// root cause was the handler's fast path trusting a background stats cache
// (activeGroupedStats('stream'), which subtracts inactiveListingWhere() rows)
// that never populates (or zeroes) the pending-delete entry. shouldUseCachedTotal
// is the pure predicate that must reject that zero/missing case so the handler
// falls through to the live COUNT/query path instead of suppressing real rows.

test('shouldUseCachedTotal: false for undefined (missing cache entry)', () => {
  assert.equal(shouldUseCachedTotal(undefined), false);
});

test('shouldUseCachedTotal: false for zero (a derived cache zero must never suppress real rows)', () => {
  assert.equal(shouldUseCachedTotal(0), false);
});

test('shouldUseCachedTotal: false for null', () => {
  assert.equal(shouldUseCachedTotal(null), false);
});

test('shouldUseCachedTotal: false for NaN / non-finite', () => {
  assert.equal(shouldUseCachedTotal(NaN), false);
  assert.equal(shouldUseCachedTotal(Infinity), false);
});

test('shouldUseCachedTotal: false for a negative number', () => {
  assert.equal(shouldUseCachedTotal(-5), false);
});

test('shouldUseCachedTotal: true for a finite positive number', () => {
  assert.equal(shouldUseCachedTotal(1), true);
  assert.equal(shouldUseCachedTotal(42), true);
});

let Database = null;
try {
  // eslint-disable-next-line global-require
  Database = require('better-sqlite3');
} catch (_) {
  Database = null;
}

const maybeTest = Database ? test : test.skip;

maybeTest('knownStreams(db): union includes live domains.stream values plus the static registry streams', () => {
  // eslint-disable-next-line global-require
  const { knownStreams } = require('../server/known-streams');
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE domains (
        id INTEGER PRIMARY KEY,
        domain TEXT,
        stream TEXT
      );
    `);
    db.prepare('INSERT INTO domains (domain, stream) VALUES (?, ?)').run('one.com', 'pending-delete');
    db.prepare('INSERT INTO domains (domain, stream) VALUES (?, ?)').run('two.com', 'pending-delete');
    db.prepare('INSERT INTO domains (domain, stream) VALUES (?, ?)').run('three.com', 'godaddy-closeout');

    const streams = knownStreams(db);
    assert.ok(streams instanceof Set);
    // Live rows from the temp table.
    assert.ok(streams.has('pending-delete'), 'expected pending-delete (2 live rows) in knownStreams');
    assert.ok(streams.has('godaddy-closeout'), 'expected godaddy-closeout (1 live row) in knownStreams');
    // Static registry streams (ACTIVE_AUCTION_STREAMS from server/auction-cleanup.js
    // and STREAM_DESCRIPTORS keys from server/provider-snapshot-registry.js) must be
    // present even though this temp db has no rows for them.
    assert.ok(streams.has('godaddy-auction'), 'expected godaddy-auction from ACTIVE_AUCTION_STREAMS');
    assert.ok(streams.has('namecheap-auction'), 'expected namecheap-auction from ACTIVE_AUCTION_STREAMS/STREAM_DESCRIPTORS');
    assert.ok(streams.has('marketplace'), 'expected marketplace from ACTIVE_AUCTION_STREAMS');
  } finally {
    db.close();
  }
});
