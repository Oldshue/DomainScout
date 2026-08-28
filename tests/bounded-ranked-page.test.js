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
  assert.equal(result.hasMoreCandidates, true);
});

test('research loads a bounded first page and fetches later pages on demand', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(appSource, /_researchPageSize:\s*100/);
  assert.match(appSource, /offset=0&pageSize=\$\{pageSize\}/);
  assert.match(appSource, /offset=\$\{base\.length\}&pageSize=\$\{limit\}/);
  assert.doesNotMatch(appSource, /_researchPageSize\s*\*\s*20/);
});
