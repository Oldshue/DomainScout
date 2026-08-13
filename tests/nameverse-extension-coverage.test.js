'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const {
  createNameverseCoverageProducer,
  ensureNameverseCoverageSchema,
  projectCoverageReceipt,
} = require('../server/nameverse-coverage');

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
  return db;
}

const universe = {
  id: 'iana-root-tlds', version: 'fixture-v1', authoritative: true,
  tlds: ['.com', '.net', '.shop'],
};

test('legacy rows migrate partial and fail closed', () => {
  const db = fixtureDb();
  db.prepare(`INSERT INTO tld_check_cache VALUES ('legacy', 2, '[".com",".shop"]', 3, 'old', '2026-08-12T00:00:00.000Z')`).run();
  ensureNameverseCoverageSchema(db);
  const row = db.prepare(`SELECT * FROM tld_check_cache WHERE base_name='legacy'`).get();
  const projected = projectCoverageReceipt(row, universe, { now: new Date('2026-08-12T01:00:00.000Z') });
  assert.equal(row.coverage_status, 'partial');
  assert.equal(projected.extensions, null);
  assert.equal(projected.extensionsLowerBound, 2);
  assert.match(projected.extensionsLabel, /not verified/i);
  db.close();
});

test('schema readiness is process-idempotent and never rewrites legacy rows on enqueue', () => {
  const db = fixtureDb();
  db.prepare(`INSERT INTO tld_check_cache VALUES ('once', 1, '[".com"]', 3, 'old', '2026-08-12T00:00:00.000Z')`).run();
  ensureNameverseCoverageSchema(db);
  const afterFirst = db.prepare('SELECT total_changes() AS changes').get().changes;
  ensureNameverseCoverageSchema(db);
  const afterSecond = db.prepare('SELECT total_changes() AS changes').get().changes;
  assert.equal(afterSecond, afterFirst, 'the hot-path schema guard must not repeat migration writes');
  db.close();
});

test('producer checks every IANA TLD, persists positive evidence, and atomically publishes complete', async () => {
  const db = fixtureDb();
  db.exec(`INSERT INTO domains VALUES ('bracelet','godaddy-auction',NULL,NULL); INSERT INTO domains VALUES ('bracelet','namecheap-auction',NULL,NULL);`);
  const calls = [];
  const producer = createNameverseCoverageProducer({
    database: db, batchSize: 20, concurrency: 3, now: () => new Date('2026-08-12T02:00:00.000Z'),
    resolver: async (_domain, tld) => { calls.push(tld); return tld === '.com' || tld === '.shop' ? 'taken' : 'not_taken'; },
  });
  const receipt = await producer.refreshBaseName('bracelet', universe);
  assert.deepEqual(calls.sort(), universe.tlds);
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.checkedCount, receipt.totalCount);
  assert.deepEqual(receipt.positives.map(item => item.tld), ['.com', '.shop']);
  assert.deepEqual(receipt.failures, []);
  const rows = db.prepare(`SELECT stream,tlds_taken FROM domains WHERE base_name='bracelet' ORDER BY stream`).all();
  assert.deepEqual(rows, [{ stream: 'godaddy-auction', tlds_taken: 2 }, { stream: 'namecheap-auction', tlds_taken: 2 }]);
  assert.equal(producer.readReceipt('bracelet', universe, { now: new Date('2026-08-12T03:00:00.000Z') }).extensions, 2);
  db.close();
});

test('zone-style authoritative seeds and DNS gap share one provider-neutral receipt', async () => {
  const db = fixtureDb();
  const calls = [];
  const producer = createNameverseCoverageProducer({
    database: db,
    resolver: async (_domain, tld) => { calls.push(tld); return tld === '.shop' ? 'taken' : 'not_taken'; },
  });
  const receipt = await producer.refreshBaseName('seeded', universe, [
    { tld: '.com', status: 'taken', source: 'unrelated-zone-adapter' },
    { tld: '.net', status: 'not_taken', source: 'unrelated-zone-adapter' },
  ]);
  assert.deepEqual(calls, ['.shop']);
  assert.equal(receipt.status, 'complete');
  assert.deepEqual(receipt.positives.map(item => item.tld), ['.com', '.shop']);
  db.close();
});

