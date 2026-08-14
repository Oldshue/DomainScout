'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  aggregateTokenMovement,
  boundedRange,
  classifyAvailabilityGap,
  evaluateDropCoverage,
  filterDroppingDomains,
  rankGem,
} = require('../server/zone-intelligence');

test('movement aggregation is deterministic across a bounded date range', () => {
  const range = boundedRange('2026-08-01', '2026-08-03');
  const current = [
    { domain: 'agent-lab.com', event_date: '2026-08-01', kind: 'addition', source: 'zone' },
    { domain: 'agent-lab.net', event_date: '2026-08-02', kind: 'drop', source: 'drop archive' },
    { domain: 'forge.com', event_date: '2026-08-03', kind: 'addition', source: 'zone' },
  ];
  const prior = [{ domain: 'forge.ai', event_date: '2026-07-31', kind: 'addition', source: 'zone' }];
  const rows = aggregateTokenMovement(current, range, prior);
  assert.deepEqual(rows.map(row => [row.token, row.additions, row.drops, row.net, row.rank, row.rankChange]), [
    ['agent', 1, 1, 0, 1, null],
    ['lab', 1, 1, 0, 2, null],
    ['forge', 1, 0, 1, 3, 0],
  ].sort((a, b) => b[3] - a[3] || b[1] - a[1] || a[0].localeCompare(b[0])).map((row, index) => { row[4] = index + 1; return row; }));
  assert.deepEqual(rows.find(row => row.token === 'forge').sparkline, [0, 0, 1]);
});

test('dropping filters cover keyword position, length, cleanliness, TLD and honest word count', () => {
  const rows = [
    { domain: 'bright-agent.com', base_name: 'bright-agent', tld: '.com', length: 12 },
    { domain: 'agentbright.io', base_name: 'agentbright', tld: '.io', length: 11 },
    { domain: 'myagent2.com', base_name: 'myagent2', tld: '.com', length: 8 },
  ];
  assert.deepEqual(filterDroppingDomains(rows, { keyword: 'agent', keywordMode: 'ends', wordCount: 2 }).map(row => row.domain), ['bright-agent.com']);
  assert.deepEqual(filterDroppingDomains(rows, { keyword: 'agent', keywordMode: 'starts', noNumbers: true, noHyphens: true }).map(row => row.domain), ['agentbright.io']);
  assert.deepEqual(filterDroppingDomains(rows, { tld: 'com', maxLength: 9 }).map(row => row.domain), ['myagent2.com']);
});

test('Gems only adds observed fields and explains missing market evidence', () => {
  const base = { domain: 'clear.com', quality_score: 90, quality_reasons: 'short name' };
  const missing = rankGem(base);
  const observed = rankGem({ ...base, tlds_taken: 7, age_years: 8, wayback_snapshots: 20 });
  assert.equal(missing.gemScore, 90);
  assert.match(missing.evidence.join(' '), /missing/);
  assert.ok(observed.gemScore > missing.gemScore);
  assert.equal(rankGem({ ...base, tlds_taken: 7 }).gemScore, rankGem({ ...base, tlds_taken: 7 }).gemScore);
});

test('availability gaps distinguish unknown, taken and confirmed available', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');
  const unknown = classifyAvailabilityGap({ com_status: 'not_taken', com_checked_at: '2026-08-14T11:00:00Z' }, now);
  const taken = classifyAvailabilityGap({ com_status: 'taken', com_checked_at: '2026-08-14T11:00:00Z' }, now);
  const available = classifyAvailabilityGap({ com_registration_available: 1, com_availability_checked_at: '2026-08-14T11:00:00Z', com_availability_source: 'registrar' }, now);
  assert.equal(unknown.comState, 'unknown');
  assert.equal(taken.comState, 'taken');
  assert.equal(available.comState, 'confirmed-available');
  assert.equal(available.gap, true);
});

test('drop coverage is complete only with explicit complete receipts for every cataloged source day', () => {
  const range = boundedRange('2026-08-01', '2026-08-02');
  const catalog = [{ tld: '.com', source: 'fixture', coverage_started_on: '2026-08-01' }];
  const complete = evaluateDropCoverage(catalog, [
    { tld: '.com', source: 'fixture', coverage_date: '2026-08-01', status: 'complete' },
    { tld: '.com', source: 'fixture', coverage_date: '2026-08-02', status: 'complete' },
  ], range);
  assert.equal(complete.complete, true);
  const partial = evaluateDropCoverage(catalog, [
    { tld: '.com', source: 'fixture', coverage_date: '2026-08-01', status: 'partial' },
  ], range);
  assert.equal(partial.complete, false);
  assert.equal(partial.missingReceipts, 1);
  assert.equal(partial.incompleteReceipts, 1);
});

test('frontend wiring includes navigation, shared favorites/export, sparkline and browser-local upload', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../public/js/zone-intelligence.js'), 'utf8');
  assert.match(html, /data-stream="_zoneintel"/);
  assert.match(html, /id="zone-intelligence-panel"/);
  assert.match(html, /accept="\.csv,\.txt/);
  assert.match(html, /zone-intelligence\.js/);
  assert.match(js, /domainscout\.zone-intelligence\.favorites\.v1/);
  assert.match(js, /downloadCsv/);
  assert.match(js, /class="zi-spark"/);
  assert.match(js, /await file\.text\(\)/);
  assert.doesNotMatch(js, /fetch\([^\n]*file/i);
  const server = fs.readFileSync(path.join(__dirname, '../server/zone-intelligence.js'), 'utf8');
  assert.match(server, /FROM drop_events e LEFT JOIN domains d/);
  assert.doesNotMatch(server, /WHERE d\.stream='just-dropped'/);
});
