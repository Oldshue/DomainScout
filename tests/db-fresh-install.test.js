'use strict';

// Regression test for the fresh-install boot crash: a brand-new database (no
// existing `domains` table) used to die in the bootstrap `db.exec` with
// "SqliteError: no such column: tlds_taken" because idx_disc_tlds and
// idx_tlds_taken_domain referenced tlds_taken before the column-migration
// ALTER TABLE ran. This spawns a fresh `node -e "require('./server/db.js')"`
// against an empty RAILWAY_VOLUME_MOUNT_PATH directory (the same shape as a
// brand-new Railway volume) and asserts it boots cleanly and produces the
// expected schema.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const repoRoot = path.join(__dirname, '..');

function bootFreshDb(tmpDir) {
  const env = { ...process.env, RAILWAY_VOLUME_MOUNT_PATH: tmpDir };
  delete env.DOMAINSCOUT_SKIP_DB_MAINTENANCE;
  return spawnSync(process.execPath, ['-e', "require('./server/db.js')"], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

test('fresh install boots without crashing and creates domains.db', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-fresh-'));
  try {
    const result = bootFreshDb(tmpDir);
    assert.strictEqual(
      result.status,
      0,
      `expected clean boot exit code 0, got ${result.status}\nstderr:\n${result.stderr}`
    );
    const dbPath = path.join(tmpDir, 'domains.db');
    assert.ok(fs.existsSync(dbPath), `expected ${dbPath} to exist after fresh boot`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fresh database has tlds_taken column and its post-migration indexes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-fresh-'));
  try {
    const result = bootFreshDb(tmpDir);
    assert.strictEqual(
      result.status,
      0,
      `expected clean boot exit code 0, got ${result.status}\nstderr:\n${result.stderr}`
    );

    const dbPath = path.join(tmpDir, 'domains.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(domains)").all().map((c) => c.name);
      assert.ok(columns.includes('tlds_taken'), 'expected domains.tlds_taken column to exist');

      const indexes = db.prepare("PRAGMA index_list(domains)").all().map((i) => i.name);
      assert.ok(indexes.includes('idx_disc_tlds'), 'expected idx_disc_tlds index to exist');
      assert.ok(indexes.includes('idx_tlds_taken_domain'), 'expected idx_tlds_taken_domain index to exist');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
