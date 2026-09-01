'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildAuthRecord,
  escapeHtmlAttribute,
  parseAuthUsers,
  safeReturnPath,
  verifyCredentials,
} = require('../server/auth-users');

test('multiple separately salted users authenticate without plaintext credentials', () => {
  const records = [
    buildAuthRecord('Admin', 'admin-fixture-secret', Buffer.alloc(24, 1)),
    buildAuthRecord('JO', 'jo-fixture-secret', Buffer.alloc(24, 2)),
  ];
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /fixture-secret/);
  const users = parseAuthUsers(serialized);
  assert.equal(verifyCredentials(users, 'Admin', 'admin-fixture-secret'), true);
  assert.equal(verifyCredentials(users, 'JO', 'jo-fixture-secret'), true);
  assert.equal(verifyCredentials(users, 'JO', 'wrong'), false);
  assert.equal(verifyCredentials(users, 'Unknown', 'jo-fixture-secret'), false);
});

test('malformed user secrets fail closed', () => {
  assert.throws(() => parseAuthUsers('{'), /valid JSON/);
  assert.throws(() => parseAuthUsers('[]'), /non-empty array/);
  const record = buildAuthRecord('JO', 'fixture-secret', Buffer.alloc(24, 3));
  assert.throws(() => parseAuthUsers(JSON.stringify([record, record])), /Duplicate/);
});

test('post-login destinations stay inside DomainScout', () => {
  assert.equal(safeReturnPath('/sale-watch'), '/sale-watch');
  assert.equal(safeReturnPath('/?stream=_salewatch'), '/?stream=_salewatch');
  assert.equal(safeReturnPath('https://example.com/steal'), '/');
  assert.equal(safeReturnPath('//example.com/steal'), '/');
  assert.equal(escapeHtmlAttribute('/?q=a&x=\"b\"'), '/?q=a&amp;x=&quot;b&quot;');
});

test('server source contains no built-in UI username or password', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /const APP_(?:USER|PASS)/);
  assert.doesNotMatch(source, /domainscout-secret-fixed-key/);
  assert.match(source, /DOMAINSCOUT_AUTH_USERS_JSON/);
});

test('Sale Watch has a stable authenticated deep link', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(source, /app\.get\('\/sale-watch'[\s\S]*res\.redirect\(302, '\/\?stream=_salewatch'\)/);
  assert.match(source, /name="next" type="hidden"/);
  assert.match(source, /safeReturnPath\(req\.originalUrl/);
});
