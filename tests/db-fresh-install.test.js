'use strict';

// Regression test for the fresh-install boot crash: a brand-new database (no
// existing `domains` table) used to die in the bootstrap `db.exec` with
// "SqliteError: no such column: tlds_taken" (and later "no such column:
// bid_count") because several `CREATE INDEX ... ON domains(...)` statements
// referenced columns that exist ONLY because a later `ALTER TABLE domains ADD
// COLUMN ...` migration adds them — they are not part of the initial
// `CREATE TABLE IF NOT EXISTS domains (...)` statement, so on a brand-new
// database they don't exist yet when the bootstrap exec runs. This file has
// two layers of protection:
//
//   1. A static, spawn-free check that parses server/db.js as text:
//        - collects the column names defined by the initial
//          `CREATE TABLE IF NOT EXISTS domains (...)` statement (these exist
//          from the first instant of a fresh install, so referencing them in
//          the bootstrap exec is always safe — some legacy `ALTER TABLE ...
//          ADD COLUMN` lines for these also exist purely to backfill
//          pre-existing databases created before the column was folded into
//          the CREATE TABLE, e.g. expiry_date / whois_checked);
//        - collects every `ALTER TABLE domains ADD COLUMN <name>` name;
//        - "late" columns are ALTER names NOT in the initial CREATE TABLE —
//          these are the only ones that don't exist yet on a fresh database
//          when the bootstrap exec runs;
//        - asserts no `CREATE INDEX ... ON domains(...)` statement inside the
//          FIRST bootstrap `db.exec` template literal (the one guarded by
//          `if (process.env.DOMAINSCOUT_SKIP_DB_MAINTENANCE !== '1')`, which
//          runs on every fresh install before the migration block) references
//          any late column.
//      Scoping to `ON domains(...)` statements (rather than a raw whole-block
//      substring search) means an unrelated table that legitimately owns its
//      own same-named column via its own fresh `CREATE TABLE` (e.g.
//      base_tld_counts.base_name, tld_check_cache.base_name,
//      sibling_tld_status.base_name — none of these are ALTER-migrated) can
//      never produce a false failure. This always runs, even in sandboxes
//      where better-sqlite3 has no native binding, so this class of bug
//      cannot recur even when the dynamic spawn test below can't execute.
//
//   2. A dynamic spawn test that actually boots `server/db.js` against a
//      brand-new empty directory (the same shape as a fresh Railway volume)
//      and asserts the process exits cleanly and produces the expected
//      schema. This requires a working better-sqlite3 native binding, so it
//      is skipped (not failed) when the binding can't load in this sandbox.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

let Database = null;
let sqliteBindingError = null;
try {
  // eslint-disable-next-line global-require
  Database = require('better-sqlite3');
  // require() succeeding is not enough — better-sqlite3 throws lazily on the
  // first Database construction when the native .node binding is missing.
  const probe = new Database(':memory:');
  probe.close();
} catch (err) {
  Database = null;
  sqliteBindingError = err;
}

function extractBootstrapExecBlock(src) {
  const marker = 'db.exec(`';
  const first = src.indexOf(marker);
  assert.notStrictEqual(first, -1, 'expected to find a db.exec(` bootstrap block in server/db.js');
  const start = first + marker.length;
  const end = src.indexOf('`);', start);
  assert.notStrictEqual(end, -1, 'expected to find the closing `); of the bootstrap db.exec block');
  return src.slice(start, end);
}

function collectAlterAddColumnNames(src) {
  const re = /ALTER TABLE domains ADD COLUMN (\w+)/g;
  const names = new Set();
  let match;
  while ((match = re.exec(src)) !== null) {
    names.add(match[1]);
  }
  return names;
}

function collectInitialDomainsColumnNames(src) {
  const marker = 'CREATE TABLE IF NOT EXISTS domains (';
  const start = src.indexOf(marker);
  assert.notStrictEqual(start, -1, 'expected an initial CREATE TABLE IF NOT EXISTS domains (...) statement');
  const bodyStart = start + marker.length;
  const end = src.indexOf(');', bodyStart);
  assert.notStrictEqual(end, -1, 'expected a closing ); for the initial domains table definition');
  const body = src.slice(bodyStart, end);
  const names = new Set();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const columnDef = line.match(/^(\w+)\s+(?:INTEGER|TEXT|REAL|BLOB|NUMERIC)\b/i);
    if (columnDef) names.add(columnDef[1]);
  }
  return names;
}

test('static: bootstrap db.exec never references a domains column that only exists after a later ALTER TABLE migration', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'server', 'db.js'), 'utf8');
  const alterColumnNames = collectAlterAddColumnNames(src);
  assert.ok(
    alterColumnNames.size > 0,
    'expected to find at least one "ALTER TABLE domains ADD COLUMN ..." migration in server/db.js'
  );

  const initialColumnNames = collectInitialDomainsColumnNames(src);
  assert.ok(initialColumnNames.size > 0, 'expected to find columns in the initial CREATE TABLE domains(...) statement');

  // Only columns that are NOT part of the initial CREATE TABLE don't exist yet
  // when the bootstrap exec runs on a brand-new database — these are the ones
  // that can trigger "no such column" on fresh install.
  const lateColumnNames = [...alterColumnNames].filter((name) => !initialColumnNames.has(name));
  assert.ok(
    lateColumnNames.length > 0,
    'expected at least one ALTER-only column (added after the initial CREATE TABLE) to check for'
  );

  const bootstrap = extractBootstrapExecBlock(src);

  // Only statements that create something ON the `domains` table can hit this
  // bug class. A different table legitimately owning its own same-named
  // column (e.g. base_tld_counts.base_name, created fresh via its own CREATE
  // TABLE, never migrated) is unrelated and must not fail this test.
  const domainsIndexStatements = bootstrap.match(/CREATE INDEX[^\n]*ON domains\([^;]*;/g) || [];
  assert.ok(
    domainsIndexStatements.length > 0,
    'expected to find at least one "CREATE INDEX ... ON domains(...)" statement in the bootstrap exec block'
  );

  for (const columnName of lateColumnNames) {
    const wordBoundary = new RegExp(`\\b${columnName}\\b`);
    for (const statement of domainsIndexStatements) {
      assert.ok(
        !wordBoundary.test(statement),
        `bootstrap exec statement references column "${columnName}", which only exists after a later ` +
          `"ALTER TABLE domains ADD COLUMN ${columnName}" migration: ${statement.trim()}`
      );
    }
  }
});

function bootFreshDb(tmpDir) {
  const env = { ...process.env, RAILWAY_VOLUME_MOUNT_PATH: tmpDir };
  delete env.DOMAINSCOUT_SKIP_DB_MAINTENANCE;
  return spawnSync(process.execPath, ['-e', "require('./server/db.js')"], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

test('fresh install boots without crashing and creates domains.db', (t) => {
  if (!Database) {
    t.skip(`better-sqlite3 native binding unavailable in this sandbox: ${sqliteBindingError && sqliteBindingError.message}`);
    return;
  }
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

test('fresh database has tlds_taken column and its post-migration indexes', (t) => {
  if (!Database) {
    t.skip(`better-sqlite3 native binding unavailable in this sandbox: ${sqliteBindingError && sqliteBindingError.message}`);
    return;
  }
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
      assert.ok(indexes.includes('idx_disc_bids'), 'expected idx_disc_bids index to exist');
      assert.ok(indexes.includes('idx_disc_base'), 'expected idx_disc_base index to exist');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
