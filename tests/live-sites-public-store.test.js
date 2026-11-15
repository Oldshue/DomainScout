'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { advanceDay, dbPath, openStore } = require('../server/live-sites-public-store');
const { createLiveSitesFeed, createPublicStoreReader } = require('../server/live-sites-feed');

function rec(day, domain, extra = {}) {
  return { domain, day, class: 'built', title: `${domain} Title`, description: `About ${domain}`, text: `body for ${domain}`,
    finalUrl: `https://${domain}/`, titleReal: true, spam: false, kit: null, observedAt: `${day}T09:00:00.000Z`, ...extra };
}
async function setup(t, day = '2026-11-15') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-public-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sites = path.join(root, day, 'sites');
  await fs.mkdir(sites, { recursive: true });
  return { root, day, sites };
}
async function append(file, rows) { await fs.appendFile(file, rows.map(row => `${JSON.stringify(row)}\n`).join('')); }

test('running partial observations and CT remain searchable; final observations take precedence', async t => {
  const { root, day, sites } = await setup(t);
  const partial = path.join(sites, 'observations.partial.jsonl');
  const ct = path.join(sites, 'ct-launches.jsonl');
  await append(partial, [rec(day, 'partial.example', { text: 'partial needle' }), rec(day, 'shared.example', { title: 'Partial identity' })]);
  await append(ct, [rec(day, 'ct.example', { text: 'ct needle' }), rec(day, 'shared.example', { title: 'CT identity' })]);
  await advanceDay({ universeDir: root, day });
  const reader = createPublicStoreReader({ universeDir: root }); t.after(() => reader.close());
  let repairs = 0;
  const feed = createLiveSitesFeed({ universeDir: root, publicStore: reader, projectionRepair: () => { repairs += 1; } });
  let body = await feed.query({ window: '7d', q: 'needle' });
  assert.deepEqual(body.items.map(row => row.domain).sort(), ['ct.example', 'partial.example']);
  body = await feed.query({ window: '7d' });
  assert.equal(body.items.find(row => row.domain === 'shared.example').title, 'Partial identity');
  await append(path.join(sites, 'observations.jsonl'), [rec(day, 'final.example'), rec(day, 'shared.example', { title: 'Final identity' })]);
  await advanceDay({ universeDir: root, day });
  body = await feed.query({ window: '7d' });
  assert.equal(body.items.some(row => row.domain === 'partial.example'), false);
  assert.equal(body.items.find(row => row.domain === 'shared.example').title, 'Final identity');
  assert.equal(repairs, 0, 'a current store does not schedule redundant maintenance');
});

test('a live journal builds a certified prefix, catches concurrent appends, and never duplicates rows', async t => {
  const { root, day, sites } = await setup(t);
  const ct = path.join(sites, 'ct-launches.jsonl');
  await append(ct, Array.from({ length: 5000 }, (_, i) => rec(day, `initial-${String(i).padStart(5, '0')}.example`)));
  const building = advanceDay({ universeDir: root, day });
  await new Promise(resolve => setTimeout(resolve, 5));
  await append(ct, Array.from({ length: 250 }, (_, i) => rec(day, `appended-${String(i).padStart(3, '0')}.example`)));
  await building; await advanceDay({ universeDir: root, day });
  const db = openStore(dbPath(root, day), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) FROM projection_rows').pluck().get(), 5250);
    assert.equal(db.prepare('SELECT count(*) FROM projection_rows GROUP BY domain HAVING count(*) > 1').all().length, 0);
    const source = db.prepare('SELECT offset,captured_size FROM projection_sources WHERE name=?').get('ct-launches.jsonl');
    assert.equal(source.offset, (await fs.stat(ct)).size);
  } finally { db.close(); }
});

