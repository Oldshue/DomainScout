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
  META_TRAILER_PREFIX,
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
  // Single-zone membership: every label in exactly ONE non-anchor zone is carried
  // so an absent label is exactly "in no zone except possibly an anchor (.com)".
  assert.equal(meta.singleZone.enabled, true);
  assert.deepEqual(meta.singleZone.anchors, ['com']);
  assert.equal(meta.singleZone.namesSingle, 3);
  assert.deepEqual(meta.singleZone.counts, { com: 0, net: 1, ai: 1, xyz: 1 });

  const lines = (await readTapeLines(meta.tapePath)).filter(line => !line.startsWith('#'));
  assert.deepEqual(lines, [
    'agent\t4\t.ai,.com,.net,.xyz',
    'agentmemory\t2\t.com,.net',
    'apple\t1\t.xyz',
    'kiwi\t1\t.ai',
    'mango\t1\t.net',
  ]);
});

test('single-zone membership can be disabled, and anchors are configurable', async t => {
  const namesDir = await tmpDir(t, 'domainscout-us-names-sz-');
  const outDir = await tmpDir(t, 'domainscout-us-out-sz-');
  await makeGz(namesDir, 'com', ['agent', 'solo-com']);
  await makeGz(namesDir, 'net', ['agent', 'solo-net']);
  await makeGz(namesDir, 'ai', ['solo-ai']);

  const off = await buildUniverseSummaryTape({ namesDir, day: '2026-09-01', outDir, singleZone: false });
  assert.equal(off.singleZone.enabled, false);
  assert.equal(off.singleZone.namesSingle, 0);
  assert.deepEqual((await readTapeLines(off.tapePath)).filter(l => !l.startsWith('#')), ['agent\t2\t.com,.net']);

  const outDir2 = await tmpDir(t, 'domainscout-us-out-sz2-');
  const anchored = await buildUniverseSummaryTape({ namesDir, day: '2026-09-01', outDir: outDir2, singleZoneAnchors: ['.com', 'net'] });
  assert.deepEqual(anchored.singleZone.anchors, ['com', 'net']);
  assert.equal(anchored.singleZone.namesSingle, 1);
  assert.deepEqual((await readTapeLines(anchored.tapePath)).filter(l => !l.startsWith('#')), [
    'agent\t2\t.com,.net',
    'solo-ai\t1\t.ai',
  ]);
});

test('imports a tape into a read model and answers queries', async t => {
  const namesDir = await tmpDir(t, 'domainscout-us-names2-');
  const outDir = await tmpDir(t, 'domainscout-us-out2-');
  const dataDir = await tmpDir(t, 'domainscout-us-data-');
  await makeGz(namesDir, 'com', ['agent', 'agentmemory', 'agents']);
  await makeGz(namesDir, 'net', ['agent', 'agentmemory', 'mango']);
  await makeGz(namesDir, 'ai', ['agent']);
  await makeGz(namesDir, 'xyz', ['agent']);

  const built = await buildUniverseSummaryTape({ namesDir, day: '2026-09-01', outDir });
  // The tape is self-describing: its last line is the meta trailer, so an
  // importer that never sees the .meta.json sidecar still learns every zone.
  const tapeLines = await readTapeLines(built.tapePath);
  assert.ok(tapeLines[tapeLines.length - 1].startsWith(META_TRAILER_PREFIX));
  assert.equal(JSON.parse(tapeLines[tapeLines.length - 1].slice(META_TRAILER_PREFIX.length)).zones, 4);
  await fs.unlink(built.metaPath);
  await importUniverseSummaryTape({ tapePath: built.tapePath, dataDir });

  const summary = openUniverseSummary(dataDir);
  assert.ok(summary);
  assert.equal(summary.status().day, '2026-09-01');
  assert.equal(summary.status().source, 'universe-summary');
  assert.equal(summary.status().namesMulti, 2);
  assert.equal(summary.status().namesSingle, 1);
  assert.deepEqual(summary.status().singleZone, { enabled: true, anchors: ['com'], namesSingle: 1 });
  assert.ok(summary.status().bytes > 0);

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
  // Single-zone labels are exact through nameZones too, but never enter name_summary.
  assert.deepEqual(summary.nameZones('mango'), { exact: true, tlds: ['.net'] });
  assert.equal(summary.count('mango', 'prefix'), 0);

  // zoneMembership is exact for EVERY label: multi-zone, single-zone, anchor-only, and
  // zero-zone. Absent labels resolve to "no zone except possibly the anchor", which
  // needs exactly one lookup (.com) while every other zone is exact not-taken.
  assert.equal(summary.exactForAbsentLabels(), true);
  assert.deepEqual(summary.zoneMembership('agent'),
    { exact: true, tlds: ['.ai', '.com', '.net', '.xyz'], unresolved: [], source: 'multi-zone' });
  assert.deepEqual(summary.zoneMembership('mango'),
    { exact: true, tlds: ['.net'], unresolved: [], source: 'single-zone' });
  assert.deepEqual(summary.zoneMembership('agents'),
    { exact: true, tlds: [], unresolved: ['.com'], source: 'absent' });
  assert.deepEqual(summary.zoneMembership('never-registered-anywhere'),
    { exact: true, tlds: [], unresolved: ['.com'], source: 'absent' });

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

test('a failed final rename preserves the previous complete summary', async t => {
  const namesDir = await tmpDir(t, 'domainscout-us-atomic-names-');
  const outDir = await tmpDir(t, 'domainscout-us-atomic-out-');
  const dataDir = await tmpDir(t, 'domainscout-us-atomic-data-');
  await makeGz(namesDir, 'com', ['orchard']);
  await makeGz(namesDir, 'net', ['orchard']);
  const first = await buildUniverseSummaryTape({ namesDir, day: '2026-09-11', outDir });
  await importUniverseSummaryTape({ tapePath: first.tapePath, dataDir });
  const finalPath = path.join(dataDir, 'universe_summary.db');
  const prior = await fs.readFile(finalPath);
  const next = await buildUniverseSummaryTape({ namesDir, day: '2026-09-15', outDir });
  const syncFs = require('node:fs'), rename = syncFs.renameSync;
  syncFs.renameSync = (from, to) => {
    if (to === finalPath) throw new Error('injected publication failure');
    return rename(from, to);
  };
  try {
    await assert.rejects(importUniverseSummaryTape({ tapePath: next.tapePath, dataDir }), /injected publication failure/);
  } finally { syncFs.renameSync = rename; }
  assert.deepEqual(await fs.readFile(finalPath), prior);
  assert.equal(openUniverseSummary(dataDir).status().day, '2026-09-11');
  await importUniverseSummaryTape({ tapePath: next.tapePath, dataDir });
  assert.equal(openUniverseSummary(dataDir).status().day, '2026-09-15');
});
