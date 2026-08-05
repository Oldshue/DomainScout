'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'release-local-macos.sh');

function makeTempSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-source-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'domainscout-fixture',
      version: '0.0.0',
      scripts: { test: 'node -e "process.exit(0)"' }
    }, null, 2)
  );
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), 'console.log("fixture server");\n');
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<!doctype html><title>fixture</title>\n');
  return dir;
}

test('script passes bash syntax check', () => {
  const result = spawnSync('bash', ['-n', SCRIPT]);
  assert.equal(result.status, 0, result.stderr && result.stderr.toString());
});

test('--check performs validation and exits without mutation on temp valid paths', () => {
  const source = makeTempSource();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-parent-'));
  const target = path.join(parent, 'target-domainscout');
  const backupRoot = path.join(parent, 'backups');
  const result = spawnSync('bash', [
    SCRIPT,
    `--source=${source}`,
    `--target=${target}`,
    `--backup-root=${backupRoot}`,
    '--port=51550',
    '--check'
  ], {
    env: { ...process.env, DOMAINSCOUT_ALLOW_CUSTOM_TARGET: '1' }
  });
  assert.equal(result.status, 0, result.stderr && result.stderr.toString());
  assert.equal(fs.existsSync(target), false, 'check mode must not create the target');
  assert.equal(fs.existsSync(backupRoot), false, 'check mode must not create a backup');
});

test('rejects empty target', () => {
  const source = makeTempSource();
  const result = spawnSync('bash', [SCRIPT, `--source=${source}`, '--target=', '--check']);
  assert.notEqual(result.status, 0);
});

test('rejects non-absolute target', () => {
  const source = makeTempSource();
  const result = spawnSync('bash', [SCRIPT, `--source=${source}`, '--target=relative/path', '--check']);
  assert.notEqual(result.status, 0);
});

test('rejects root slash target', () => {
  const source = makeTempSource();
  const result = spawnSync('bash', [SCRIPT, `--source=${source}`, '--target=/', '--check']);
  assert.notEqual(result.status, 0);
});

test('rejects HOME as target', () => {
  const source = makeTempSource();
  const result = spawnSync('bash', [SCRIPT, `--source=${source}`, `--target=${process.env.HOME}`, '--check']);
  assert.notEqual(result.status, 0);
});

test('rejects target equal to source', () => {
  const source = makeTempSource();
  const result = spawnSync('bash', [SCRIPT, `--source=${source}`, `--target=${source}`, '--check']);
  assert.notEqual(result.status, 0);
});

test('rejects non-default target without allow-custom-target override', () => {
  const source = makeTempSource();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-parent-'));
  const target = path.join(parent, 'other-target');
  const env = { ...process.env };
  delete env.DOMAINSCOUT_ALLOW_CUSTOM_TARGET;
  const result = spawnSync('bash', [SCRIPT, `--source=${source}`, `--target=${target}`, '--check'], { env });
  assert.notEqual(result.status, 0);
});

test('accepts non-default target with allow-custom-target override', () => {
  const source = makeTempSource();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-parent-'));
  const target = path.join(parent, 'other-target');
  const result = spawnSync('bash', [SCRIPT, `--source=${source}`, `--target=${target}`, '--check'], {
    env: { ...process.env, DOMAINSCOUT_ALLOW_CUSTOM_TARGET: '1' }
  });
  assert.equal(result.status, 0, result.stderr && result.stderr.toString());
});

test('script text contains explicit preservation exclusions for data, node_modules, .git, and .env', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /--exclude=data/);
  assert.match(text, /--exclude=node_modules/);
  assert.match(text, /--exclude=\.git/);
  assert.match(text, /--exclude=\.env/);
});

test('script text contains exact cwd PID validation from server.lock.json', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /server\.lock\.json/);
  assert.match(text, /lsof/);
  assert.match(text, /-d cwd/);
  assert.match(text, /"\$cwd" = "\$TARGET"/);
});

test('script text performs backup before sync and preserves prior source commit', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const backupIdx = text.indexOf('perform_backup()');
  const syncIdx = text.indexOf('sync_to_target()');
  assert.ok(backupIdx > -1 && syncIdx > -1);
  assert.ok(backupIdx < syncIdx);
  assert.match(text, /\.source-commit\.prior/);
});

test('script text writes exact source git commit to .source-commit', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /git rev-parse HEAD/);
  assert.match(text, /\.source-commit/);
});

test('script text invokes target installer with DOMAINSCOUT_ROOT and PORT', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /install-macos-app\.sh/);
  assert.match(text, /DOMAINSCOUT_ROOT="\$TARGET"/);
  assert.match(text, /PORT="\$PORT"/);
});

test('script text polls both health endpoints', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /\/api\/stats/);
  assert.match(text, /\/api\/config-status/);
});

test('script text verifies installed plist references target', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /DomainScoutConfig\.plist/);
});

test('script text implements rollback restoring backup while preserving data', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /rollback\(\)/);
  assert.match(text, /--exclude=data/);
  assert.match(text, /trap .*rollback/);
});

test('script only quits the DomainScout application by name', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /osascript/);
  assert.match(text, /tell application "DomainScout" to quit/);
});

test('backup and rollback exclusions never copy credentials or preserved runtime state', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const block = text.match(/BACKUP_EXCLUDES=\([\s\S]*?\n\)/)?.[0] || '';
  for (const name of ['data', '.env', 'node_modules', '.git', '.source-commit']) {
    assert.match(block, new RegExp(`--exclude=${name.replace('.', '\\.')}`));
  }
});

test('source-to-stage, stage-to-target, and rollback rsync phases delete stale code safely', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /rsync -a --delete "\$\{RSYNC_EXCLUDES\[@\]\}" "\$SOURCE"\/ "\$STAGE_DIR"\//);
  assert.match(text, /rsync -a --delete "\$\{RSYNC_EXCLUDES\[@\]\}" "\$STAGE_DIR"\/ "\$TARGET"\//);
  assert.match(text, /rsync -a --delete "\$\{BACKUP_EXCLUDES\[@\]\}" "\$BACKUP_DIR"\/ "\$TARGET"\//);
});

test('rollback restores the exact prior source marker or removes a newly installed marker', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /PRIOR_SOURCE_COMMIT_MARKER="\$\{BACKUP_ROOT\}\/\$\{TIMESTAMP\}\.source-commit\.prior"/);
  assert.match(text, /cp "\$TARGET\/\.source-commit" "\$PRIOR_SOURCE_COMMIT_MARKER"/);
  assert.match(text, /cp "\$PRIOR_SOURCE_COMMIT_MARKER" "\$TARGET\/\.source-commit"/);
  assert.match(text, /rm -f "\$TARGET\/\.source-commit"/);
  assert.doesNotMatch(text, /\$BACKUP_DIR\/\.source-commit\.prior/);
});

test('lock PID is parsed argv-safely as a positive integer before exact cwd ownership check', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /process\.argv\[1\]/);
  assert.match(text, /\/\^\[1-9\]\[0-9\]\*\$\//);
  assert.doesNotMatch(text, /readFileSync\('\$lockfile'/);
  assert.match(text, /"\$cwd" = "\$TARGET"/);
});
