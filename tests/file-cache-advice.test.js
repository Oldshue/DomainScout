'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { releaseOwnFileCache } = require('../server/file-cache-advice');

test('file-cache advice is bounded to explicit absolute regular files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-fadvise-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'owned.dat'), link = path.join(root, 'link.dat');
  await fs.writeFile(file, Buffer.alloc(1024 * 1024, 7));
  await fs.symlink(file, link);
  const result = await releaseOwnFileCache([file, file, link, 'relative.dat']);
  if (process.platform === 'linux') {
    assert.equal(result.supported, true);
    assert.equal(result.advised, 1, 'dedupes the regular file and rejects the symlink');
  } else {
    assert.deepEqual(result, { supported: false, advised: 0 });
  }
  assert.equal((await fs.stat(file)).size, 1024 * 1024, 'advice never changes file bytes');
});

test('market sibling memory phase releases the provider module cache before admission', async () => {
  const body = await fs.readFile(path.join(__dirname, '../server/market-sibling-scan-worker.js'), 'utf8');
  const release = body.indexOf('releaseGoDaddyInventoryCaches(stream)');
  const advise = body.indexOf('await adviseGoDaddyInventoryFileCache(stream)');
  const announce = body.indexOf('announceMemoryPhaseComplete(candidates.length)');
  assert.ok(release > 0 && advise > release && announce > advise);
});
