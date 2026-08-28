'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { scrapeNamecheap, validateSnapshot } = require('../scrapers/namecheap');
const { activeAuctionWhere, archiveEndedAuctions, purgeEndedAuctions } = require('../server/auction-cleanup');

function sale(domain, bidCount = 0) {
  return {
    name: domain,
    status: 'active',
    saleType: 'auction',
    price: 10,
    endDate: '2999-08-01T00:00:00.000Z',
    bidCount,
  };
}

async function testNamecheapPagination() {
  const cursors = [];
  const rows = await scrapeNamecheap({
    apiKey: 'fixture-only',
    pageSize: 2,
    minRows: 3,
    fetchPage: async ({ cursor, pageSize }) => {
      assert.strictEqual(pageSize, 2);
      cursors.push(cursor);
      if (!cursor) return { items: [sale('one.ai', 1), sale('two.com', 2)], hasMore: true, nextCursor: 'page-2' };
      return { items: [sale('three.org', 3)], hasMore: false, nextCursor: null };
    },
  });
  assert.deepStrictEqual(cursors, [null, 'page-2']);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[2].bid_count, 3);
  assert.strictEqual(rows.snapshotEvidence.pages, 2);

  const terminalSnapshot = await scrapeNamecheap({
    apiKey: 'fixture-only',
    minRows: 1,
    nowMs: Date.parse('3000-01-01T00:00:00.000Z'),
    fetchPage: async () => ({
      items: [
        { ...sale('elapsed-during-pagination.com'), endDate: '2999-12-31T23:59:59.000Z' },
        { ...sale('still-current.com'), endDate: '3000-01-01T00:00:01.000Z' },
      ],
      hasMore: false,
    }),
  });
  assert.deepStrictEqual(terminalSnapshot.map(row => row.domain), ['still-current.com']);
  assert.strictEqual(terminalSnapshot.snapshotEvidence.futureRows, 1);

  await assert.rejects(
    scrapeNamecheap({
      apiKey: 'fixture-only',
      minRows: 2,
      fetchPage: async () => ({ items: [sale('duplicate.ai', 1), sale('duplicate.ai', 2)], hasMore: false }),
    }),
    /invalid or duplicate/
  );

  await assert.rejects(
    scrapeNamecheap({
      apiKey: 'fixture-only',
      minRows: 1,
      fetchPage: async () => ({ items: [sale('one.ai')], hasMore: true, nextCursor: null }),
    }),
    /cursor pagination did not advance/
  );

  // The shared validator is provider-neutral: an unrelated ticket inventory
  // fixture receives the same completeness/identity protection.
  const unrelated = validateSnapshot([
    { domain: 'ticket-1.example', auction_end: '2999-01-01T00:00:00.000Z' },
    { domain: 'ticket-2.example', auction_end: '2999-01-01T00:00:00.000Z' },
  ], { minRows: 2, nowMs: Date.parse('2026-01-01T00:00:00.000Z') });
  assert.strictEqual(unrelated.ok, true);
}

function createArchiveDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE domains (
      domain TEXT NOT NULL, base_name TEXT, tld TEXT NOT NULL, stream TEXT NOT NULL,
      source TEXT, status TEXT DEFAULT 'active', auction_end TEXT,
      discovered_at TEXT, bid_count INTEGER DEFAULT 0
    );
    CREATE TABLE drop_events (
      domain TEXT NOT NULL, base_name TEXT NOT NULL, tld TEXT NOT NULL,
      source TEXT NOT NULL, source_kind TEXT NOT NULL, source_event_at TEXT NOT NULL,
      prior_registered_evidence TEXT NOT NULL, released_at TEXT,
      registration_available INTEGER, availability_source TEXT,
      availability_checked_at TEXT, observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (domain, source, source_event_at)
    ) WITHOUT ROWID;
  `);
  const add = db.prepare(`
    INSERT INTO domains
      (domain, base_name, tld, stream, source, status, auction_end, discovered_at, bid_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  add.run('ended.ai', null, '.ai', 'namecheap-auction', 'Namecheap', 'active', '2000-01-01T00:00:00.000Z', '1999-12-01T00:00:00.000Z', 7);
  add.run('unrelated.sh', 'unrelated', '.sh', 'godaddy-auction', null, 'active', '2000-01-02T00:00:00.000Z', null, null);
  add.run('active.ai', 'active', '.ai', 'namecheap-auction', 'Namecheap', 'active', '2999-01-01T00:00:00.000Z', null, 3);
  add.run('pending.ai', 'pending', '.ai', 'namecheap-auction', 'Namecheap', 'pending-delete', '2000-01-03T00:00:00.000Z', null, 1);
  add.run('other.ai', 'other', '.ai', 'just-dropped', 'fixture', 'active', '2000-01-04T00:00:00.000Z', null, 0);
  add.run('sold-market.ai', 'sold-market', '.ai', 'marketplace', 'auction fixture', 'active', '2000-01-05T00:00:00.000Z', null, 2);
  add.run('live-market.ai', 'live-market', '.ai', 'marketplace', 'auction fixture', 'active', '2999-01-05T00:00:00.000Z', null, 1);
  add.run('fixed-price-market.ai', 'fixed-price-market', '.ai', 'marketplace', 'fixed-price fixture', 'active', null, null, 0);
  return db;
}

