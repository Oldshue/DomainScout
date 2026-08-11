'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'DomainScoutApp.swift'), 'utf8');

test('desktop readiness is an HTTP health probe instead of a process-list guess', () => {
  assert.match(source, /api\/godaddy-refresh/);
  assert.match(source, /URLSession\.shared\.dataTask/);
  assert.doesNotMatch(source, /private func isServerListening/);
});

test('a slow server remains recoverable instead of becoming a permanent error screen', () => {
  assert.match(source, /continuing readiness checks/);
  assert.match(source, /This window will recover automatically/);
  assert.match(source, /waiting without restarting it/);
  assert.match(source, /launchctl", \["print", target\]/);
  assert.doesNotMatch(source, /server did not become ready/);
});

test('direct fallback preserves the desktop service isolation flags', () => {
  assert.match(source, /DOMAINSCOUT_EXPIRED_DOGFOOD_ENABLED"\] = "0"/);
  assert.match(source, /DOMAINSCOUT_EXPIRED_DOGFOOD_AFTER_AVAILABILITY"\] = "0"/);
});

test('the injected diagnostics relay remains syntactically balanced', () => {
  assert.equal((source.match(/window\.addEventListener\('error'/g) || []).length, 1);
});

test('the app log identifies the exact installed build', () => {
  assert.match(source, /applicationDidFinishLaunching build=/);
  assert.match(source, /values\["BuildCommit"\]/);
});
