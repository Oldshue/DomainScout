'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boundedRankedPageRequest, projectRankedPage } = require('../server/bounded-ranked-page');

test('bounds an unrelated warehouse catalog prefix page', () => {
  assert.deepEqual(
    boundedRankedPageRequest({ offset: '-4', limit: '20000' }),
    { offset: 0, limit: 500 },
  );
  const inventory = [
    { sku: 'warehouse-rack', demand: 7 },
    { sku: 'warehouse-bin', demand: 11 },
    { sku: 'warehouse-cart', demand: 9 },
  ];
  const result = projectRankedPage(inventory, {
    offset: 1,
    limit: 1,
    compare: (a, b) => b.demand - a.demand || a.sku.localeCompare(b.sku),
  });
  assert.deepEqual(result.rows.map(row => row.sku), ['warehouse-cart']);
  assert.equal(result.rows[0].rank, 2, 'producer rank survives unrelated warehouse page hydration');
  assert.equal(result.hasMoreCandidates, true);
});

test('research loads a bounded first page and fetches later pages on demand', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(appSource, /_researchPageSize:\s*100/);
  assert.match(appSource, /_researchLookaheadPages:\s*4/);
  assert.match(appSource, /offset=0&pageSize=\$\{requestSize\}/);
  assert.match(appSource, /offset=\$\{base\.length\}&pageSize=\$\{limit\}/);
  assert.doesNotMatch(appSource, /_researchPageSize\s*\*\s*20/);
});

test('research defers enrichment until rapid paging settles', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(appSource, /clearTimeout\(this\._researchEnhanceTimer\)/);
  assert.match(appSource, /this\._researchPage\s*!==\s*visiblePage/);
  const timer = appSource.match(/this\._researchEnhanceTimer = setTimeout\(\(\) => \{([\s\S]*?)\}, 650\)/)?.[1] || '';
  assert.doesNotMatch(timer, /researchCheckAll/);
  assert.match(appSource, /void this\.researchCheckAll\('page'\)/);
});

test('research preserves server-owned ranks while exact prices hydrate in place', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.doesNotMatch(appSource, /this\._researchAllNames\.sort/);
  assert.doesNotMatch(appSource, /this\._researchBaseList\.sort/);
  assert.match(appSource, /name\.rank = Number\(name\.rank\) \|\| \(base\.length \+ 1\)/);
  assert.match(appSource, /id="research-\$\{idSuffix\}"/);
  assert.match(appSource, /info\.price != null && \(info\.live === true \|\| info\.checked === true\)/);
});

test('optional registrar enrichment degrades to lander checks without a failed request', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  const bulkRoute = serverSource.slice(
    serverSource.indexOf("app.post('/api/bulk-availability'"),
    serverSource.indexOf('// ── GET /api/lander-check'),
  );
  assert.match(bulkRoute, /configured:\s*false/);
  assert.match(bulkRoute, /reason:\s*'registrar_not_configured'/);
  assert.doesNotMatch(bulkRoute, /status\(503\)/);
});
