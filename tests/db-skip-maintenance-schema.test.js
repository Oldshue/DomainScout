'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-required-schema-'));
try {
  const seed = new Database(path.join(dataDir, 'domains.db'));
  seed.exec('CREATE TABLE domains (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL)');
  seed.close();

  const script = `
    const db = require('./server/db');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('drop_events','drop_source_catalog','drop_source_coverage','drop_source_status','live_listing_cache','app_cache') ORDER BY name").all().map(row => row.name);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_live_listing_cache_fetched_at'").all().map(row => row.name);
    process.stdout.write(JSON.stringify({ names, indexes }));
    db.close();
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      RAILWAY_VOLUME_MOUNT_PATH: dataDir,
      DOMAINSCOUT_SKIP_DB_MAINTENANCE: '1',
    },
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const schema = JSON.parse(result.stdout);
  assert.deepStrictEqual(schema.names, [
    'app_cache',
    'drop_events',
    'drop_source_catalog',
    'drop_source_coverage',
    'drop_source_status',
    'live_listing_cache',
  ]);
  assert.deepStrictEqual(schema.indexes, ['idx_live_listing_cache_fetched_at']);
  console.log('db-skip-maintenance-schema.test.js: all assertions passed');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
