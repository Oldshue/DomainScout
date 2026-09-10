'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const {
  createLabelExtractor,
  sortUniqueGzip,
  diffSortedGzip,
  countGzipLines,
} = require('../server/universe-extract');

async function runExtractor(tld, lines) {
  const extractor = createLabelExtractor(tld);
  const input = Readable.from(lines.map(l => `${l}\n`));
  const chunks = [];
  extractor.on('data', chunk => chunks.push(chunk));
  await pipeline(input, extractor);
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);
}

function gzipLines(lines) {
  return zlib.gzipSync(Buffer.from(lines.map(l => `${l}\n`).join(''), 'utf8'));
}

async function mkTmp(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('createLabelExtractor: apex NS record with trailing-dot zone name yields base label', async () => {
  const out = await runExtractor('com', ['Example.COM.\t3600\tin\tns\ta.b.']);
  assert.deepEqual(out, ['example']);
});

test('createLabelExtractor: delegated subdomain (4 labels) is not an apex entry', async () => {
  const out = await runExtractor('com', ['ns1.example.com.']);
  assert.deepEqual(out, []);
});

test('createLabelExtractor: missing trailing dot (2 labels) does not match apex rule', async () => {
  const out = await runExtractor('com', ['foo.com']);
  assert.deepEqual(out, []);
});

test('createLabelExtractor: a[3]==tld branch (no trailing dot, name.tld.tld) matches', async () => {
  const out = await runExtractor('com', ['x.com.com']);
  assert.deepEqual(out, ['x']);
});

test('createLabelExtractor: same string WITH trailing dot has 4 fields and does not match', async () => {
  const out = await runExtractor('com', ['x.com.com.']);
  assert.deepEqual(out, []);
});

test('createLabelExtractor: only lines matching the requested tld are extracted', async () => {
  const out = await runExtractor('com', ['example.net.', 'other.com.']);
  assert.deepEqual(out, ['other']);
});

test('createLabelExtractor: whitespace-only or empty lines are skipped', async () => {
  const out = await runExtractor('com', ['', '   ']);
  assert.deepEqual(out, []);
});

test('sortUniqueGzip: real sort produces unique, LC_ALL=C-sorted labels', async () => {
  const tmpDir = await mkTmp('universe-extract-sort-');
  const rawPath = path.join(tmpDir, 'raw.txt');
  const outPath = path.join(tmpDir, 'out.gz');
  await fsp.writeFile(rawPath, 'banana\napple\napple\nApple\nBANANA\n');
  await sortUniqueGzip({ rawPath, outPath, tmpDir });
  const gz = await fsp.readFile(outPath);
  const lines = zlib.gunzipSync(gz).toString('utf8').split('\n').filter(Boolean);
  // Byte-order (LC_ALL=C): uppercase (A=65,B=66) sorts before lowercase (a=97,b=98).
  assert.deepEqual(lines, ['Apple', 'BANANA', 'apple', 'banana']);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('sortUniqueGzip: real sort byte order matches Buffer.compare, not localeCompare', async () => {
  const tmpDir = await mkTmp('universe-extract-byteorder-');
  const rawPath = path.join(tmpDir, 'raw.txt');
  const outPath = path.join(tmpDir, 'out.gz');
  await fsp.writeFile(rawPath, 'a0\na-b\n');
  await sortUniqueGzip({ rawPath, outPath, tmpDir });
  const gz = await fsp.readFile(outPath);
  const sorted = zlib.gunzipSync(gz).toString('utf8').split('\n').filter(Boolean);
  assert.deepEqual(sorted, ['a-b', 'a0']);
  assert.ok(Buffer.compare(Buffer.from('a-b'), Buffer.from('a0')) < 0);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('sortUniqueGzip: non-zero exit rejects and leaves no .part file behind', async () => {
  const tmpDir = await mkTmp('universe-extract-fail-');
  const rawPath = path.join(tmpDir, 'does-not-exist.txt');
  const outPath = path.join(tmpDir, 'out.gz');
  await assert.rejects(() => sortUniqueGzip({ rawPath, outPath, tmpDir }));
  await assert.rejects(() => fsp.access(outPath));
  await assert.rejects(() => fsp.access(`${outPath}.part`));
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('diffSortedGzip: computes adds and drops between two sorted label files', async () => {
  const tmpDir = await mkTmp('universe-extract-diff-');
  const prevPath = path.join(tmpDir, 'prev.gz');
  const todayPath = path.join(tmpDir, 'today.gz');
  await fsp.writeFile(prevPath, gzipLines(['alpha', 'beta', 'gamma']));
  await fsp.writeFile(todayPath, gzipLines(['alpha', 'delta', 'gamma']));
  const adds = [];
  const drops = [];
  const result = await diffSortedGzip({
    prevPath, todayPath,
    onAdd: label => adds.push(label),
    onDrop: label => drops.push(label),
  });
  assert.deepEqual(adds, ['delta']);
  assert.deepEqual(drops, ['beta']);
  assert.equal(result.prevCount, 3);
  assert.equal(result.todayCount, 3);
  assert.equal(result.adds, 1);
  assert.equal(result.drops, 1);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('diffSortedGzip: missing prevPath (no baseline) treats every today label as an add', async () => {
  const tmpDir = await mkTmp('universe-extract-diff-nobaseline-');
  const todayPath = path.join(tmpDir, 'today.gz');
  await fsp.writeFile(todayPath, gzipLines(['alpha', 'beta']));
  const adds = [];
  const result = await diffSortedGzip({
    prevPath: path.join(tmpDir, 'missing.gz'),
    todayPath,
    onAdd: label => adds.push(label),
  });
  assert.deepEqual(adds, ['alpha', 'beta']);
  assert.equal(result.prevCount, 0);
  assert.equal(result.todayCount, 2);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('countGzipLines: counts non-empty lines in a gzip file', async () => {
  const tmpDir = await mkTmp('universe-extract-count-');
  const filePath = path.join(tmpDir, 'labels.gz');
  await fsp.writeFile(filePath, gzipLines(['one', 'two', 'three']));
  const count = await countGzipLines(filePath);
  assert.equal(count, 3);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});
