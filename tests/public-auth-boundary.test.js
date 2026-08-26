'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('hosted private proxy addresses never bypass the public login boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const start = source.indexOf('function isLocalRequest');
  const end = source.indexOf('\n}\n\n// Read-only agent access', start) + 2;
  const body = source.slice(start, end);
  assert.match(body, /socket\?\.remoteAddress/);
  assert.match(body, /includes\(host\) && socketIp === '127\.0\.0\.1'/);
  assert.doesNotMatch(body, /req\.ip/);
  assert.doesNotMatch(source, /function isTrustedPrivateIp/);
});
