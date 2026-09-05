'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  parseNsLine,
  delegations,
  buildClassifier,
  classifyNameservers,
  diffZoneDelegations,
  writeZoneMovementTape,
  readZoneMovementTape,
  TAPE_COLUMNS,
} = require('../server/zone-ns-movement');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-ns-movement-'));

function writeGzZone(name, lines) {
  const filePath = path.join(TMP_DIR, name);
  const body = lines.join('\n') + '\n';
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(body, 'utf8')));
  return filePath;
}

async function collect(asyncIterable) {
  const out = [];
  for await (const item of asyncIterable) out.push(item);
  return out;
}

// --- Fixture: delegations() zone with SOA, apex NS, an A and a DS record
// (all of which must be skipped), plus grouped NS records in file order.
const delegationsZonePath = writeGzZone('delegations-com.zone.gz', [
  'com.\t3600\tin\tns\ta.gtld-servers.net.',
  'com.\t3600\tin\tsoa\ta.gtld-servers.net. nstld.verisign-grs.com. 1 2 3 4 5',
  'bar.com.\t3600\tin\ta\t192.0.2.1',
  'bar.com.\t3600\tin\tds\t12345 8 2 ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234',
  'foo.com.\t3600\tin\tns\tns2.example.com.',
  'foo.com.\t3600\tin\tns\tns1.example.com.',
  'zap.com.\t3600\tin\tns\tns1.other.com.',
]);

// --- Fixture: a non-"com" zone to keep the primitive zone-neutral.
const xyzZonePath = writeGzZone('unrelated-xyz.zone.gz', [
  'xyz.\t3600\tin\tns\tsome-registry-ns.example.',
  'foo.xyz.\t3600\tin\tns\tns1.example.net.',
]);

// --- Fixtures for diffZoneDelegations(): prev = {a: registrar, b: seller,
// c: hosting, d: parking}; today = {a: registrar (same), b: hosting
// (changed), c: absent (dropped), d: parking (same), e: seller (added)}.
const prevDiffZonePath = writeGzZone('diff-prev-com.zone.gz', [
  'com.\t3600\tin\tns\ta.gtld-servers.net.',
  'a.com.\t3600\tin\tns\tpdns1.registrar-servers.com.',
  'b.com.\t3600\tin\tns\tns1.afternic.com.',
  'c.com.\t3600\tin\tns\tsomehost.ns.cloudflare.com.',
  'd.com.\t3600\tin\tns\tns1.bodis.com.',
]);
const todayDiffZonePath = writeGzZone('diff-today-com.zone.gz', [
  'com.\t3600\tin\tns\ta.gtld-servers.net.',
  'a.com.\t3600\tin\tns\tpdns1.registrar-servers.com.',
  'b.com.\t3600\tin\tns\tsomehost.ns.cloudflare.com.',
  'd.com.\t3600\tin\tns\tns1.bodis.com.',
  'e.com.\t3600\tin\tns\tns1.afternic.com.',
]);

// --- Fixture with names out of byte order, to prove diffZoneDelegations()
// throws rather than silently producing a wrong merge join.
const outOfOrderZonePath = writeGzZone('out-of-order-com.zone.gz', [
  'com.\t3600\tin\tns\ta.gtld-servers.net.',
  'b.com.\t3600\tin\tns\tns1.example.com.',
  'a.com.\t3600\tin\tns\tns1.example.com.',
]);
const tinyValidZonePath = writeGzZone('tiny-valid-com.zone.gz', [
  'com.\t3600\tin\tns\ta.gtld-servers.net.',
  'a.com.\t3600\tin\tns\tns1.example.com.',
]);

test('parseNsLine: parses a lowercase NS record without trailing dots', () => {
  const parsed = parseNsLine('Foo.COM.\t3600\tin\tns\tNS1.Example.COM.', 'com');
  assert.deepEqual(parsed, { name: 'foo.com', host: 'ns1.example.com' });
});

test('parseNsLine: returns null for the apex', () => {
  assert.equal(parseNsLine('com.\t3600\tin\tns\ta.gtld-servers.net.', 'com'), null);
});

test('parseNsLine: returns null for non-NS records', () => {
  assert.equal(parseNsLine('foo.com.\t3600\tin\ta\t192.0.2.1', 'com'), null);
  assert.equal(parseNsLine('foo.com.\t3600\tin\tds\t12345 8 2 abcd', 'com'), null);
  assert.equal(parseNsLine('com.\t3600\tin\tsoa\ta.gtld-servers.net. x.', 'com'), null);
});

test('parseNsLine: returns null for a line without tabs', () => {
  assert.equal(parseNsLine('justastringwithnotabs', 'com'), null);
});

test('delegations(): groups consecutive NS records per owner, sorts hosts, skips the apex and non-NS lines, yields in file order', async () => {
  const rows = await collect(delegations(delegationsZonePath, { zone: 'com' }));
  assert.deepEqual(rows, [
    { name: 'foo.com', ns: ['ns1.example.com', 'ns2.example.com'] },
    { name: 'zap.com', ns: ['ns1.other.com'] },
  ]);
});

