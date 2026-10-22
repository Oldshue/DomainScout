'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkRegistryWhoisBatch,
  classifyWhois,
  parseIanaWhoisServer,
} = require('../server/registry-whois-evidence');

test('WHOIS classification requires the exact requested domain field', () => {
  assert.equal(classifyWhois('Domain Name: ORCHARD.COM\r\nRegistrar: Example', 'orchard.com'), 'registered');
  assert.equal(classifyWhois('Domain name:\n  orchard.co.uk\n', 'orchard.co.uk'), 'registered');
  assert.equal(classifyWhois('Domain Name: OTHER.COM\nRegistrar: Example', 'orchard.com'), 'unknown');
  assert.equal(classifyWhois('No match for "ORCHARD.COM"', 'orchard.com'), 'available');
  assert.equal(parseIanaWhoisServer('domain: UK\nwhois: whois.nic.uk\n'), 'whois.nic.uk');
});

test('registry WHOIS receipts retain hashes and unavailable boundaries without raw responses', async () => {
  const query = async (value, server) => {
    if (server === 'whois.iana.org' && value === 'com') return Buffer.from('whois: whois.registry.test\n');
    if (server === 'whois.iana.org' && value === 'zz') return Buffer.from('domain: ZZ\n');
    if (value === 'orchard.com') return Buffer.from('Domain Name: ORCHARD.COM\r\nRegistrar: Example\r\n');
    throw new Error('unexpected query');
  };
  const rows = await checkRegistryWhoisBatch(['orchard.com', 'orchard.zz'], {
    query, checkedAt: '2026-10-22T00:00:00.000Z', concurrency: 1,
  });
  assert.equal(rows[0].status, 'registered');
  assert.equal(rows[0].server, 'whois.registry.test');
  assert.match(rows[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(rows[0], 'raw'), false);
  assert.deepEqual(rows[1], {
    domain: 'orchard.zz', status: 'unknown', source: 'registry-whois-unavailable',
    server: null, checkedAt: '2026-10-22T00:00:00.000Z', bytes: 0, sha256: null,
    error: 'registry WHOIS unavailable or retired',
  });
});

test('a root-scoped registry override fills an absent IANA referral without hiding the server', async () => {
  const query = async (value, server) => {
    if (server === 'whois.iana.org' && value === 'uk') return Buffer.from('domain: UK\n');
    if (server === 'whois.nic.uk' && value === 'orchard.co.uk') return Buffer.from('Domain name:\n  orchard.co.uk\n');
    throw new Error('unexpected query');
  };
  const [row] = await checkRegistryWhoisBatch(['orchard.co.uk'], { query, checkedAt: '2026-10-22T00:00:00Z' });
  assert.equal(row.status, 'registered');
  assert.equal(row.server, 'whois.nic.uk');
});
