'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');

test('research reports prefix coverage without auto-starting a universe scan', () => {
  assert.match(app, /const completeParam = ''/);
  assert.match(app, /current prefix zones:/);
  assert.match(app, /research-prefix-status/);
  assert.match(app, /Analyzing every accessible zone/);
  const runResearch = app.slice(app.indexOf('async runResearch('), app.indexOf('_pollResearchPrefix('));
  assert.doesNotMatch(runResearch, /research-prefix-sync/);
  assert.doesNotMatch(runResearch, /'&all=1'/);
});

test('automatic listing hydration is bounded and prioritised over extension refinement', () => {
  const renderStart = app.indexOf('renderResearchResults({ skipSweep = false } = {})');
  const renderResearch = app.slice(renderStart, app.indexOf('_researchTldQ:', renderStart));
  assert.match(renderResearch, /researchCheckAll\('page', \{ maxAuto: 25 \}\)/);
  assert.doesNotMatch(renderResearch, /_sweepHybridCounts\(slice/);
  assert.match(app, /registrarAvailabilityConfigured/);
});

test('listed domains remain visible when a marketplace withholds the asking price', () => {
  assert.match(app, /asking price was not exposed by the source/);
  assert.match(app, /listed ↗/);
});

test('quote enrichment uses bounded indexed lookup instead of materializing provider maps', () => {
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const start = server.indexOf('function enrichResearchSaleInfo(');
  const body = server.slice(start, server.indexOf('function saleInfoFromLander(', start));
  assert.doesNotMatch(body, /readGoDaddyInventoryDomainMap/);
  assert.match(body, /WHERE domain IN/);
});

test('live lander resolution cannot resurrect an expired auction quote', () => {
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const start = server.indexOf('async function resolveLander(');
  const body = server.slice(start, server.indexOf("app.get('/api/lander-check'", start));
  assert.match(body, /stream NOT IN \('godaddy-auction', 'namecheap-auction'\)/);
  assert.match(body, /datetime\(auction_end\) > datetime\('now'\)/);
  assert.match(body, /WHEN stream IN \('marketplace', 'godaddy-premium'\) THEN 1/);
});

test('the name research critical path does not repeat exact quote lookups', () => {
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const start = server.indexOf("app.get('/api/name-research'");
  const route = server.slice(start, server.indexOf("app.post('/api/research-sale-info'", start));
  assert.doesNotMatch(route, /enrichResearchSaleInfo\(sorted/);
  assert.match(route, /const listingRowsMatched =/);
  assert.match(route, /stream NOT IN \('godaddy-auction', 'godaddy-closeout', 'namecheap-auction'\)/);
  assert.match(route, /mergeResearchSaleInfo\(e, '\.com', normalizeSaleInfo\(row\)\)/);
});

test('complete prefix corpus remains the membership and extension-count authority', () => {
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  assert.match(server, /const dbNames = useCompletePrefixCorpus \? \[\] : db\.prepare/);
  assert.match(server, /completePrefixRows\.slice\(0, resultLimit\)/);
  assert.match(server, /if \(!resultMap\[n\.base_name\] && !useCompletePrefixCorpus\)/);
  assert.match(server, /if \(!resultMap\[baseName\] && !useCompletePrefixCorpus\)/);
  assert.match(server, /applyAccessibleZoneProjection\(row, prefixCoverage\)/);
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
