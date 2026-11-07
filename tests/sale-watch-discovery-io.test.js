'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  streamDiscoveryFile, readDiscovery, readDiscoverySafe, writeDiscovery, DiscoveryReadError,
} = require('../server/sale-watch-discovery-io');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-discovery-io-'));
const entry = (i, extra = {}) => ({ domain: `name${i}.example`, reportDate: '2026-11-01', sellerNameservers: ['ns1.dan.com'], note: 'quote " brace } bracket ] comma , colon : é ☃', ...extra });

test('a discovery file larger than the injected string limit streams every element', () => {
  const dir = tmp(), file = path.join(dir, 'd.json');
  const doc = { schema: 'domainscout.sale-watch-discovery/v1', generatedAt: '2026-11-07T00:00:00Z', coverage: { probable: 3 }, entries: Array.from({ length: 400 }, (_, i) => entry(i)), retiredEntries: [entry(1000)], mode: 'public', count: 7, flag: true, none: null };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const limit = 4096; // far smaller than the file: the production-shaped wall
  assert.ok(fs.statSync(file).size > limit * 10);
  assert.throws(() => { const s = fs.readFileSync(file, 'utf8'); if (s.length > limit) throw new RangeError('Cannot create a string longer than limit'); }, RangeError);
  for (const chunkBytes of [64, 97, 1 << 20]) {
    const read = readDiscovery(file, { maxValueBytes: limit, chunkBytes });
    assert.deepEqual(read, doc);
  }
  fs.rmSync(dir, { recursive: true });
});

test('only a single element over the limit is rejected, with a typed error', () => {
  const dir = tmp(), file = path.join(dir, 'd.json');
  fs.writeFileSync(file, JSON.stringify({ entries: [entry(1), entry(2, { blob: 'x'.repeat(5000) })] }));
  assert.throws(() => readDiscovery(file, { maxValueBytes: 1000, chunkBytes: 128 }), e => e instanceof DiscoveryReadError && e.code === 'EDISCOVERYVALUETOOLARGE');
  fs.rmSync(dir, { recursive: true });
});

test('malformed or truncated input is a typed error, never a partial document; missing is null', () => {
  const dir = tmp(), file = path.join(dir, 'd.json');
  assert.equal(readDiscovery(path.join(dir, 'missing.json')), null);
  const full = JSON.stringify({ generatedAt: 'x', entries: [entry(1), entry(2)] });
  fs.writeFileSync(file, full.slice(0, full.length - 20));
  assert.throws(() => readDiscovery(file, { chunkBytes: 64 }), e => e instanceof DiscoveryReadError && e.code === 'EDISCOVERYTRUNCATED');
  fs.writeFileSync(file, '{"entries":[{"domain":}]}');
  assert.throws(() => readDiscovery(file), DiscoveryReadError);
  fs.writeFileSync(file, '[1,2]');
  assert.throws(() => readDiscovery(file), DiscoveryReadError);
  const safe = readDiscoverySafe(file);
  assert.equal(safe.value, null);
  assert.ok(safe.error instanceof DiscoveryReadError);
  fs.rmSync(dir, { recursive: true });
});

test('streamDiscoveryFile visits items without retaining them and filter drops before retention', () => {
  const dir = tmp(), file = path.join(dir, 'd.json');
  fs.writeFileSync(file, JSON.stringify({ entries: Array.from({ length: 50 }, (_, i) => entry(i)), generatedAt: 'g' }));
  let seen = 0; const fields = {};
  const result = streamDiscoveryFile(file, { chunkBytes: 100, onItem: () => { seen += 1; }, onField: (k, v) => { fields[k] = v; } });
  assert.equal(seen, 50); assert.equal(result.items, 50); assert.deepEqual(fields, { generatedAt: 'g' });
  const filtered = readDiscovery(file, { filter: (s, item) => item.domain.endsWith('7.example') });
  assert.deepEqual(filtered.entries.map(e => e.domain), ['name7.example', 'name17.example', 'name27.example', 'name37.example', 'name47.example']);
  fs.rmSync(dir, { recursive: true });
});

test('writeDiscovery round-trips atomically and leaves no temp file', () => {
  const dir = tmp(), file = path.join(dir, 'out', 'd.json');
  const doc = { schema: 's', entries: Array.from({ length: 20 }, (_, i) => entry(i)), movementHistory: [], coverage: { a: 1 } };
  writeDiscovery(file, doc);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), doc);
  assert.deepEqual(readDiscovery(file, { chunkBytes: 70 }), doc);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['d.json']);
  fs.rmSync(dir, { recursive: true });
});
