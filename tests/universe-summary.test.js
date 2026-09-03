'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const {
  buildUniverseSummaryTape,
  importUniverseSummaryTape,
  openUniverseSummary,
} = require('../server/universe-summary');

async function makeGz(dir, tld, lines) {
  await fs.writeFile(path.join(dir, `${tld}.names.gz`), zlib.gzipSync(`${lines.join('\n')}\n`));
}

async function readTapeLines(tapePath) {
  const gz = await fs.readFile(tapePath);
  const text = zlib.gunzipSync(gz).toString('utf8');
  return text.split('\n').filter(Boolean);
}

async function tmpDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('builds a universe-summary tape with correct byte order and counts', async t => {
  const namesDir = await tmpDir(t, 'domainscout-us-names-');
  const outDir = await tmpDir(t, 'domainscout-us-out-');
  await makeGz(namesDir, 'com', ['agent', 'agentmemory', 'agents', 'bad.label', 'zzz']);
  await makeGz(namesDir, 'net', ['agent', 'agentmemory', 'mango']);
  await makeGz(namesDir, 'ai', ['agent', 'kiwi']);
  await makeGz(namesDir, 'xyz', ['agent', 'apple']);

  const meta = await buildUniverseSummaryTape({ namesDir, day: '2026-09-01', outDir });

  assert.equal(meta.zones, 4);
  assert.equal(meta.namesTotal, 7);
  assert.equal(meta.namesMulti, 2);
  assert.deepEqual(meta.zoneLabelCounts, { com: 4, net: 3, ai: 2, xyz: 2 });

  const lines = await readTapeLines(meta.tapePath);
  assert.deepEqual(lines, [
    'agent\t4\t.ai,.com,.net,.xyz',
    'agentmemory\t2\t.com,.net',
  ]);
});

test('imports a tape into a read model and answers queries', async t => {
  const namesDir = await tmpDir(t, 'domainscout-us-names2-');
  const outDir = await tmpDir(t, 'domainscout-us-out2-');
  const dataDir = await tmpDir(t, 'domainscout-us-data-');
  await makeGz(namesDir, 'com', ['agent', 'agentmemory', 'agents']);
  await makeGz(namesDir, 'net', ['agent', 'agentmemory']);
  await makeGz(namesDir, 'ai', ['agent']);
  await makeGz(namesDir, 'xyz', ['agent']);

  const built = await buildUniverseSummaryTape({ namesDir, day: '2026-09-01', outDir });
  await importUniverseSummaryTape({ tapePath: built.tapePath, dataDir });

  const summary = openUniverseSummary(dataDir);
  assert.ok(summary);
  assert.equal(summary.status().day, '2026-09-01');
  assert.equal(summary.status().source, 'universe-summary');

  const prefixRows = summary.query('agent', 'prefix');
  assert.deepEqual(prefixRows.map(r => r.base_name), ['agent', 'agentmemory']);
  assert.equal(prefixRows[0].tld_list, '.ai,.com,.net,.xyz');
  assert.equal(prefixRows[1].tld_list, '.com,.net');

  const suffixRows = summary.query('memory', 'suffix');
  assert.deepEqual(suffixRows.map(r => r.base_name), ['agentmemory']);

  assert.equal(summary.count('agent', 'prefix'), 2);

  const exact = summary.nameZones('agent');
  assert.deepEqual(exact, { exact: true, tlds: ['.ai', '.com', '.net', '.xyz'] });
  const absent = summary.nameZones('agents');
  assert.deepEqual(absent, { exact: false, tlds: [] });

  const many = summary.lookupMany(['agent', 'agentmemory', 'agents']);
  assert.equal(many.size, 2);
  assert.ok(many.has('agent'));
  assert.ok(many.has('agentmemory'));
  assert.ok(!many.has('agents'));

  assert.deepEqual(summary.zoneTldSet(), new Set(['.ai', '.com', '.net', '.xyz']));

  const namesDir2 = await tmpDir(t, 'domainscout-us-names3-');
  const outDir2 = await tmpDir(t, 'domainscout-us-out3-');
  await makeGz(namesDir2, 'com', ['agent', 'agentmemory']);
  await makeGz(namesDir2, 'net', ['agent']);
  const built2 = await buildUniverseSummaryTape({ namesDir, day: '2026-09-02', outDir: outDir2, namesDir: namesDir2 });
  await importUniverseSummaryTape({ tapePath: built2.tapePath, dataDir });

  const summary2 = openUniverseSummary(dataDir);
  assert.equal(summary2.status().day, '2026-09-02');
});
