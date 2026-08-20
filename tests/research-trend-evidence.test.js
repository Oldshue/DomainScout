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
  assert.ok(__test.extractTrendWords('superagent').includes('agent'));
  assert.ok(__test.extractTrendWords('coolagent').includes('agent'));
  const agent = getWordTrends(100).find(row => row.keyword === 'agent');
  assert.equal(agent.domain_count, 5);
  assert.equal(agent.tld_count, 5);
  assert.equal(agent.source, 'word-within-name-daily-diff');

  const detail = getWordTrendHistory('agent');
  const domains = detail.dates[0].registrations.map(row => row.domain);
  assert.ok(domains.includes('coolagent.rocks'));
  assert.ok(domains.includes('superagent.tv'));
});