test('unrelated provider and .shop fixture reuse the same producer without a provider branch', async () => {
  const db = fixtureDb();
  db.exec(`INSERT INTO domains VALUES ('kiln','godaddy-closeout',NULL,NULL); INSERT INTO domains VALUES ('kiln','generic-search',NULL,NULL);`);
  const producer = createNameverseCoverageProducer({
    database: db, resolver: async (_domain, tld) => tld === '.shop' ? 'taken' : 'not_taken',
  });
  const receipt = await producer.refreshBaseName('kiln', universe);
  assert.equal(receipt.count, 1);
  assert.equal(receipt.positives[0].tld, '.shop');
  assert.equal(db.prepare(`SELECT COUNT(DISTINCT tlds_taken) n FROM domains WHERE base_name='kiln'`).get().n, 1);
  db.close();
});

test('unknown timeout remains failure, partial work resumes idempotently, and stale fails closed', async () => {
  const db = fixtureDb();
  db.exec(`INSERT INTO domains VALUES ('resume','godaddy-auction',NULL,NULL)`);
  let fail = true;
  const producer = createNameverseCoverageProducer({
    database: db, batchSize: 20, now: () => new Date('2026-08-01T00:00:00.000Z'),
    resolver: async (_domain, tld) => {
      if (tld === '.shop' && fail) return 'unknown';
      return tld === '.com' ? 'taken' : 'not_taken';
    },
  });
  const partial = await producer.refreshBaseName('resume', universe);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.checkedCount, 2);
  assert.deepEqual(partial.failures.map(item => item.tld), ['.shop']);
  assert.equal(db.prepare(`SELECT tlds_taken FROM domains WHERE base_name='resume'`).get().tlds_taken, null);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM tld_check_cache WHERE base_name='resume'`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM nameverse_check_progress WHERE base_name='resume'`).get().n, 1);
  fail = false;
  const complete = await producer.refreshBaseName('resume', universe);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.checkedCount, 3);
  const stale = producer.readReceipt('resume', universe, { now: new Date('2026-08-20T00:00:00.000Z'), maxAgeMs: 86400000 });
  assert.equal(stale.verified, false);
  assert.equal(stale.receipt.status, 'stale');
  assert.equal(stale.extensions, null);
  assert.equal(stale.extensionsLowerBound, 1);
  db.close();
});

test('partial successor refresh never overwrites a previously published complete receipt', async () => {
  const db = fixtureDb();
  const producer = createNameverseCoverageProducer({
    database: db,
    now: () => new Date('2026-08-12T00:00:00.000Z'),
    resolver: async (_domain, tld) => tld === '.com' ? 'taken' : 'not_taken',
  });
  await producer.refreshBaseName('atomic', universe);
  const published = db.prepare(`SELECT * FROM tld_check_cache WHERE base_name='atomic'`).get();
  const nextUniverse = { ...universe, version: 'fixture-v2', tlds: [...universe.tlds, '.xn--p1ai'] };
  const retrying = createNameverseCoverageProducer({
    database: db,
    now: () => new Date('2026-08-12T01:00:00.000Z'),
    resolver: async () => 'unknown',
  });
  const partial = await retrying.refreshBaseName('atomic', nextUniverse);
  assert.equal(partial.status, 'partial');
  const stillPublished = db.prepare(`SELECT * FROM tld_check_cache WHERE base_name='atomic'`).get();
  assert.equal(stillPublished.universe_version, published.universe_version);
  assert.equal(stillPublished.completed_at, published.completed_at);
  assert.equal(db.prepare(`SELECT universe_version FROM nameverse_check_progress WHERE base_name='atomic'`).get().universe_version, 'fixture-v2');
  db.close();
});

test('UI and AgentForge exports expose fail-closed receipt fields', () => {
  const root = path.resolve(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const focus = fs.readFileSync(path.join(root, 'scripts/focus-cctld-enrich.cjs'), 'utf8');
  const tldList = fs.readFileSync(path.join(root, 'server/tlds-list.js'), 'utf8');
  assert.match(server, /extensionsLowerBound/);
  assert.match(server, /extensionsStatus/);
  assert.match(server, /extensionCoverage/);
  assert.match(server, /projectCoverageReceipt/);
  assert.match(ui, /At least .*not verified/);
  assert.match(ui, /Not verified/);
  assert.doesNotMatch(server, /if .*godaddy.*projectCoverageReceipt/i);
  assert.doesNotMatch(focus, /INSERT INTO tld_check_cache/);
  assert.doesNotMatch(tldList, /startsWith\('\.xn--'\)/);
});