test('delegations(): is zone-neutral (works for a non-com zone)', async () => {
  const rows = await collect(delegations(xyzZonePath, { zone: 'xyz' }));
  assert.deepEqual(rows, [{ name: 'foo.xyz', ns: ['ns1.example.net'] }]);
});

test('buildClassifier()/classifyNameservers(): classifies each operator kind', () => {
  const classifyHost = buildClassifier();

  const seller = classifyHost('ns1.afternic.com');
  assert.equal(seller.klass, 'seller');
  assert.equal(seller.provider, 'Afternic');

  const parking = classifyHost('ns1.bodis.com');
  assert.equal(parking.klass, 'parking');

  const registrar = classifyHost('pdns1.registrar-servers.com');
  assert.equal(registrar.klass, 'registrar');
  assert.equal(registrar.provider, 'Namecheap default');

  const hosting = classifyHost('anything.ns.cloudflare.com');
  assert.equal(hosting.klass, 'hosting');
  assert.equal(hosting.provider, 'Cloudflare');

  const other = classifyHost('ns1.totally-unknown-nameserver.invalid');
  assert.equal(other.klass, 'other');
  assert.equal(other.provider, null);

  const mixed = classifyNameservers(['ns1.afternic.com', 'anything.ns.cloudflare.com'], classifyHost);
  assert.equal(mixed.klass, 'seller');

  const empty = classifyNameservers([], classifyHost);
  assert.equal(empty.klass, 'none');
  assert.equal(empty.provider, null);
});

test('diffZoneDelegations(): produces the right counters and onRow rows, awaiting a promise-returning onRow', async () => {
  const rows = [];
  const counts = await diffZoneDelegations({
    prevPath: prevDiffZonePath,
    todayPath: todayDiffZonePath,
    zone: 'com',
    onRow: async (row) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      rows.push(row);
    },
  });

  assert.deepEqual(
    { added: counts.added, dropped: counts.dropped, changed: counts.changed, unchanged: counts.unchanged },
    { added: 1, dropped: 1, changed: 1, unchanged: 2 },
  );

  // Because onRow is awaited before the merge join advances, every row must
  // already be present by the time diffZoneDelegations() has resolved.
  assert.equal(rows.length, 3);

  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

  assert.equal(byName['b.com'].kind, 'changed');
  assert.equal(byName['b.com'].prev.klass, 'seller');
  assert.equal(byName['b.com'].today.klass, 'hosting');

  assert.equal(byName['c.com'].kind, 'dropped');
  assert.equal(byName['c.com'].prev.klass, 'hosting');
  assert.equal(byName['c.com'].today, null);

  assert.equal(byName['e.com'].kind, 'added');
  assert.equal(byName['e.com'].prev, null);
  assert.equal(byName['e.com'].today.klass, 'seller');
});

test('diffZoneDelegations(): throws when a snapshot is out of byte order', async () => {
  await assert.rejects(
    () => diffZoneDelegations({ prevPath: outOfOrderZonePath, todayPath: tinyValidZonePath, zone: 'com' }),
    /not in byte order/,
  );
});

test('writeZoneMovementTape()/readZoneMovementTape(): round-trips rows and honours a where filter', async () => {
  const outDir = path.join(TMP_DIR, 'tape-out');
  const meta = await writeZoneMovementTape({
    prevPath: prevDiffZonePath,
    todayPath: todayDiffZonePath,
    zone: 'com',
    day: '2026-09-05',
    prevDay: '2026-09-04',
    outDir,
  });

  assert.equal(meta.type, 'domainscout.zone-ns-movement/v1');
  assert.equal(meta.zone, 'com');
  assert.equal(meta.day, '2026-09-05');
  assert.equal(meta.prevDay, '2026-09-04');
  assert.deepEqual(
    { added: meta.counts.added, dropped: meta.counts.dropped, changed: meta.counts.changed, unchanged: meta.counts.unchanged },
    { added: 1, dropped: 1, changed: 1, unchanged: 2 },
  );
  assert.equal(meta.rows, 3);
  assert.equal(meta.transitions['seller>hosting'], 1);
  assert.deepEqual(meta.columns, TAPE_COLUMNS);

  const tapePath = path.join(outDir, 'movement-com-2026-09-05.tsv.gz');
  const metaPath = path.join(outDir, 'movement-com-2026-09-05.meta.json');
  assert.ok(fs.existsSync(tapePath));
  assert.ok(fs.existsSync(metaPath));

  const allRows = await collect(readZoneMovementTape(tapePath));
  assert.equal(allRows.length, 3);
  for (const row of allRows) {
    assert.ok(Array.isArray(row.prev_ns));
    assert.ok(Array.isArray(row.today_ns));
  }

  const changedOnly = await collect(readZoneMovementTape(tapePath, { where: (row) => row.kind === 'changed' }));
  assert.equal(changedOnly.length, 1);
  assert.equal(changedOnly[0].domain, 'b.com');
  assert.deepEqual(changedOnly[0].prev_ns, ['ns1.afternic.com']);
  assert.deepEqual(changedOnly[0].today_ns, ['somehost.ns.cloudflare.com']);
});
