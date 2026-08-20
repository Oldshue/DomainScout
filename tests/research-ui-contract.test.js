'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');

test('research visibly requests and reports complete prefix coverage', () => {
  assert.match(app, /const completeParam = loadCompletePrefix \? '&all=1' : ''/);
  assert.match(app, /current prefix zones:/);
  assert.match(app, /research-prefix-status/);
  assert.match(app, /Analyzing every accessible zone/);
});

test('extension evidence is sortable and partial counts remain visible as lower bounds', () => {
  assert.match(html, /setResearchSort\('extensions'\)/);
  assert.match(html, /id="research-extensions-sort">↓/);
  assert.match(app, /`≥\$\{displayCount\}`/);
  assert.match(app, /this\._sortResearchNames\(this\._researchAllNames\)/);
});

test('cross-extension trend signal exposes dated TLD evidence and explanation', () => {
  assert.match(html, />Trend evidence</);
  assert.match(app, /openTrendKeyword/);
  assert.match(app, /\$\{trendCount\} TLDs/);
  assert.match(app, /trendWhy/);
  assert.match(app, /trendTlds\.join/);
  assert.match(app, /word in names/);
  assert.match(app, /New names containing/);
  assert.match(app, /registrations\.map/);
});