test('an incomplete UTF-8/JSON tail waits for completion and same-inode replacement invalidates old rows', async t => {
  const { root, day, sites } = await setup(t);
  const ct = path.join(sites, 'ct-launches.jsonl'); await fs.writeFile(ct, '');
  const unicode = Buffer.from(`${JSON.stringify(rec(day, 'unicode.example', { text: 'café needle' }))}\n`);
  const split = unicode.indexOf(Buffer.from('é')) + 1;
  await fs.appendFile(ct, unicode.subarray(0, split)); await advanceDay({ universeDir: root, day });
  let db = openStore(dbPath(root, day), { readonly: true });
  assert.equal(db.prepare('SELECT count(*) FROM projection_rows').pluck().get(), 0); db.close();
  await fs.appendFile(ct, unicode.subarray(split)); await advanceDay({ universeDir: root, day });
  db = openStore(dbPath(root, day), { readonly: true });
  assert.equal(db.prepare('SELECT count(*) FROM projection_rows').pluck().get(), 1); db.close();
  const original = `${JSON.stringify(rec(day, 'same-old.example'))}\n`;
  const replacement = `${JSON.stringify(rec(day, 'same-new.example'))}\n`;
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement));
  await fs.writeFile(ct, original); const stamp = await fs.stat(ct); await advanceDay({ universeDir: root, day });
  await fs.writeFile(ct, replacement); await fs.utimes(ct, stamp.atime, stamp.mtime); await advanceDay({ universeDir: root, day });
  db = openStore(dbPath(root, day), { readonly: true });
  assert.deepEqual(db.prepare('SELECT domain FROM projection_rows').all().map(row => row.domain), ['same-new.example']); db.close();
});

test('one reusable bounded reader coalesces work and preserves search, exclude, facets and paging', async t => {
  const { root, day, sites } = await setup(t);
  await append(path.join(sites, 'observations.jsonl'), Array.from({ length: 120 }, (_, i) => rec(day, `site-${String(i).padStart(3, '0')}.${i % 2 ? 'com' : 'io'}`, { text: i % 3 ? 'ordinary body' : 'rare body needle' })));
  await advanceDay({ universeDir: root, day });
  const reader = createPublicStoreReader({ universeDir: root, maxQueue: 4 }); t.after(() => reader.close());
  const payload = { days: [day], q: 'needle', exclude: '', zone: '', cursor: null, limit: 10 };
  const requests = Array.from({ length: 20 }, () => reader.query(payload));
  assert.ok(reader.status().coalesced <= 1);
  const values = await Promise.all(requests);
  assert.ok(values.every(value => value.total === 40 && value.items.length === 10));
  const feed = createLiveSitesFeed({ universeDir: root, publicStore: reader, projectionRepair: () => {} });
  const first = await feed.query({ window: '7d', q: 'needle', exclude: 'site-000', zone: 'io', limit: '5' });
  assert.equal(first.items.length, 5); assert.ok(first.nextCursor); assert.ok(first.items.every(row => row.zone === 'io' && row.snippet.includes('needle')));
  const second = await feed.query({ window: '7d', q: 'needle', exclude: 'site-000', zone: 'io', limit: '5', cursor: first.nextCursor });
  assert.equal(new Set([...first.items, ...second.items].map(row => row.domain)).size, 10);
  assert.equal(reader.status().workerPid > 0, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reader.query({ ...payload, q: 'cancelled' }, controller.signal), error => error.name === 'AbortError');
});

test('newer nonmatching identity suppresses an older matching row across source days', async t => {
  const { root, day, sites } = await setup(t, '2026-11-15');
  await append(path.join(sites, 'observations.jsonl'), [rec(day, 'identity.example', { text: 'new wording' })]);
  const oldSites = path.join(root, '2026-11-14', 'sites'); await fs.mkdir(oldSites, { recursive: true });
  await append(path.join(oldSites, 'observations.jsonl'), [rec('2026-11-14', 'identity.example', { text: 'old hidden needle' })]);
  await advanceDay({ universeDir: root, day }); await advanceDay({ universeDir: root, day: '2026-11-14' });
  const reader = createPublicStoreReader({ universeDir: root }); t.after(() => reader.close());
  const value = await reader.query({ days: [day, '2026-11-14'], q: 'needle', exclude: '', zone: '', cursor: null, limit: 50 });
  assert.equal(value.total, 0); assert.deepEqual(value.items, []);
});
