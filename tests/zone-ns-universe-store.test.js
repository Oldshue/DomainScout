'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const {
  ensureZoneNsUniverseSchema,
  buildZoneUniverseDayToStore,
} = require('../server/zone-ns-universe');

function makeFetchImpl(zoneResponse) {
  return async (url) => {
    const href = String(url);
    if (href.includes('authenticate')) {
      return new Response(JSON.stringify({ accessToken: [redacted]]' }), { status: 200 });
    }
    if (href.includes('downloads/links')) {
      return new Response(JSON.stringify(['https://example.test/downloads/com.zone']), { status: 200 });
    }
    return zoneResponse;
  };
}

test('ensureZoneNsUniverseSchema is idempotent', () => {
  const db = new Database(':memory:');
  ensureZoneNsUniverseSchema(db);
  ensureZoneNsUniverseSchema(db);
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('zone_ns_universe_hits', 'zone_ns_universe_runs')
  `).all();
  assert.equal(tables.length, 2);
  db.close();
});

test('buildZoneUniverseDayToStore streams unique hits and records a complete run', async () => {
  const db = new Database(':memory:');
  const day = '2026-09-02';
  const zoneLines = [
    'example1.com. 3600 IN NS ns1.afternic.com.',
    'example1.com. 3600 IN NS ns1.afternic.com.',
    'example2.com. 3600 IN NS above.com.',
    'example3.com. 3600 IN NS ns1.google.com.',
    'com. 3600 IN NS a.gtld-servers.net.',
  ].join('\n') + '\n';
  const gzipped = zlib.gzipSync(Buffer.from(zoneLines, 'utf8'));
  const fetchImpl = makeFetchImpl(new Response(gzipped, { status: 200 }));

  const result = await buildZoneUniverseDayToStore({
    database: db,
    day,
    user: 'u',
    pass: 'p',
    fetchImpl,
    log: () => {},
  });

  assert.equal(result.ran, true);
  assert.equal(result.day, day);
  assert.equal(result.hits, 2);
  assert.equal(result.lines, 5);
  assert.equal(result.nsRecords, 5);

  const rows = db.prepare('SELECT domain, provider FROM zone_ns_universe_hits WHERE day = ? ORDER BY domain').all(day);
  assert.deepEqual(rows, [
    { domain: 'example1.com', provider: 'Afternic' },
    { domain: 'example2.com', provider: 'Above.com' },
  ]);

  const run = db.prepare('SELECT status, hits, lines, ns_records, error FROM zone_ns_universe_runs WHERE day = ?').get(day);
  assert.equal(run.status, 'complete');
  assert.equal(run.hits, 2);
  assert.equal(run.lines, 5);
  assert.equal(run.ns_records, 5);
  assert.equal(run.error, null);

  db.close();
});

test('buildZoneUniverseDayToStore records a failed run on download failure without throwing', async () => {
  const db = new Database(':memory:');
  const day = '2026-09-02';
  const fetchImpl = makeFetchImpl(new Response('', { status: 503 }));

  const result = await buildZoneUniverseDayToStore({
    database: db,
    day,
    user: 'u',
    pass: 'p',
    fetchImpl,
    log: () => {},
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, 'zone-download-failed');

  const run = db.prepare('SELECT status, error FROM zone_ns_universe_runs WHERE day = ?').get(day);
  assert.equal(run.status, 'failed');
  assert.ok(run.error);

  db.close();
});
