'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadFrontend(search) {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const context = {
    URLSearchParams,
    window: {
      location: { protocol: 'http:', search, pathname: '/' },
      history: { pushState() {}, replaceState() {} },
    },
    document: { addEventListener() {} },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  context.__app.applyUrlParamsToState();
  return context;
}

const shared = loadFrontend('?stream=just-dropped&tld=.ai&takenIn=.dev,.shop&takenInMode=any&sortField=taken_in_status&sortDir=ASC');
assert.strictEqual(shared.__state.stream, 'just-dropped');
assert.strictEqual(shared.__state.tld, '.ai');
assert.deepStrictEqual([...shared.__state.takenInTlds], ['.dev', '.shop']);
assert.strictEqual(shared.__state.takenInMode, 'any');
assert.strictEqual(shared.__state.sortField, 'taken_in_status');
assert.strictEqual(shared.__state.sortDir, 'ASC');

const legacy = loadFrontend('?stream=just-dropped&tld=.ai&takenIn=.app');
assert.strictEqual(legacy.__state.takenInMode, 'taken');
assert.deepStrictEqual([...legacy.__state.takenInTlds], ['.app']);

assert.strictEqual(shared.__app.normalizeTakenInTld('SHOP'), '.shop');
assert.strictEqual(shared.__app.normalizeTakenInTld('not a tld'), null);

const expired = loadFrontend('?stream=_expired14&tld=.ai');
expired.__state.expiredCoverage = { complete: true };
assert.strictEqual(
  expired.__app.registrationOutboundUrl({
    domain: 'real-drop.ai', stream: 'just-dropped', registration_available: 1,
    drop_date: '2026-08-04', availability_checked_at: '2026-08-04T14:00:00Z',
  }),
  'https://www.spaceship.com/domain-search/?query=real-drop.ai&beast=false&tab=domains'
);
assert.strictEqual(expired.__app.registrationOutboundUrl({
  domain: 'still-pending.ai', stream: 'pending-delete', registration_available: 1,
  drop_date: '2026-08-04', availability_checked_at: '2026-08-04T14:00:00Z',
}), null, 'Pending names must never receive a registrar action');
expired.__state.expiredCoverage = { complete: false };
assert.strictEqual(expired.__app.registrationOutboundUrl({
  domain: 'partial.ai', stream: 'just-dropped', registration_available: 1,
  drop_date: '2026-08-04', availability_checked_at: '2026-08-04T14:00:00Z',
}), null, 'Incomplete universes must never receive a registrar action');

const frontendSource = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
assert.ok(frontendSource.includes('no partial results shown'));
assert.ok(frontendSource.includes('Partial names are intentionally hidden.'));
assert.ok(frontendSource.includes('Pending delete${tld} · not registerable yet'));
assert.ok(frontendSource.includes('Register ${this._escapeHtml(d.domain)} at Spaceship'));

console.log('taken-in-ui.test.js: all assertions passed');
