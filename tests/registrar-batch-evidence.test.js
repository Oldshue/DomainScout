'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('bulk registrar evidence preserves input order and fails omitted rows closed', async () => {
  const prior = {
    key: process.env.GODADDY_API_KEY,
    secret: process.env.GODADDY_API_SECRET,
    reload: process.env.DOMAINSCOUT_DISABLE_RUNTIME_ENV_RELOAD,
  };
  process.env.GODADDY_API_KEY = 'fixture-key';
  process.env.GODADDY_API_SECRET = 'fixture-secret';
  process.env.DOMAINSCOUT_DISABLE_RUNTIME_ENV_RELOAD = '1';
  const { checkGoDaddyRegistrationAvailabilityBatch } = require('../enrichment');
  const calls = [];
  const axiosClient = {
    async post(url, domains, options) {
      calls.push({ url, domains, options });
      return { data: [
        { domain: 'agentwall.com', available: false },
        { domain: 'orchard.com', available: true },
      ] };
    },
  };
  try {
    const rows = await checkGoDaddyRegistrationAvailabilityBatch(
      ['agentwall.com', 'orchard.com', 'unanswered.co.uk'],
      { axiosClient, chunkSize: 500 }
    );
    assert.deepEqual(rows.map(row => [row.domain, row.status]), [
      ['agentwall.com', 'registered'],
      ['orchard.com', 'available'],
      ['unanswered.co.uk', 'unknown'],
    ]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /checkType=FAST/);
    assert.match(calls[0].options.headers.Authorization, /^sso-key fixture-key:/);
  } finally {
    if (prior.key === undefined) delete process.env.GODADDY_API_KEY; else process.env.GODADDY_API_KEY = prior.key;
    if (prior.secret === undefined) delete process.env.GODADDY_API_SECRET; else process.env.GODADDY_API_SECRET = prior.secret;
    if (prior.reload === undefined) delete process.env.DOMAINSCOUT_DISABLE_RUNTIME_ENV_RELOAD; else process.env.DOMAINSCOUT_DISABLE_RUNTIME_ENV_RELOAD = prior.reload;
  }
});
