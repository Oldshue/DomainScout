'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFrontend(fetchImpl) {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const history = [];
  const body = { style: {} };
  Object.defineProperty(body, 'innerHTML', {
    get() { return this.value || ''; },
    set(value) { this.value = String(value); history.push(this.value); },
  });
  const elements = {
    'tld-modal': { style: {} },
    'tld-modal-body': body,
    'tld-modal-name': { style: {}, textContent: '' },
    'tld-modal-count': { style: {}, textContent: '' },
    'tld-modal-godaddy': { style: {}, href: '' },
    'tld-modal-namecheap': { style: {}, href: '' },
  };
  const liveSection = { remove() {}, outerHTML: '' };
  const document = {
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
      if (id === 'tld-live-section') return body.innerHTML.includes('tld-live-section') ? liveSection : null;
      return elements[id] || null;
    },
  };
  const context = {
    URLSearchParams,
    window: {
      location: { protocol: 'http:', search: '', pathname: '/' },
      history: { pushState() {}, replaceState() {} },
      innerHeight: 900,
    },
    document,
    fetch: fetchImpl,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  return { app: context.__app, state: context.__state, elements, bodyHistory: history };
}

function trigger() {
  return {
    innerHTML: '',
    getBoundingClientRect() { return { right: 300, top: 120 }; },
    classList: { toggle() {} },
  };
}

test('a partial row opens immediately onto concrete taken-extension evidence', async () => {
  const calls = [];
  const frontend = loadFrontend(async url => {
    calls.push(url);
    if (url.includes('/api/zone-tlds')) return { json: async () => ({ tlds: ['.com', '.io'] }) };
    return { json: async () => ({ status: 'partial', count: null, taken: ['.ai', '.com'] }) };
  });
  frontend.state.domainMap = {
    1: {
      id: 1,
      domain: 'fixture.com',
      tld: '.com',
      tlds_lower_bound: 3,
      taken_in_evidence: [{ tld: '.ai', status: 'taken' }],
    },
  };
  const clicked = trigger();

  await frontend.app.openRowTldModal('fixture', 1, clicked);

  assert.match(frontend.bodyHistory[0], />\.ai</);
  assert.match(frontend.bodyHistory[0], />\.com</);
  assert.match(frontend.bodyHistory[0], /Loading current taken-extension evidence/);
  assert.match(frontend.elements['tld-modal-body'].innerHTML, />\.ai</);
  assert.match(frontend.elements['tld-modal-body'].innerHTML, />\.com</);
  assert.match(frontend.elements['tld-modal-body'].innerHTML, />\.io</);
  assert.equal(frontend.elements['tld-modal-count'].textContent, 'Resolving exact count…');
  assert.match(clicked.innerHTML, /extension-resolving/);
  assert.doesNotMatch(clicked.innerHTML, /3|known|≥/);
  assert.deepEqual(calls.map(url => url.split('?')[0]), ['/api/zone-tlds', '/api/tlds-check-hybrid']);
});

test('an unrelated exact-zero row remains clickable and shows concrete empty evidence', async () => {
  const frontend = loadFrontend(async url => (
    url.includes('/api/zone-tlds')
      ? { json: async () => ({ tlds: [] }) }
      : { json: async () => ({ status: 'complete', count: 0, taken: [] }) }
  ));
  frontend.state.domainMap = {
    2: {
      id: 2,
      domain: 'fixture.shop',
      tld: '.shop',
      registration_available: 1,
      tlds_taken: 0,
      tlds_verified: true,
      tlds_checked_at: '2026-08-25T18:00:00.000Z',
    },
  };
  const clicked = trigger();

  await frontend.app.openRowTldModal('fixture', 2, clicked);

  assert.equal(frontend.elements['tld-modal-count'].textContent, '0 taken');
  assert.match(frontend.elements['tld-modal-body'].innerHTML, /No taken extensions found/);
  assert.equal(clicked.innerHTML, '0');
});

test('a resolving row changes to the exact total only after a complete receipt', async () => {
  const frontend = loadFrontend(async url => (
    url.includes('/api/zone-tlds')
      ? { json: async () => ({ tlds: ['.com'] }) }
      : { json: async () => ({ status: 'complete', count: 2, taken: ['.com', '.shop'] }) }
  ));
  frontend.state.domainMap = {
    3: {
      id: 3,
      domain: 'fixture.com',
      tld: '.com',
      tlds_lower_bound: 19,
      tlds_verified: false,
    },
  };
  const clicked = trigger();

  await frontend.app.openRowTldModal('fixture', 3, clicked);

  assert.equal(frontend.elements['tld-modal-count'].textContent, '2 taken');
  assert.equal(clicked.innerHTML, '2');
  assert.match(frontend.elements['tld-modal-body'].innerHTML, />\.com</);
  assert.match(frontend.elements['tld-modal-body'].innerHTML, />\.shop</);
  assert.doesNotMatch(frontend.elements['tld-modal-count'].textContent, /19|known|≥/);
});
