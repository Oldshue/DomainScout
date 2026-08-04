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

console.log('taken-in-ui.test.js: all assertions passed');
