'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

function loadFrontend(overrides = {}) {
  const timers = [];
  const frames = [];
  const body = {};
  const tableWrap = overrides.tableWrap || { contains: () => false };
  const elements = {
    'domain-modal': { style: { display: 'none' } },
    'tld-modal': { style: { display: 'none' } },
    ...(overrides.elements || {}),
  };
  const document = {
    body,
    activeElement: overrides.activeElement || body,
    addEventListener() {},
    getElementById(id) { return elements[id] || null; },
    querySelector(selector) {
      if (selector === '.table-wrap') return tableWrap;
      return null;
    },
  };
  const context = {
    URLSearchParams,
    AbortController,
    console,
    document,
    window: {
      location: { protocol: 'http:', search: '', pathname: '/' },
      history: { pushState() {}, replaceState() {} },
    },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    fetch: overrides.fetch || (async () => ({ ok: true, json: async () => ({}) })),
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state;`, context);
  return { app: context.__app, state: context.__state, document, elements, tableWrap, timers, frames };
}

test('focused row actions and filter fields count as active work', () => {
  const rowButton = { tagName: 'BUTTON', matches: () => false };
  const rowWrap = { contains: (node) => node === rowButton };
  const row = loadFrontend({ activeElement: rowButton, tableWrap: rowWrap });
  assert.equal(row.app.isUserActivelyInteracting(), true);

  const filter = { tagName: 'INPUT', matches: (selector) => selector.includes('input') };
  const form = loadFrontend({ activeElement: filter });
  assert.equal(form.app.isUserActivelyInteracting(), true);
});

test('deferred background freshness executes once the user becomes idle', () => {
  const { app, timers } = loadFrontend();
  let busy = true;
  let executions = 0;
  app.isUserActivelyInteracting = () => busy;
  app.deferListReloadIfInteracting(() => { executions += 1; });
  assert.equal(executions, 0);
  assert.equal(timers.length, 1);

  busy = false;
  timers.shift()();
  assert.equal(executions, 1);
});

test('provider-neutral background reloads explicitly preserve the viewport', () => {
  const { app } = loadFrontend();
  let received;
  app.isUserActivelyInteracting = () => false;
  app.loadDomains = (options) => { received = options; };
  app.scheduleBackgroundListReload();
  assert.equal(received?.preserveViewport, true);
  assert.deepEqual(Object.keys(received), ['preserveViewport']);
});

test('startup is bounded and tool panels can cancel unrelated inventory work', () => {
  const fixture = loadFrontend({
    elements: {
      'loading-bar': { style: { display: 'block' } },
      'domain-tbody': { style: { opacity: '0.35' } },
    },
  });
  assert.equal(fixture.state.stream, 'godaddy-auction');
  fixture.app.cancelDomainLoad();
  assert.equal(fixture.elements['loading-bar'].style.display, 'none');
  assert.equal(fixture.elements['domain-tbody'].style.opacity, '');
  assert.match(source, /if \(this\._toolPanels\.includes\(state\.stream\)\)/);
});

test('deep scroll position is reapplied through every progressive render chunk', () => {
  let renderedRows = 0;
  const requestedScrolls = [];
  const tableWrap = {
    contains: () => false,
    get scrollTop() { return this._scrollTop || 0; },
    set scrollTop(value) {
      requestedScrolls.push(value);
      const maximum = Math.max(0, renderedRows * 20 - 100);
      this._scrollTop = Math.min(value, maximum);
    },
  };
  const tbody = {
    children: [],
    style: {},
    set innerHTML(html) { renderedRows = (html.match(/<tr>/g) || []).length; },
    insertAdjacentHTML(_position, html) { renderedRows += (html.match(/<tr>/g) || []).length; },
  };
  const elements = {
    'domain-tbody': tbody,
    'empty-state': { style: {} },
  };
  const fixture = loadFrontend({ tableWrap, elements });
  fixture.state.stream = 'all';
  fixture.document.querySelector = (selector) => {
    if (selector === '.table-wrap') return tableWrap;
    if (selector === 'thead th.col-stream') return { style: {} };
    return null;
  };
  fixture.app.renderRow = () => '<tr></tr>';
  fixture.app.setupTldObserver = () => {};
  fixture.app._scheduleLive = () => {};
  const domains = Array.from({ length: 600 }, (_, index) => ({ id: index + 1 }));

  fixture.app.renderTable(domains, { tableWrap, preservedScrollTop: 8000 });
  assert.equal(tableWrap.scrollTop, 1900, 'the first 100-row paint necessarily clamps a deep position');
  while (fixture.frames.length) fixture.frames.shift()();

  assert.equal(tableWrap.scrollTop, 8000, 'later chunks must reapply the requested deep position');
  assert.ok(requestedScrolls.length >= 6, 'the position is restored after the initial paint and every appended chunk');
});

test('unserveable inventory still fails closed immediately', () => {
  const start = source.indexOf('async monitorGoDaddyInventory()');
  const end = source.indexOf('\n  },', start);
  const monitor = source.slice(start, end);
  assert.match(monitor, /if \(!health\?\.serveable\) \{\s*\/\/[\s\S]*?await this\.loadDomains\(\{ preserveViewport: true \}\);/);
  assert.match(monitor, /health\.generatedAt[\s\S]*?this\.scheduleBackgroundListReload\(\);/);
});

test('Namecheap freshness uses the same deferral and fail-closed contract', async () => {
  const blocked = loadFrontend({
    fetch: async () => ({
      ok: true,
      json: async () => ({ inventory: { current: false, serveable: false }, running: false }),
    }),
  });
  blocked.state.stream = 'namecheap-auction';
  let blockedReload;
  blocked.app.renderInventoryStatus = () => {};
  blocked.app.loadDomains = async (options) => { blockedReload = options; };
  await blocked.app.monitorGoDaddyInventory();
  assert.equal(blockedReload?.preserveViewport, true, 'unserveable Namecheap rows must be withheld immediately');

  const refreshed = loadFrontend({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        inventory: { current: true, serveable: true, generatedAt: 'new-generation' },
        running: false,
      }),
    }),
  });
  refreshed.state.stream = 'namecheap-auction';
  refreshed.state.currentInventoryGeneratedAt = 'old-generation';
  let scheduled = 0;
  refreshed.app.renderInventoryStatus = () => {};
  refreshed.app.loadStats = async () => {};
  refreshed.app.loadDomains = async () => { throw new Error('serveable background refresh must be deferred'); };
  refreshed.app.scheduleBackgroundListReload = () => { scheduled += 1; };
  await refreshed.app.monitorGoDaddyInventory();
  assert.equal(scheduled, 1);
});
