'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-storage-maintenance-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;

const { publishLargeProviderSnapshot, registerLargeProviderStream } = require('../server/large-provider-snapshot');
const { pruneProviderStorage, pruneRedundantProviderRows } = require('../server/provider-storage-maintenance');

const columns = ['domain', 'tld', 'stream', 'auction_end'];
registerLargeProviderStream({
  stream: 'security-feed',
  columns,
  minCount: 1,
  minTimestampRatio: 1,
  retainGenerations: 2,
});

function rows(label) {
  return [{ domain: `${label}.example`, tld: '.example', stream: 'security-feed', auction_end: '2026-08-26T00:00:00.000Z' }];
}

test('verified current generation gates legacy and superseded snapshot removal', () => {
  publishLargeProviderSnapshot('security-feed', rows('first'));
  const current = publishLargeProviderSnapshot('security-feed', rows('second'));
  fs.writeFileSync(path.join(dataDir, 'security-cache.json'), 'legacy');
  fs.writeFileSync(path.join(dataDir, 'security-cache.json.ui-index.json'), 'legacy-index');
  fs.writeFileSync(path.join(dataDir, 'security-cache.json.meta.json'), '{}');

  const result = pruneProviderStorage({
    dataDir,
    providers: [{ stream: 'security-feed', legacyFileStem: 'security-cache' }],
  });
  assert.deepEqual(result.verified, [{ stream: 'security-feed', generationId: current.generationId, count: 1 }]);
  const generations = fs.readdirSync(path.join(dataDir, 'provider-snapshots', 'security-feed', 'generations'));
  assert.deepEqual(generations, [current.generationId]);
  assert.equal(fs.existsSync(path.join(dataDir, 'security-cache.json')), false);
});

test('redundant snapshot rows are pruned while user and enrichment state survives', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE domains (
      id INTEGER PRIMARY KEY, stream TEXT, domain TEXT, saved INTEGER DEFAULT 0,
      seen INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, notes TEXT,
      wayback_snapshots INTEGER, registration_available INTEGER
    );
    CREATE VIRTUAL TABLE domain_fts USING fts5(domain, content='domains', content_rowid='id');
    INSERT INTO domains (stream, domain) VALUES ('security-feed', 'discard.example');
    INSERT INTO domains (stream, domain, saved) VALUES ('security-feed', 'saved.example', 1);
    INSERT INTO domains (stream, domain, registration_available) VALUES ('security-feed', 'checked.example', 1);
    INSERT INTO domains (stream, domain) VALUES ('unrelated-feed', 'keep.example');
  `);
  const result = pruneRedundantProviderRows(db, ['security-feed'], { batchSize: 1 });
  assert.deepEqual(result, { deleted: 1, retained: 2 });
  assert.deepEqual(db.prepare('SELECT domain FROM domains ORDER BY domain').all().map(row => row.domain), [
    'checked.example', 'keep.example', 'saved.example',
  ]);
  db.close();
});

test('GoDaddy refresh code cannot duplicate large provider snapshots into SQLite', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'scrape-all.js'), 'utf8');
  const start = source.indexOf('async function refreshGoDaddyInventory');
  const end = source.indexOf('\nasync function refreshNamecheapInventory', start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /insertStreamSnapshots/);
  assert.doesNotMatch(body, /importDb/);
  assert.match(body, /snapshotOnly: true/);
});
