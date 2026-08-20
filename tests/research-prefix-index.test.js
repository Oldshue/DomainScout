'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-prefix-index-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = temp;
const index = require('../server/research-prefix-index');

test('prefix corpus is complete only after every accessible zone succeeds', () => {
  index.startPrefixCorpus('agent', 3, ['com', 'ai', 'shop']);
  index.replacePrefixTldHits('agent', 'com', '2026-08-20', ['agent', 'agentframe']);
  index.replacePrefixTldHits('agent', 'ai', '2026-08-20', ['agent']);
  index.markPrefixTldFailed('agent', 'shop', '2026-08-20');

  const partial = index.finishPrefixCorpus('agent');
  assert.equal(partial.complete, false);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.checked_tlds, 2);
  assert.equal(partial.failed_tlds, 1);

  index.replacePrefixTldHits('agent', 'shop', '2026-08-20', ['agentgauge']);
  const complete = index.finishPrefixCorpus('agent');
  assert.equal(complete.complete, true);
  assert.equal(complete.checked_tlds, 3);
  assert.equal(complete.failed_tlds, 0);
  assert.deepEqual(index.queryPrefixCorpus('agent').map(row => [row.base_name, row.tld_count]), [
    ['agent', 2],
    ['agentframe', 1],
    ['agentgauge', 1],
  ]);
});

test('a changed accessible-zone universe prunes removed zone evidence', () => {
  index.startPrefixCorpus('agent', 2, ['com', 'shop']);
  const rows = index.queryPrefixCorpus('agent');
  assert.deepEqual(rows.map(row => [row.base_name, row.tld_count]), [
    ['agent', 1],
    ['agentframe', 1],
    ['agentgauge', 1],
  ]);
  assert.equal(index.getPrefixCorpusStats('agent').total_tlds, 2);
});
