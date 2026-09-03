'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadAgentTokenAllowed(env) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const start = source.indexOf('function agentTokenAllowed');
  const end = source.indexOf('\n}\n\nfunction requireAuth', start) + 2;
  const body = source.slice(start, end);
  return Function('require', 'process', `${body}; return agentTokenAllowed;`)(require, { env });
}

test('universe import POST admits the dedicated import token', () => {
  const importToken = 'universe-import-token-0001';
  const agentTokenAllowed = loadAgentTokenAllowed({
    DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: importToken,
    DOMAINSCOUT_AGENT_TOKEN: 'agent-read-token-0000001',
  });
  assert.equal(agentTokenAllowed({
    method: 'POST',
    path: '/api/universe/import',
    headers: { 'x-domainscout-token': importToken },
    query: {},
  }), true);
});

test('universe summary import POST admits the dedicated import token', () => {
  const importToken = 'universe-import-token-0001';
  const agentTokenAllowed = loadAgentTokenAllowed({
    DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: importToken,
    DOMAINSCOUT_AGENT_TOKEN: 'agent-read-token-0000001',
  });
  assert.equal(agentTokenAllowed({
    method: 'POST',
    path: '/api/universe/summary/import',
    headers: { 'x-domainscout-token': importToken },
    query: {},
  }), true);
});

test('agent tokens do not admit other POST routes', () => {
  const agentToken = 'agent-read-token-0000001';
  const agentTokenAllowed = loadAgentTokenAllowed({
    DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: 'universe-import-token-0001',
    DOMAINSCOUT_AGENT_TOKEN: agentToken,
  });
  assert.equal(agentTokenAllowed({
    method: 'POST',
    path: '/api/czds-sync',
    headers: { 'x-domainscout-token': agentToken },
    query: {},
  }), false);
});

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
