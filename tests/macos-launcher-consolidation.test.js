'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const shellScript = path.join(repoRoot, 'scripts', 'consolidate-macos-app-launchers.sh');
const dockScript = path.join(repoRoot, 'scripts', 'consolidate-macos-dock.js');

test('launcher consolidator is syntax-valid and provider-neutral', () => {
  assert.equal(spawnSync('bash', ['-n', shellScript]).status, 0);
  const shell = fs.readFileSync(shellScript, 'utf8');
  const dock = fs.readFileSync(dockScript, 'utf8');
  assert.doesNotMatch(shell, /DomainScout/);
  assert.doesNotMatch(dock, /DomainScout/);
  assert.match(shell, /Retired Launchers/);
  assert.match(dock, /persistent-apps/);
});

test('an unrelated app fixture replaces a stale Desktop bundle recoverably', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-consolidation-'));
  const userHome = path.join(root, 'home');
  const canonical = path.join(userHome, 'Applications', 'WeatherWatch.app');
  const desktop = path.join(userHome, 'Desktop', 'WeatherWatch.app');
  const legacy = path.join(userHome, 'Legacy Applications', 'WeatherWatch.app');
  const defaultsDomain = `com.example.weatherwatch.launcher-test-${process.pid}`;
  fs.mkdirSync(canonical, { recursive: true });
  fs.mkdirSync(desktop, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(desktop, 'stale-marker'), 'old');
  fs.writeFileSync(path.join(legacy, 'legacy-marker'), 'old-app');

  const result = spawnSync('bash', [
    shellScript,
    '--app-name=WeatherWatch',
    '--bundle-id=com.example.weatherwatch',
    `--canonical-app=${canonical}`,
    `--desktop-app=${desktop}`,
    `--legacy-app=${legacy}`,
    `--user-home=${userHome}`,
    `--defaults-domain=${defaultsDomain}`,
    '--no-restart-dock'
  ], { encoding: 'utf8', env: { ...process.env, HOME: userHome } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.lstatSync(desktop).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(desktop), fs.realpathSync(canonical));
  assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(legacy), fs.realpathSync(canonical));
  const retiredRoot = path.join(userHome, 'Library', 'Application Support', 'WeatherWatch', 'Retired Launchers');
  const retired = fs.readdirSync(retiredRoot);
  assert.equal(retired.length, 2);
  assert.ok(retired.every(name => name.endsWith('.app.silo')));
  assert.equal(retired.some(name => fs.existsSync(path.join(retiredRoot, name, 'stale-marker'))), true);
  assert.equal(retired.some(name => fs.existsSync(path.join(retiredRoot, name, 'legacy-marker'))), true);
  const dockState = spawnSync('defaults', ['read', defaultsDomain, 'persistent-apps'], { encoding: 'utf8' });
  assert.equal(dockState.status, 0, dockState.stderr);
  assert.match(dockState.stdout, /com\.example\.weatherwatch/);
  assert.match(dockState.stdout, /WeatherWatch\.app/);
  spawnSync('defaults', ['delete', defaultsDomain]);
});

test('the legacy convenience launcher prefers the canonical system app', () => {
  const text = fs.readFileSync(path.join(repoRoot, 'scripts', 'domainscout-open'), 'utf8');
  assert.ok(text.indexOf('if [ -d "$SYSTEM_APP" ]') < text.indexOf('if [ -d "$USER_APP" ]'));
});

test('the installer resolves a compatibility symlink before updating the bundle', () => {
  const text = fs.readFileSync(path.join(repoRoot, 'scripts', 'install-macos-app.sh'), 'utf8');
  assert.match(text, /if \[ -d "\$APP_DIR" \]; then\s+APP_DIR="\$\(cd -P "\$APP_DIR"/);
});
