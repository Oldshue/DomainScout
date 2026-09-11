'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configuredApiKey } = require('../scrapers/namecheap');

const ENV_KEY = 'DOMAINSCOUT_NAMECHEAP_AUCTIONS_API_KEY';

function withPlatform(name, fn) {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

function withEnv(value, fn) {
  const original = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  }
}

test('env var wins on non-darwin platforms without touching the credential store', () => {
  withPlatform('linux', () => {
    withEnv('env-token', () => {
      let storeCalled = false;
      const result = configuredApiKey({
        credentialStore: {
          readUtf8Credential() {
            storeCalled = true;
            return 'store-token';
          },
        },
      });
      assert.equal(result, 'env-token');
      assert.equal(storeCalled, false);
    });
  });
});

test('empty env var on darwin falls through to the credential store as before', () => {
  withPlatform('darwin', () => {
    withEnv('', () => {
      let storeCalled = false;
      const result = configuredApiKey({
        credentialHelper: '/fixture/helper',
        credentialStore: {
          readUtf8Credential(identity) {
            storeCalled = true;
            assert.deepEqual(identity, {
              service: 'domainscout.namecheap.auctions',
              account: 'hamp',
              helperPath: '/fixture/helper',
            });
            return 'store-token';
          },
        },
      });
      assert.equal(result, 'store-token');
      assert.equal(storeCalled, true);
    });
  });
});

test('options.apiKey still wins over the env var', () => {
  withEnv('env-token', () => {
    let storeCalled = false;
    const result = configuredApiKey({
      apiKey: 'explicit-token',
      credentialStore: {
        readUtf8Credential() {
          storeCalled = true;
          return 'store-token';
        },
      },
    });
    assert.equal(result, 'explicit-token');
    assert.equal(storeCalled, false);
  });
});
