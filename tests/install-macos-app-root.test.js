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

  // 6. When DOMAINSCOUT_APP_DIR is unset, the existing default app path
  // selection logic (system vs. user Applications) is preserved exactly.
  {
    let expectedDefaultAppDir;
    try {
      fs.accessSync('/Applications', fs.constants.W_OK);
      expectedDefaultAppDir = '/Applications/DomainScout.app';
    } catch {
      expectedDefaultAppDir = path.join(os.homedir(), 'Applications', 'DomainScout.app');
    }
    const result = runCheck({ DOMAINSCOUT_ROOT: '', DOMAINSCOUT_APP_DIR: '' }, [INSTALL_SCRIPT, '--check']);
    assert.strictEqual(result.status, 0, `default app-dir --check should succeed: ${result.stderr}`);
    assert.ok(
      result.stdout.includes(`Resolved DomainScout app path: ${expectedDefaultAppDir}`),
      `expected default app dir selection to be preserved, got: ${result.stdout}`
    );
  }

  // 7. An absolute, non-root DOMAINSCOUT_APP_DIR override is accepted and
  // reported verbatim under --check.
  {
    const customAppDir = path.join(scratchBase, 'custom-app-dir', 'DomainScout.app');
    const result = runCheck(
      { DOMAINSCOUT_ROOT: '', DOMAINSCOUT_APP_DIR: customAppDir },
      [INSTALL_SCRIPT, '--check']
    );
    assert.strictEqual(result.status, 0, `custom app-dir --check should succeed: ${result.stderr}`);
    assert.ok(
      result.stdout.includes(`Resolved DomainScout app path: ${customAppDir}`),
      `expected custom app dir to be honored, got: ${result.stdout}`
    );
  }

  // 8. A relative DOMAINSCOUT_APP_DIR is rejected before any mutation.
  {
    const result = runCheck(
      { DOMAINSCOUT_ROOT: '', DOMAINSCOUT_APP_DIR: 'relative/app-dir/DomainScout.app' },
      [INSTALL_SCRIPT, '--check']
    );
    assert.notStrictEqual(result.status, 0, 'relative app-dir must be rejected');
    assert.ok(
      /Invalid DOMAINSCOUT_APP_DIR/.test(result.stderr),
      `expected relative app-dir rejection message, got: ${result.stderr}`
    );
  }

  // 9. The root filesystem slash is rejected as a DOMAINSCOUT_APP_DIR before
  // any mutation.
  {
    const result = runCheck(
      { DOMAINSCOUT_ROOT: '', DOMAINSCOUT_APP_DIR: '/' },
      [INSTALL_SCRIPT, '--check']
    );
    assert.notStrictEqual(result.status, 0, 'root app-dir must be rejected');
    assert.ok(
      /Invalid DOMAINSCOUT_APP_DIR/.test(result.stderr),
      `expected root app-dir rejection message, got: ${result.stderr}`
    );
  }

  // 10. Unrelated structural fixture: verify the script continues to define
  // the pre-existing desktop shortcut and log directory locations, unrelated
  // to and untouched by the DOMAINSCOUT_APP_DIR handling exercised above.
  {
    const text = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
    assert.match(
      text,
      /DESKTOP_APP="\$\{USER_HOME\}\/Desktop\/DomainScout\.app"/,
      'expected the desktop shortcut path to remain defined unchanged'
    );
    assert.match(
      text,
      /LOG_DIR="\$\{USER_HOME\}\/Library\/Logs\/DomainScout"/,
      'expected the log directory path to remain defined unchanged'
    );
    assert.match(text, /<key>DOMAINSCOUT_EXPIRED_DOGFOOD_ENABLED<\/key>\s*<string>0<\/string>/);
    assert.match(text, /<key>DOMAINSCOUT_EXPIRED_DOGFOOD_AFTER_AVAILABILITY<\/key>\s*<string>0<\/string>/);
    assert.match(text, /<key>BuildCommit<\/key>\s*<string>\$\{BUILD_COMMIT\}<\/string>/);
    assert.match(text, /AGENTFORGE_SCRATCH_DIR/);
    assert.match(text, /DomainScoutBuild\.XXXXXX/);
    assert.match(text, /artifacts\/macos-arm64\/DomainScout/);
    assert.match(text, /artifacts\/macos-arm64\/DomainScout\.icns/);
    assert.match(text, /artifacts\/macos-arm64\/DomainScoutCredentialStore/);
    assert.match(text, /verify_bundled_asset "\$BUNDLED_CREDENTIAL_HELPER" DomainScoutCredentialStore/);
    assert.match(text, /scoped_temp_file DomainScoutCredentialCompileError/);
    assert.match(text, /scoped_temp_file DomainScoutCredentialSelfTestError/);
    assert.match(text, /scoped_temp_file DomainScoutLaunchctlError/);
    assert.match(text, /DomainScoutCredentialStore\.swift/);
    assert.match(text, /-framework CryptoKit/);
    assert.match(text, /self-test --service domainscout\.install\.self-test --account hamp/);
    assert.match(text, /redefinition of module 'SwiftBridging'/);
    assert.match(text, /system toolchain bytes remain untouched/);
    assert.match(text, /Secure Enclave self-test deferred/);
    assert.match(text, /GUI launchd activation deferred to DomainScout\.app/);
    assert.match(text, /Domain does not support specified action/);
    assert.match(text, /chmod 700 "\$CREDENTIAL_HELPER"/);
    assert.match(text, /<key>DOMAINSCOUT_CREDENTIAL_HELPER<\/key>\s*<string>\$\{CREDENTIAL_HELPER\}<\/string>/);
    assert.match(text, /verify_bundled_asset/);
    assert.match(text, /LC_ALL=C shasum -a 256/);
    assert.match(
      text,
      /chmod 755 "\$\{APP_DIR\}\/Contents\/MacOS\/DomainScout"/,
      'the installed executable must remain readable by LaunchServices, not inherit mktemp mode 0600'
    );
    assert.doesNotMatch(text, /chmod \+x "\$\{APP_DIR\}\/Contents\/MacOS\/DomainScout"/);
    assert.match(text, /\/usr\/bin\/codesign --force --sign - "\$APP_DIR"/);
    assert.match(text, /\/usr\/bin\/codesign --force --sign - "\$CREDENTIAL_TMP"/);
    assert.match(text, /\/usr\/bin\/codesign --verify --deep --strict "\$APP_DIR"/);
    assert.ok(
      text.indexOf('/usr/bin/codesign --force --sign - "$APP_DIR"')
        > text.indexOf('cat > "${APP_DIR}/Contents/Info.plist"'),
      'the completed app bundle must be signed only after its Info.plist and resources are installed'
    );
    assert.ok(
      text.indexOf('/usr/bin/codesign --verify --deep --strict "$APP_DIR"')
        < text.indexOf('"${ROOT}/scripts/consolidate-macos-app-launchers.sh"'),
      'signature verification must pass before the canonical launcher is registered'
    );
    assert.match(text, /DOMAINSCOUT_USER_HOME/);
    assert.match(text, /--defer-service-reload/);
    assert.match(text, /consolidate-macos-app-launchers\.sh/);
    assert.match(text, /--canonical-app=\$\{APP_DIR\}/);
  }
} finally {
  fs.rmSync(scratchBase, { recursive: true, force: true });
}

console.log('install-macos-app-root.test.js: all assertions passed');
