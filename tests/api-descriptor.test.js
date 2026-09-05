'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ENDPOINTS, describeApi, llmsText } = require('../server/api-descriptor');

test('every ENDPOINTS path starts with /api/', () => {
  assert.ok(Array.isArray(ENDPOINTS) && ENDPOINTS.length > 0);
  for (const endpoint of ENDPOINTS) {
    assert.ok(endpoint.path.startsWith('/api/'), endpoint.path + ' should start with /api/');
  }
});

test('every param has name, type, and description', () => {
  for (const endpoint of ENDPOINTS) {
    for (const param of endpoint.params || []) {
      assert.ok(typeof param.name === 'string' && param.name.length > 0, 'param.name on ' + endpoint.path);
      assert.ok(typeof param.type === 'string' && param.type.length > 0, 'param.type on ' + endpoint.path);
      assert.ok(typeof param.description === 'string' && param.description.length > 0, 'param.description on ' + endpoint.path);
    }
  }
});

test('describeApi() returns a valid OpenAPI 3.0.3 document with a paths entry per endpoint', () => {
  const doc = describeApi();
  assert.equal(doc.openapi, '3.0.3');
  assert.equal(doc.info.title, 'DomainScout API');
  for (const endpoint of ENDPOINTS) {
    const openApiPath = endpoint.path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
    assert.ok(doc.paths[openApiPath], 'missing OpenAPI path for ' + endpoint.path);
    assert.ok(doc.paths[openApiPath].get);
    assert.ok(doc.paths[openApiPath].get.responses[200]);
  }
  assert.equal(doc.components.securitySchemes.apiKey.type, 'apiKey');
  assert.equal(doc.components.securitySchemes.apiKey.in, 'header');
  assert.equal(doc.components.securitySchemes.apiKey.name, 'x-domainscout-token');
});

test('llmsText(baseUrl) mentions auth header, openapi doc, JSON 404 rule, and baseUrl', () => {
  const text = llmsText('https://x');
  assert.ok(text.includes('x-domainscout-token'));
  assert.ok(text.includes('/openapi.json'));
  assert.ok(text.includes('JSON 404'));
  assert.ok(text.includes('https://x'));
});
