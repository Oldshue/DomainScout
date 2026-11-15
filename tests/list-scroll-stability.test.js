'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

function loadFrontend(overrides = {}) {
  const timers = [];
  const clearedTimers = new Set();
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
    setTimeout(fn, delay) {
      fn.delayMs = delay;
      fn.timerId = timers.length + 1;
      timers.push(fn);
      return fn.timerId;
    },
    clearTimeout(id) { clearedTimers.add(id); },
    setInterval() {},
    clearInterval() {},
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    fetch: overrides.fetch || (async () => ({ ok: true, json: async () => ({}) })),
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state; globalThis.__fetchJsonWithDeadline = fetchJsonWithDeadline;`, context);
  return {
    app: context.__app,
    state: context.__state,
    fetchJsonWithDeadline: context.__fetchJsonWithDeadline,
    document,
    elements,
    tableWrap,
    timers,
    clearedTimers,
    frames,
  };
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

test('inventory warm-up retries back off, are request-scoped, and stop after two minutes', () => {
  const { app } = loadFrontend();
  const startedAt = 1_000_000;
  assert.equal(app._inventoryRetryDelay('auction|com', 2000, startedAt), 2000);
  assert.equal(app._inventoryRetryDelay('auction|com', 0, startedAt + 2000), 2000);
  assert.equal(app._inventoryRetryDelay('auction|com', 9000, startedAt + 4000), 9000);
  assert.equal(app._inventoryRetryDelay('auction|com', 0, startedAt + 120001), null);
  assert.equal(app._inventoryRetryDelay('closeout|net', 0, startedAt + 120001), 1000, 'a different request gets its own budget');
});

test('alternating inventory failure classes share one foreground retry budget', () => {
  const { app } = loadFrontend();
  const startedAt = 2_000_000;
  app._activateInventoryRequestScope('stream=godaddy-auction&tld=com');
  assert.equal(app._inventoryRetryDelay('stream=godaddy-auction&tld=com', 2000, startedAt), 2000);
  // A network failure after a warming response must not start a second lane.
  assert.equal(app._inventoryRetryDelay('stream=godaddy-auction&tld=com', 0, startedAt + 119_000), 1000);
  assert.equal(app._inventoryRetryDelay('stream=godaddy-auction&tld=com', 0, startedAt + 120_000), null);
});

test('bounded unattended recovery restores a healed request and ignores stale navigation', () => {
  const { app, timers } = loadFrontend();
  let loads = 0;
  app.loadDomains = () => { loads += 1; };
  app._activateInventoryRequestScope('stream=godaddy-auction&tld=com');
  assert.equal(app._scheduleInventoryRecovery('stream=godaddy-auction&tld=com'), 30_000);
  assert.equal(timers.at(-1).delayMs, 30_000);
  timers.at(-1)();
  assert.equal(loads, 1, 'a healed lane is probed without manual action');

  app._scheduleInventoryRecovery('stream=godaddy-auction&tld=com');
  const staleProbe = timers.at(-1);
  app._activateInventoryRequestScope('stream=godaddy-closeout&tld=net');
  staleProbe();
  assert.equal(loads, 1, 'a recovery callback cannot reload a newer navigation scope');
});

test('domain request deadline covers stalled headers and clears its timer', async () => {
  let fetchCalls = 0;
  const fixture = loadFrontend();
  const pending = fixture.fetchJsonWithDeadline('/api/domains', {
    timeoutMs: 25,
    fetchImpl: async () => { fetchCalls += 1; return new Promise(() => {}); },
  });
  const deadline = fixture.timers.at(-1);
  deadline();
  await assert.rejects(pending, error => error?.code === 'REQUEST_DEADLINE');
  assert.equal(fetchCalls, 1);
  assert.ok(fixture.clearedTimers.has(deadline.timerId));
});

test('domain request deadline covers a response body that never settles without duplicate reads', async () => {
  let fetchCalls = 0;
  let bodyReads = 0;
  const fixture = loadFrontend();
  const pending = fixture.fetchJsonWithDeadline('/api/domains', {
    timeoutMs: 25,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { json: () => { bodyReads += 1; return new Promise(() => {}); } };
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  const deadline = fixture.timers.at(-1);
  deadline();
  await assert.rejects(pending, error => error?.name === 'RequestDeadlineError');
  assert.equal(fetchCalls, 1);
  assert.equal(bodyReads, 1);
});

test('successful domain body cleanup cancels its deadline', async () => {
  const fixture = loadFrontend();
  const result = await fixture.fetchJsonWithDeadline('/api/domains', {
    timeoutMs: 25,
    fetchImpl: async () => ({ status: 200, json: async () => ({ domains: [{ domain: 'healthy.test' }] }) }),
  });
  assert.equal(result.data.domains[0].domain, 'healthy.test');
  assert.ok(fixture.clearedTimers.size > 0);
});

test('navigation cancels a stalled request silently before its deadline', async () => {
  const navigation = new AbortController();
  const fixture = loadFrontend();
  const pending = fixture.fetchJsonWithDeadline('/api/domains', {
    signal: navigation.signal,
    timeoutMs: 25,
    fetchImpl: async () => new Promise(() => {}),
  });
  navigation.abort();
  await assert.rejects(pending, error => error?.name === 'AbortError');
  assert.ok(fixture.clearedTimers.size > 0);
});

function loadDomainsFixture(fetchImpl) {
  const tbody = { children: [], style: {}, removeAttribute() {}, setAttribute() {} };
  const elements = {
    'loading-bar': { style: { display: 'none' } },
    'domain-tbody': tbody,
    'result-count': { textContent: '' },
    'empty-state': { style: {} },
  };
  const fixture = loadFrontend({ elements, fetch: fetchImpl });
  fixture.app.applyStreamDefaultSort = () => {};
  fixture.app.updateDateHeaders = () => {};
  fixture.app.updateExpiredStatus = () => {};
  fixture.app._clearLiveTimer = () => {};
  fixture.app.renderTableLoading = () => {};
  fixture.app.renderTableFailure = () => {};
  fixture.app.renderInventoryStatus = () => {};
  fixture.app.updatePagination = () => {};
  fixture.app.scheduleSiblingCoverageRefresh = () => {};
  fixture.app.renderTable = rows => { fixture.renderedRows = rows; tbody.children = rows; };
  fixture.app._domainRequestDeadlineMs = 1;
  fixture.app._inventoryRecoveryBaseMs = 1;
  return fixture;
}

test('a timed-out domain load recovers to healthy rows without a click', async () => {
  let calls = 0;
  const fixture = loadDomainsFixture(async () => {
    calls += 1;
    if (calls === 1) return new Promise(() => {});
    return {
      status: 200,
      ok: true,
      json: async () => ({
        domains: [{ id: 1, domain: 'recovered.test' }], total: 1, page: 1, limit: 250,
        totalCapped: false, inventoryHealth: { current: true, generatedAt: '2026-11-15T00:00:00Z' },
      }),
    };
  });
  fixture.app._inventoryRetryDelay = () => null;

  const stalledLoad = fixture.app.loadDomains();
  fixture.timers.at(-1)();
  await stalledLoad;
  assert.equal(fixture.app._inventoryRecoveryState?.attempt, 1);

  const recoveryProbe = fixture.timers.at(-1);
  await recoveryProbe();
  assert.equal(calls, 2);
  assert.equal(fixture.renderedRows[0].domain, 'recovered.test');
  assert.equal(fixture.app._inventoryRecoveryState, null);
});

test('navigation during a stalled domain load prevents stale render and retry', async () => {
  let calls = 0;
  const fixture = loadDomainsFixture(async () => {
    calls += 1;
    if (calls === 1) return new Promise(() => {});
    return {
      status: 200,
      ok: true,
      json: async () => ({
        domains: [{ id: 2, domain: 'new-scope.test' }], total: 1, page: 1, limit: 250,
        totalCapped: false, inventoryHealth: { current: true, generatedAt: '2026-11-15T00:00:00Z' },
      }),
    };
  });

  const staleLoad = fixture.app.loadDomains();
  fixture.state.tld = '.net';
  const currentLoad = fixture.app.loadDomains();
  await Promise.all([staleLoad, currentLoad]);
  assert.equal(calls, 2);
  assert.equal(fixture.renderedRows[0].domain, 'new-scope.test');
  assert.equal(fixture.app._inventoryRecoveryState, null);
  assert.equal(fixture.elements['result-count'].textContent, '1 domains');
});

test('inventory failure state offers an explicit manual recovery control', () => {
  const tbody = {
    style: {},
    removeAttribute() {},
    setAttribute() {},
    set innerHTML(value) { this.html = value; },
  };
  const { app } = loadFrontend({
    elements: {
      'domain-tbody': tbody,
      'empty-state': { style: {} },
    },
  });
  app._clearLiveTimer = () => {};
  app.renderTableFailure('Verified auction list is unavailable', 'The request failed.');
  assert.match(tbody.html, /role="alert"/);
  assert.match(tbody.html, /app\.retryDomainLoad\(\)/);
  assert.doesNotMatch(tbody.html, /table-status-spinner/);
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
