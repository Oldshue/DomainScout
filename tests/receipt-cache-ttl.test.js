'use strict';

// Label-level receipt cache: a verified per-extension result (positive or
// negative) is reused by every view for the TTL; only expired extensions are
// re-probed; a row is exact only once every extension has a receipt, and the
// exact count is recomputed the moment the last missing extension lands.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  createNameverseCoverageProducer,
  decodeCheckedWaves,
  encodeCheckedWaves,
  projectCoverageReceipt,
} = require('../server/nameverse-coverage');

const DAY = 24 * 60 * 60 * 1000;
const universe = { id: 'iana-root-tlds', version: 'ttl-v1', authoritative: true, tlds: ['.com', '.io', '.net'] };

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE domains (base_name TEXT, stream TEXT, tlds_taken INTEGER, tlds_checked_at TEXT);
    CREATE TABLE base_tld_counts (base_name TEXT PRIMARY KEY, tld_count INTEGER, source TEXT, updated_at TEXT);
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY, count INTEGER NOT NULL, taken_json TEXT NOT NULL,
      all_count INTEGER NOT NULL, source TEXT, checked_at TEXT
    );
  `);
  db.prepare(`INSERT INTO domains VALUES ('widget','godaddy-auction',NULL,NULL)`).run();
  db.prepare(`INSERT INTO domains VALUES ('widget','godaddy-closeout',NULL,NULL)`).run();
  return db;
}

function harness(answers, ttlMs) {
  const db = fixtureDb();
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  const calls = [];
  const producer = createNameverseCoverageProducer({
    database: db,
    resolver: async domain => { calls.push(domain); return answers(domain); },
    now: () => new Date(clock),
    ttlMs,
  });
  return { db, producer, calls, advance: ms => { clock += ms; }, nowIso: () => new Date(clock).toISOString() };
}

test('a complete receipt is reused by every later view within the TTL and re-probed after it', async () => {
  const h = harness(d => (d.endsWith('.io') ? 'taken' : 'not_taken'));
  const first = await h.producer.refreshBaseName('widget', universe);
  assert.equal(first.status, 'complete');
  assert.equal(first.count, 1);
  assert.equal(h.calls.length, 3, 'first refresh probes every extension');
  assert.equal(first.cache.probed, 3);

  // Auctions, research and taken-in all ask again over the next six days: zero probes.
  for (const day of [1, 3, 6]) {
    h.advance(DAY * (day === 1 ? 1 : 2) + (day === 6 ? DAY : 0) - (day === 6 ? DAY : 0));
    const again = await h.producer.refreshBaseName('widget', universe);
    assert.equal(again.status, 'complete');
    assert.equal(again.count, 1);
    assert.equal(again.cache.reusedFrom, 'receipt');
    assert.equal(again.cache.probed, 0, `day ${day}: nothing re-probed inside the TTL`);
  }
  assert.equal(h.calls.length, 3);
  const row = h.db.prepare(`SELECT * FROM tld_check_cache WHERE base_name='widget'`).get();
  assert.equal(row.completed_at, '2026-09-01T00:00:00.000Z', 'a reused receipt is as fresh as its oldest extension');
  assert.equal(projectCoverageReceipt(row, universe, { now: new Date('2026-09-06T00:00:00.000Z') }).verified, true);

  // Past the 7-day default TTL every extension expires and is re-probed.
  h.advance(DAY * 3);
  const expired = await h.producer.refreshBaseName('widget', universe);
  assert.equal(expired.cache.expired, 3);
  assert.equal(expired.cache.probed, 3);
  assert.equal(h.calls.length, 6);
  h.db.close();
});

test('a row is exact only when every extension has a receipt, and recomputes when the last one lands', async () => {
  let ioAnswer = 'unknown';
  const h = harness(d => (d.endsWith('.io') ? ioAnswer : (d.endsWith('.com') ? 'taken' : 'not_taken')));
  const partial = await h.producer.refreshBaseName('widget', universe);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.checkedCount, 2);
  assert.deepEqual(partial.failures.map(f => f.tld), ['.io']);
  const cached = h.db.prepare(`SELECT * FROM tld_check_cache WHERE base_name='widget'`).get();
  assert.equal(cached, undefined, 'no receipt is published while an extension is still missing');
  const projected = projectCoverageReceipt(cached, universe, { now: new Date(h.nowIso()) });
  assert.equal(projected.verified, false);
  assert.equal(projected.extensions, null, 'PENDING: never a number, never a lower bound as the count');
  assert.deepEqual(h.db.prepare(`SELECT tlds_taken FROM domains WHERE base_name='widget'`).all(), [{ tlds_taken: null }, { tlds_taken: null }]);

  // Only the missing extension is probed on the next pass; the two definite
  // results are reused from progress. When .io lands the row becomes exact.
  ioAnswer = 'taken';
  h.advance(60 * 1000);
  const before = h.calls.length;
  const complete = await h.producer.refreshBaseName('widget', universe);
  assert.equal(h.calls.length - before, 1, 'only the missing extension is probed');
  assert.equal(complete.cache.reusedFrom, 'progress');
  assert.equal(complete.status, 'complete');
  assert.equal(complete.count, 2);
  const row = h.db.prepare(`SELECT * FROM tld_check_cache WHERE base_name='widget'`).get();
  const exact = projectCoverageReceipt(row, universe, { now: new Date(h.nowIso()) });
  assert.equal(exact.verified, true);
  assert.equal(exact.extensions, 2);
  assert.deepEqual(h.db.prepare(`SELECT stream, tlds_taken FROM domains WHERE base_name='widget' ORDER BY stream`).all(),
    [{ stream: 'godaddy-auction', tlds_taken: 2 }, { stream: 'godaddy-closeout', tlds_taken: 2 }],
    'every stream row for the label gets the same exact count');
  h.db.close();
});

test('zone seeds are exact truth and override a cached DNS observation for the same extension', async () => {
  const h = harness(() => 'not_taken');
  await h.producer.refreshBaseName('widget', universe);
  h.advance(DAY);
  const seeded = await h.producer.refreshBaseName('widget', universe, [
    { tld: '.net', status: 'taken', source: 'validated-universe-summary' },
  ]);
  assert.equal(seeded.status, 'complete');
  assert.equal(seeded.count, 1);
  assert.equal(seeded.cache.probed, 0);
  assert.deepEqual(seeded.positives.map(p => [p.tld, p.source]), [['.net', 'validated-universe-summary']]);
  h.db.close();
});

test('a configured TTL is honoured per extension', async () => {
  const h = harness(() => 'not_taken', 2 * DAY);
  await h.producer.refreshBaseName('widget', universe);
  h.advance(DAY);
  assert.equal((await h.producer.refreshBaseName('widget', universe)).cache.probed, 0);
  h.advance(DAY + 1000);
  assert.equal((await h.producer.refreshBaseName('widget', universe)).cache.probed, 3);
  h.db.close();
});

test('checked waves round-trip per-extension times compactly', () => {
  const tlds = ['.a', '.b', '.c', '.d'];
  const times = new Map([['.a', 1000], ['.b', 2000], ['.c', 1000]]);
  const json = encodeCheckedWaves(times, tlds);
  assert.ok(json.length < 80, `compact encoding, got ${json.length} bytes`);
  const back = decodeCheckedWaves(json, tlds);
  assert.deepEqual([...back].sort(), [['.a', 1000], ['.b', 2000], ['.c', 1000]]);
  assert.equal(decodeCheckedWaves('not json', tlds).size, 0);
});

test('an incomplete label yields its queue position without dropping pending work', () => {
  const { deferNameverseRefresh } = require('../server/nameverse-coverage');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE tld_work_queue (base_name TEXT PRIMARY KEY, ord INTEGER)');
  db.exec("INSERT INTO tld_work_queue VALUES ('unreachable', -1), ('auction', 0), ('closeout', 1)");
  deferNameverseRefresh(db, 'unreachable');
  assert.deepEqual(db.prepare('SELECT base_name FROM tld_work_queue ORDER BY ord').all().map(r => r.base_name), ['auction', 'closeout', 'unreachable']);
  db.close();
});
