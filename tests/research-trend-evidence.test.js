'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-trend-evidence-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = temp;
const {
  recordKeywordTrends,
  queryKeywordTrends,
  getWordTrends,
  getWordTrendHistory,
  __test,
} = require('../server/zone-indexer');

test('research trend evidence preserves date, source, and exact extension set', () => {
  recordKeywordTrends(new Map([
    ['agentframe', new Set(['.ai', '.com', '.io'])],
    ['agentforge', new Set(['.ai', '.com'])],
    ['routerframe', new Set(['.net', '.org'])],
    ['agentsolo', new Set(['.com'])],
    ['superagent', new Set(['.tv'])],
    ['coolagent', new Set(['.rocks'])],
  ]), '2026-08-20');

  const rows = queryKeywordTrends('agent', 'prefix');
  assert.deepEqual(rows.map(row => row.keyword), ['agentframe', 'agentforge']);
  assert.equal(rows[0].trend_date, '2026-08-20');
  assert.equal(rows[0].new_tld_count, 3);
  assert.equal(rows[0].source, 'daily-diff');
  assert.deepEqual(rows[0].tlds, ['.ai', '.com', '.io']);
});

test('an unrelated prefix cannot leak into trend research', () => {
  assert.deepEqual(queryKeywordTrends('router', 'prefix').map(row => row.keyword), ['routerframe']);
});

test('a repeated word within distinct names becomes a drill-down trend', () => {
  const discovered = __test.discoverRepeatedFragments(['superagent', 'coolagent']);
  assert.ok(discovered.has('agent'));
  assert.ok(__test.extractTrendWords('superagent', discovered).includes('agent'));
  const agent = getWordTrends(100).find(row => row.keyword === 'agent');
  assert.equal(agent.domain_count, 5);
  assert.equal(agent.tld_count, 5);
  assert.equal(agent.source, 'word-within-name-daily-diff');
  assert.equal(agent.mirrored_name_count, 2);
  assert.ok(agent.mirror_rate < 0.5);
  assert.ok(agent.quality_score > 0);

  const detail = getWordTrendHistory('agent');
  const domains = detail.dates[0].registrations.map(row => row.domain);
  assert.ok(domains.includes('coolagent.rocks'));
  assert.ok(domains.includes('superagent.tv'));
});

test('mirrored product batches do not become meaningful lexical trends', () => {
  const mirroredTlds = new Set(Array.from({ length: 40 }, (_, index) => `.mirror${index}`));
  recordKeywordTrends(new Map([
    ['embeddingdesk', new Set(['.com', '.net', '.org'])],
    ['embeddingdock', new Set(['.com', '.net', '.org'])],
    ['ihwhirhqier', mirroredTlds],
    ['solarharbor', new Set(['.energy'])],
    ['solarweave', new Set(['.green'])],
    ['unrelatedone', new Set(['.ai'])],
  ]), '2026-08-21');

  const trends = getWordTrends(100);
  assert.equal(trends.some(row => row.keyword === 'embedding'), false);
  assert.equal(trends.some(row => row.keyword === 'ihwhirhqier'), false);
  assert.equal(trends.some(row => row.keyword === 'solar'), true);
});