function testArchive() {
  const db = createArchiveDb();
  assert.strictEqual(archiveEndedAuctions(db), 2);
  assert.strictEqual(archiveEndedAuctions(db), 0);
  assert.strictEqual(purgeEndedAuctions(db), 0);

  const rows = db.prepare('SELECT * FROM drop_events ORDER BY domain').all();
  assert.deepStrictEqual(rows.map(row => row.domain), ['ended.ai', 'unrelated.sh']);
  assert.strictEqual(rows[0].base_name, 'ended');
  assert.strictEqual(rows[0].source, 'auction:namecheap-auction');
  assert.strictEqual(rows[0].source_kind, 'expired-auction-ended');
  assert.strictEqual(rows[0].released_at, null);
  assert.strictEqual(rows[0].registration_available, null);
  assert.deepStrictEqual(JSON.parse(rows[0].prior_registered_evidence), {
    stream: 'namecheap-auction',
    source: 'Namecheap',
    auction_end: '2000-01-01T00:00:00.000Z',
    discovered_at: '1999-12-01T00:00:00.000Z',
    bid_count: 7,
  });
  assert.deepStrictEqual(JSON.parse(rows[1].prior_registered_evidence), {
    stream: 'godaddy-auction',
    source: null,
    auction_end: '2000-01-02T00:00:00.000Z',
    discovered_at: null,
    bid_count: 0,
  });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM domains').get().count, 8);
  assert.deepStrictEqual(
    db.prepare(`SELECT domain FROM domains WHERE ${activeAuctionWhere()} ORDER BY domain`).all().map(row => row.domain),
    ['active.ai', 'fixed-price-market.ai', 'live-market.ai', 'other.ai']
  );
  db.close();
}

function testArchiveDoesNotMaterializeCandidates() {
  const db = createArchiveDb();
  const add = db.prepare(`
    INSERT INTO domains
      (domain, base_name, tld, stream, source, status, auction_end, discovered_at, bid_count)
    VALUES (?, ?, '.ai', 'namecheap-auction', 'Namecheap', 'active',
      '2000-02-01T00:00:00.000Z', NULL, ?)
  `);
  const fixtureSize = 5000;
  db.transaction(() => {
    for (let index = 0; index < fixtureSize; index += 1) {
      add.run(`large-${index}.ai`, `large-${index}`, index);
    }
  })();

  const originalPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (/FROM\s+domains(?:\s+AS\s+\w+)?/i.test(sql)) {
      statement.all = () => {
        throw new Error('archive candidates must not be materialized with Statement#all');
      };
    }
    return statement;
  };

  assert.strictEqual(archiveEndedAuctions(db), fixtureSize + 2);
  assert.strictEqual(archiveEndedAuctions(db), 0);
  assert.strictEqual(
    originalPrepare('SELECT COUNT(*) AS count FROM drop_events').get().count,
    fixtureSize + 2
  );
  assert.strictEqual(originalPrepare('SELECT COUNT(*) AS count FROM domains').get().count, fixtureSize + 8);
  db.close();
}

async function main() {
  await testNamecheapPagination();
  testArchive();
  testArchiveDoesNotMaterializeCandidates();
  console.log('auction-drop-archive.test.js: all assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
