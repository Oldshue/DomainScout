'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createProbeQueue, ensureSiteEvidenceSchema } = require('../server/site-evidence');

function freshDb() {
  const db = new Database(':memory:');
  ensureSiteEvidenceSchema(db);
  return db;
}

test('enqueue de-dupes domains within one call and returns {queued, pending}', () => {
  const db = freshDb();
  const queue = createProbeQueue(db, { inspect: async () => ({ active: true, title: 'T', finalUrl: 'https://x', finalHost: 'x', status: 200 }) });
  const result = queue.enqueue(['a.com', 'B.com', 'a.com', ' a.com ']);
  assert.equal(result.queued, 2);
  assert.equal(result.pending, 2);
  assert.equal(queue.pending(), 2);
});

test('enqueue skips a domain whose stored checked_at is newer than maxAgeDays', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO site_evidence (domain, checked_at, status, title, final_host, http_status, source) VALUES (?, ?, 'built', 'T', 'fresh.com', 200, 'site-evidence')`).run('fresh.com', now);
  const staleAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO site_evidence (domain, checked_at, status, title, final_host, http_status, source) VALUES (?, ?, 'built', 'T', 'stale.com', 200, 'site-evidence')`).run('stale.com', staleAt);

  const queue = createProbeQueue(db, { inspect: async () => ({ active: true, title: 'T', finalUrl: 'https://x', finalHost: 'x', status: 200 }) });
  const result = queue.enqueue(['fresh.com', 'stale.com', 'never.com'], { maxAgeDays: 7 });
  assert.equal(result.queued, 2);
  assert.equal(result.pending, 2);
});

test('background drain probes queued domains via refreshSiteEvidence and clears pending', async () => {
  const db = freshDb();
  const seen = [];
  const inspect = async (domain) => {
    seen.push(domain);
    return { active: true, title: `Title for ${domain}`, finalUrl: `https://${domain}`, finalHost: domain, status: 200 };
  };
  const queue = createProbeQueue(db, { inspect });
  const enqueued = queue.enqueue(['one.com', 'two.com', 'three.com']);
  assert.equal(enqueued.pending, 3);

  await queue.drain();

  assert.equal(queue.pending(), 0);
  assert.deepEqual([...seen].sort(), ['one.com', 'three.com', 'two.com']);

  const rows = db.prepare('SELECT domain, status, title FROM site_evidence ORDER BY domain').all();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.status, 'built');
    assert.match(row.title, /Title for/);
  }
});

test('a second enqueue while a drain is in flight is folded into the same background run', async () => {
  const db = freshDb();
  let resolveFirst;
  const gate = new Promise((resolve) => { resolveFirst = resolve; });
  let callCount = 0;
  const inspect = async (domain) => {
    callCount += 1;
    if (domain === 'first.com') await gate;
    return { active: true, title: 'T', finalUrl: `https://${domain}`, finalHost: domain, status: 200 };
  };
  const queue = createProbeQueue(db, { inspect });

  queue.enqueue(['first.com']);
  // enqueue a second domain while the first is still in-flight; it should be
  // picked up without requiring a fresh enqueue() call to start draining.
  await new Promise((resolve) => setImmediate(resolve));
  const second = queue.enqueue(['second.com']);
  assert.ok(second.pending >= 1);

  resolveFirst();
  await queue.drain();

  assert.equal(queue.pending(), 0);
  assert.ok(callCount >= 2);
  const rows = db.prepare('SELECT domain FROM site_evidence ORDER BY domain').all().map((r) => r.domain);
  assert.deepEqual(rows, ['first.com', 'second.com']);
});

test('enqueue never throws when the DB read fails, and pending stays consistent', () => {
  const db = freshDb();
  const queue = createProbeQueue(db, { inspect: async () => ({ active: true, title: 'T', finalUrl: 'https://x', finalHost: 'x', status: 200 }) });
  const originalPrepare = db.prepare.bind(db);
  db.prepare = () => { throw new Error('boom'); };
  let result;
  assert.doesNotThrow(() => { result = queue.enqueue(['bad.com']); });
  assert.equal(result.queued, 0);
  db.prepare = originalPrepare;
});

test('drain never throws even when inspect rejects for every domain', async () => {
  const db = freshDb();
  const queue = createProbeQueue(db, { inspect: async () => { throw new Error('network down'); } });
  queue.enqueue(['dead.com']);
  await assert.doesNotReject(queue.drain());
  assert.equal(queue.pending(), 0);
  const row = db.prepare('SELECT status FROM site_evidence WHERE domain = ?').get('dead.com');
  assert.equal(row.status, 'dead');
});

test('empty enqueue() call is a no-op that never starts a drain', () => {
  const db = freshDb();
  let called = false;
  const queue = createProbeQueue(db, { inspect: async () => { called = true; return { active: true, title: 'T', finalUrl: 'https://x', finalHost: 'x', status: 200 }; } });
  const result = queue.enqueue([]);
  assert.deepEqual(result, { queued: 0, pending: 0 });
  assert.equal(called, false);
});
