'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFrontend() {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const headers = ['base', 'tlds', 'com', 'ai'].map(key => {
    const arrow = { textContent: '' };
    return {
      dataset: { researchSort: key },
      attributes: {},
      arrow,
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector(selector) { return selector === '[data-sort-arrow]' ? arrow : null; },
    };
  });
  const document = {
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '[data-research-sort]' ? headers : []; },
  };
  const context = {
    URLSearchParams,
    window: {
      location: { protocol: 'http:', search: '', pathname: '/' },
      history: { pushState() {}, replaceState() {} },
    },
    document,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app;`, context);
  context.__app.renderResearchResults = () => {};
  return { app: context.__app, headers };
}

test('Research exposes real accessible sort controls and a TLD-specific check action', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /onclick="app\.researchCheckTlds\('page'\)"[^>]*>↺ Check TLDs<\/button>/);
  for (const key of ['base', 'tlds', 'com', 'ai']) {
    assert.match(html, new RegExp(`data-research-sort="${key}"[\\s\\S]*?onclick="app\\.researchSort\\('${key}'\\)"`));
  }
  assert.match(html, /data-research-sort="tlds" aria-sort="descending"/);
});

test('Research sorting is deterministic, reversible and leaves unknown TLD values last', () => {
  const { app, headers } = loadFrontend();
  app._researchAllNames = [
    { base_name: 'routerbeta', rank: 2, tlds_taken: 2, tlds_verified: true },
    { base_name: 'routeralpha', rank: 1, tlds_taken: 5, tlds_verified: true },
    { base_name: 'routerpending', rank: 3, tlds_taken: 0, tlds_verified: false, tlds_lower_bound: null, tld_list: [] },
  ];
  app._researchSortKey = 'tlds';
  app._researchSortDir = 'desc';
  app._applyResearchSort();
  assert.deepEqual([...app._researchAllNames.map(name => name.base_name)], ['routeralpha', 'routerbeta', 'routerpending']);
  assert.equal(headers.find(header => header.dataset.researchSort === 'tlds').attributes['aria-sort'], 'descending');

  app.researchSort('tlds');
  assert.deepEqual([...app._researchAllNames.map(name => name.base_name)], ['routerbeta', 'routeralpha', 'routerpending']);
  assert.equal(headers.find(header => header.dataset.researchSort === 'tlds').attributes['aria-sort'], 'ascending');

  app.researchSort('base');
  assert.deepEqual([...app._researchAllNames.map(name => name.base_name)], ['routeralpha', 'routerbeta', 'routerpending']);
  assert.equal(headers.find(header => header.dataset.researchSort === 'base').arrow.textContent, '↑');
});

test('A complete Nameverse receipt replaces pending state in both research collections', () => {
  const { app } = loadFrontend();
  const base = { base_name: 'routeralpha', tlds_taken: 0, tlds_verified: false };
  const visible = { ...base };
  app._researchBaseList = [base];
  app._researchAllNames = [visible];
  const applied = app._applyCompletedResearchTldReceipt('routeralpha', {
    status: 'complete',
    count: 3,
    taken: ['.ai', '.com', '.io'],
    coverage: { completedAt: '2026-08-31T20:00:00.000Z' },
  });
  assert.equal(applied, true);
  assert.deepEqual([base.tlds_taken, base.tlds_verified, base.tld_list.join(',')], [3, true, '.ai,.com,.io']);
  assert.deepEqual([visible.tlds_taken, visible.tlds_verified, visible.tld_list.join(',')], [3, true, '.ai,.com,.io']);
});

test('Research rows never render an unverified zero as an exact count', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(source, /n\.tlds_verified === true \? n\.tlds_taken : null/);
  assert.match(source, /data-tld-state=.*partial/);
  assert.ok(source.includes("displayCount > 0 ? `≥${displayCount}` : 'check'"));
  assert.match(source, /status !== 'complete' \|\| receipt\?\.count == null/);
});
