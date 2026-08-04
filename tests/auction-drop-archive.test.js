'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { requiredPageCount, scrapeTLD } = require('../scrapers/namecheap');
const { archiveEndedAuctions, purgeEndedAuctions } = require('../server/auction-cleanup');

function sale(domain, bidCount = 0) {
  return {
    product: { name: domain },
    price: 10,
    endDate: '2026-08-01T00:00:00.000Z',
    bidCount,
  };
}

async function testNamecheapPagination() {
  assert.strictEqual(requiredPageCount(0, 100), 0);
  assert.strictEqual(requiredPageCount(201, 100), 3);
  assert.throws(() => requiredPageCount(-1, 100), /nonnegative integer/);

  const requested = [];
  const items = Array.from({ length: 201 }, (_, index) => sale(`domain-${index}.ai`, index + 1));
  const rows = await scrapeTLD('ai', {
    pageDelayMs: 0,
    fetchPage: async (tld, page, pageSize) => {
      assert.strictEqual(tld, 'ai');
      assert.strictEqual(pageSize, 100);
      requested.push(page);
      return { total: 201, items: items.slice((page - 1) * 100, page * 100) };
    },
  });
  assert.deepStrictEqual(requested, [1, 2, 3]);
  assert.strictEqual(rows.length, 201);
  assert.strictEqual(rows[200].bid_count, 201);

  await assert.rejects(
    scrapeTLD('ai', {
      pageDelayMs: 0,
      fetchPage: async () => ({ total: 2, items: [sale('duplicate.ai', 1), sale('duplicate.ai', 2)] }),
    }),
    /expected 2 unique mapped domains, observed 1/
  );

  let calls = 0;
  await assert.rejects(
    scrapeTLD('ai', {
      pageDelayMs: 0,
      fetchPage: async () => {
        calls += 1;
        if (calls === 2) throw new Error('fixture page failure');
        return { total: 201, items: items.slice(0, 100) };
      },
    }),
    /fixture page failure/
  );
  assert.strictEqual(calls, 2);
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
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM domains').get().count, 5);
  db.close();
}

async function main() {
  await testNamecheapPagination();
  testArchive();
  console.log('auction-drop-archive.test.js: all assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
