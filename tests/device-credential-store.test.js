'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CredentialStoreError,
  readUtf8Credential,
  storeCredential,
  validateHelper,
} = require('../lib/device-credential-store');

function fixtureHelper() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-credential-test-'));
  const receipt = path.join(directory, 'stdin-length');
  const helper = path.join(directory, 'helper');
  fs.writeFileSync(helper, `#!/bin/sh
case "$1" in
  get) /usr/bin/printf 'fixture-token' ;;
  set) /usr/bin/wc -c | /usr/bin/tr -d ' ' > ${JSON.stringify(receipt)} ;;
  delete|self-test) exit 0 ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(helper, 0o700);
  return { directory, helper, receipt };
}

test('credential reads are captured in memory and writes travel only over stdin', () => {
  const fixture = fixtureHelper();
  try {
    const identity = { helperPath: fixture.helper, service: 'domainscout.test', account: 'hamp' };
    assert.equal(readUtf8Credential(identity), 'fixture-token');
    storeCredential('stdin-only-secret', identity);
    assert.equal(fs.readFileSync(fixture.receipt, 'utf8').trim(), String(Buffer.byteLength('stdin-only-secret')));
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('credential helper validation rejects symlinks and group-readable executables', () => {
  const fixture = fixtureHelper();
  try {
    const symlink = path.join(fixture.directory, 'helper-link');
    fs.symlinkSync(fixture.helper, symlink);
    assert.throws(() => validateHelper(symlink), error => error instanceof CredentialStoreError);
    fs.chmodSync(fixture.helper, 0o750);
    assert.throws(() => validateHelper(fixture.helper), error => error instanceof CredentialStoreError);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('native store uses a hardware-bound authenticated envelope, never the legacy keychain CLI', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'DomainScoutCredentialStore.swift'), 'utf8');
  assert.match(source, /SecureEnclave\.P256\.KeyAgreement\.PrivateKey/);
  assert.match(source, /AES\.GCM\.seal/);
  assert.match(source, /AES\.GCM\.open/);
  assert.match(source, /Data\("DomainScout device credential v1"/);
  assert.doesNotMatch(source, /\/usr\/bin\/security|SecItem|kSecUseDataProtectionKeychain/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /st_nlink == 1/);
  assert.match(source, /0o600/);
});
