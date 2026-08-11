'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

test('ccTLD projection builds and incrementally replaces provider-neutral positive evidence', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-cctld-index-'));
  const dbPath = path.join(dataDir, 'domains.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      taken_json TEXT NOT NULL,
      all_count INTEGER NOT NULL,
      source TEXT,
      checked_at TEXT
    );
    INSERT INTO tld_check_cache VALUES
      ('alpha', 1, '[".ai"]', 3, 'fixture', '2026-08-11 12:00:00'),
      ('beta', 1, '[".io"]', 3, 'fixture', '2026-08-11 12:00:00');
  `);
  db.close();

  const runWorker = () => spawnSync(process.execPath, ['server/cctld-index-worker.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, RAILWAY_VOLUME_MOUNT_PATH: dataDir },
    encoding: 'utf8',
    timeout: 20_000,
  });

  const first = runWorker();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /"mode":"full"/);

  const verify = new Database(dbPath);
  assert.deepEqual(
    verify.prepare('SELECT tld, base_name FROM cctld_taken_idx ORDER BY tld, base_name').all(),
    [{ tld: '.ai', base_name: 'alpha' }, { tld: '.io', base_name: 'beta' }]
  );
  verify.prepare(`
    UPDATE tld_check_cache
    SET taken_json = '[".shop"]', checked_at = '2026-08-11 12:00:01'
    WHERE base_name = 'beta'
  `).run();
  verify.close();

  const second = runWorker();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"mode":"incremental"/);

  const finalDb = new Database(dbPath, { readonly: true });
  assert.deepEqual(
    finalDb.prepare('SELECT tld, base_name FROM cctld_taken_idx ORDER BY tld, base_name').all(),
    [{ tld: '.ai', base_name: 'alpha' }, { tld: '.shop', base_name: 'beta' }]
  );
  finalDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
