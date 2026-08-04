'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'install-macos-app.sh');

assert.ok(fs.existsSync(INSTALL_SCRIPT), 'install-macos-app.sh must exist');

function runCheck(extraEnv, args) {
  const fullEnv = Object.assign({}, process.env, extraEnv);
  return spawnSync('bash', args, { env: fullEnv, encoding: 'utf8' });
}

function makeFakeRoot(dir) {
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fake"}\n');
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), '// fake server\n');
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<html></html>\n');
}

const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-install-root-test-'));

try {
  // 1. Default invocation (no override): derives root from the script's own
  // location and reports it via --check without mutating anything.
  {
    const result = runCheck({ DOMAINSCOUT_ROOT: '' }, [INSTALL_SCRIPT, '--check']);
    assert.strictEqual(result.status, 0, `default --check should succeed: ${result.stderr}`);
    assert.ok(
      result.stdout.includes(`Resolved DomainScout root: ${REPO_ROOT}`),
      `expected default resolved root to equal repo root, got: ${result.stdout}`
    );
  }

  // 2. Invoking the script via a symlink still resolves the real script's
  // repository root, not the symlink's directory.
  {
    const symlinkDir = fs.mkdtempSync(path.join(scratchBase, 'symlink-'));
    const symlinkPath = path.join(symlinkDir, 'install-macos-app.sh');
    fs.symlinkSync(INSTALL_SCRIPT, symlinkPath);
    const result = runCheck({ DOMAINSCOUT_ROOT: '' }, [symlinkPath, '--check']);
    assert.strictEqual(result.status, 0, `symlink --check should succeed: ${result.stderr}`);
    assert.ok(
      result.stdout.includes(`Resolved DomainScout root: ${REPO_ROOT}`),
      `expected symlink-invoked root to equal repo root, got: ${result.stdout}`
    );
  }

  // 3. DOMAINSCOUT_ROOT override containing spaces canonicalizes to a real path.
  {
    const spacedDir = path.join(scratchBase, 'spaced root dir');
    fs.mkdirSync(spacedDir, { recursive: true });
    makeFakeRoot(spacedDir);
    const result = runCheck({ DOMAINSCOUT_ROOT: spacedDir }, [INSTALL_SCRIPT, '--check']);
    assert.strictEqual(result.status, 0, `spaced override --check should succeed: ${result.stderr}`);
    const expected = fs.realpathSync(spacedDir);
    assert.ok(
      result.stdout.includes(`Resolved DomainScout root: ${expected}`),
      `expected spaced override root to canonicalize, got: ${result.stdout}`
    );
  }

  // 4. An existing directory that is missing required project files is
  // rejected with a clear failure before any mutation.
  {
    const invalidDir = fs.mkdtempSync(path.join(scratchBase, 'invalid-'));
    const result = runCheck({ DOMAINSCOUT_ROOT: invalidDir }, [INSTALL_SCRIPT, '--check']);
    assert.notStrictEqual(result.status, 0, 'invalid root must fail');
    assert.ok(
      /Invalid DomainScout root/.test(result.stderr),
      `expected a clear invalid-root failure message, got: ${result.stderr}`
    );
  }

  // 5. A nonexistent root directory is rejected with a clear failure.
  {
    const missingDir = path.join(scratchBase, `does-not-exist-${Date.now()}`);
    const result = runCheck({ DOMAINSCOUT_ROOT: missingDir }, [INSTALL_SCRIPT, '--check']);
    assert.notStrictEqual(result.status, 0, 'nonexistent root must fail');
    assert.ok(
      /Invalid DomainScout root/.test(result.stderr),
      `expected a clear nonexistent-root failure message, got: ${result.stderr}`
    );
  }
} finally {
  fs.rmSync(scratchBase, { recursive: true, force: true });
}

console.log('install-macos-app-root.test.js: all assertions passed');
