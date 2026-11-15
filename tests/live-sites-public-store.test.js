'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { advanceDay, advanceSource, dbPath, openStore } = require('../server/live-sites-public-store');
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
  let repairs = 0, repairPromise = null;
  const feed = createLiveSitesFeed({ universeDir: root, publicStore: reader, projectionRepair: () => {
    if (!repairPromise) { repairs += 1; repairPromise = new Promise(() => {}); }
    return repairPromise;
  } });
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
  assert.equal(body.projection.status, 'verified');
  assert.ok(body.projection.verifiedAt);
  assert.equal(JSON.stringify(body).includes('captured_size'), false, 'public responses do not expose projection internals');
  assert.equal(JSON.stringify(body).includes('observations.jsonl'), false, 'public responses do not expose source filenames');
  await append(ct, [rec(day, 'later.example')]);
  const stale = await Promise.all([feed.query({ window: '7d' }), feed.query({ window: '7d' })]);
  assert.ok(stale.every(result => result.projection.status === 'refreshing'));
  assert.equal(repairs, 1, 'concurrent readers coalesce one repair job after a real append');
});

test('a live journal builds a certified prefix, catches concurrent appends, and never duplicates rows', async t => {
  const { root, day, sites } = await setup(t);
  const ct = path.join(sites, 'ct-launches.jsonl');
  await append(ct, Array.from({ length: 5000 }, (_, i) => rec(day, `initial-${String(i).padStart(5, '0')}.example`)));
  const writable = openStore(dbPath(root, day));
  const first = await advanceSource(writable, ct, day, { onCaptured: () => append(ct,
    Array.from({ length: 250 }, (_, i) => rec(day, `appended-${String(i).padStart(3, '0')}.example`))) });
  writable.close();
  const second = await advanceDay({ universeDir: root, day });
  assert.equal(first.caughtUp, false, 'the first pass certifies its captured prefix while writes continue');
  assert.equal(second.results[0].incremental, true, 'the catch-up reads only the appended delta');
  const db = openStore(dbPath(root, day), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) FROM projection_rows').pluck().get(), 5250);
    assert.equal(db.prepare('SELECT count(*) FROM projection_search').pluck().get(), 5250, 'persistent substring index follows every accepted row');
    assert.equal(db.prepare('SELECT count(*) FROM projection_rows GROUP BY domain HAVING count(*) > 1').all().length, 0);
    const source = db.prepare('SELECT offset,captured_size FROM projection_sources WHERE name=?').get('ct-launches.jsonl');
    assert.equal(source.offset, (await fs.stat(ct)).size);
  } finally { db.close(); }
});

test('overlapping repair owners converge on one certified generation without losing appended rows', async t => {
  const { root, day, sites } = await setup(t);
  const ct = path.join(sites, 'ct-launches.jsonl');
  await append(ct, Array.from({ length: 2000 }, (_, i) => rec(day, `overlap-${String(i).padStart(4, '0')}.example`)));
  await Promise.all([advanceDay({ universeDir: root, day }), advanceDay({ universeDir: root, day })]);
  await append(ct, [rec(day, 'after-overlap.example')]);
  await Promise.all([advanceDay({ universeDir: root, day }), advanceDay({ universeDir: root, day })]);
  const db = openStore(dbPath(root, day), { readonly: true });
  try {
    assert.equal(db.prepare(`SELECT count(*) FROM projection_rows r JOIN projection_sources s
      ON s.name=r.source AND s.generation=r.generation AND r.end_offset<=s.offset`).pluck().get(), 2001);
    assert.equal(db.prepare('SELECT count(DISTINCT generation) FROM projection_rows').pluck().get(), 1);
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
  await fs.appendFile(ct, unicode.subarray(split)); const completed = await advanceDay({ universeDir: root, day });
  assert.equal(completed.results[0].offset, unicode.length, JSON.stringify(completed));
  assert.equal(completed.results[0].incremental, true, 'a sub-64KB append is not mistaken for replacement');
  db = openStore(dbPath(root, day), { readonly: true });
  assert.equal(db.prepare('SELECT count(*) FROM projection_rows').pluck().get(), 1); db.close();
  const original = `${JSON.stringify(rec(day, 'same-old.example'))}\n`;
  const replacement = `${JSON.stringify(rec(day, 'same-new.example'))}\n`;
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement));
  await fs.writeFile(ct, original); const stamp = await fs.stat(ct); await advanceDay({ universeDir: root, day });
  await fs.writeFile(ct, replacement); await fs.utimes(ct, stamp.atime, stamp.mtime); await advanceDay({ universeDir: root, day });
  db = openStore(dbPath(root, day), { readonly: true });
  assert.deepEqual(db.prepare('SELECT domain FROM projection_rows').all().map(row => row.domain), ['same-new.example']);
  assert.equal(db.prepare('SELECT count(*) FROM projection_search WHERE projection_search MATCH ?').pluck().get('"same-old"'), 0);
  assert.equal(db.prepare('SELECT count(*) FROM projection_search WHERE projection_search MATCH ?').pluck().get('"same-new"'), 1);
  db.close();
});

test('readers see only the old certified prefix while a large append is staged, then the atomic checkpoint publishes it', async t => {
  const { root, day, sites } = await setup(t);
  const ct = path.join(sites, 'ct-launches.jsonl');
  await append(ct, Array.from({ length: 10 }, (_, i) => rec(day, `old-${i}.example`)));
  await advanceDay({ universeDir: root, day });
  await append(ct, Array.from({ length: 20000 }, (_, i) => rec(day, `new-${String(i).padStart(5, '0')}.example`)));
  const building = advanceDay({ universeDir: root, day });
  await new Promise(resolve => setTimeout(resolve, 5));
  const db = openStore(dbPath(root, day), { readonly: true });
  try {
    const visible = db.prepare(`SELECT count(*) FROM projection_rows r JOIN projection_sources s
      ON s.name=r.source AND s.generation=r.generation AND r.end_offset<=s.offset`).pluck().get();
    assert.equal(visible, 10, 'uncheckpointed batches are invisible');
  } finally { db.close(); }
  await building;
  const ready = openStore(dbPath(root, day), { readonly: true });
  try {
    const visible = ready.prepare(`SELECT count(*) FROM projection_rows r JOIN projection_sources s
      ON s.name=r.source AND s.generation=r.generation AND r.end_offset<=s.offset`).pluck().get();
    assert.equal(visible, 20010);
  } finally { ready.close(); }
});

test('kit title normalization matches JavaScript Unicode trim and lowercase semantics', async t => {
  const { root, day, sites } = await setup(t);
  const rows = Array.from({ length: 8 }, (_, i) => rec(day, `kit-${i}.example`, { title: i % 2 ? '  CAFÉ  ' : 'Café' }));
  rows.push(rec(day, 'independent.example', { title: 'Independent' }));
  await append(path.join(sites, 'observations.jsonl'), rows); await advanceDay({ universeDir: root, day });
  const reader = createPublicStoreReader({ universeDir: root }); t.after(() => reader.close());
  const value = await reader.query({ days: [day], q: '', exclude: '', zone: '', cursor: null, limit: 50 });
  assert.deepEqual(value.items.map(row => row.domain), ['independent.example']);
});

test('v4 stores upgrade in place to a narrow read index without rebuilding source rows', async t => {
  const { root, day, sites } = await setup(t);
  await append(path.join(sites, 'observations.jsonl'), [
    rec(day, 'upgrade-one.example', { text: 'large private body '.repeat(1000) }),
    rec(day, 'upgrade-two.example', { text: 'searchable needle' }),
  ]);
  await advanceDay({ universeDir: root, day });
  const file = dbPath(root, day), before = openStore(file);
  const generations = before.prepare('SELECT count(*) FROM projection_sources').pluck().get();
  const rows = before.prepare('SELECT count(*) FROM projection_rows').pluck().get();
  before.exec('DROP TRIGGER projection_rows_index_ai; DROP TRIGGER projection_rows_index_ad; DROP TABLE projection_index');
  before.prepare('UPDATE projection_meta SET value=? WHERE key=?').run('domainscout.live-sites-public-store/v4', 'schema');
  before.close();

  const upgraded = openStore(file);
  try {
    assert.equal(upgraded.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('schema'), 'domainscout.live-sites-public-store/v5');
    assert.equal(upgraded.prepare('SELECT count(*) FROM projection_sources').pluck().get(), generations);
    assert.equal(upgraded.prepare('SELECT count(*) FROM projection_rows').pluck().get(), rows);
    assert.equal(upgraded.prepare('SELECT count(*) FROM projection_index').pluck().get(), rows);
    assert.deepEqual(upgraded.prepare('PRAGMA table_info(projection_index)').all().map(row => row.name).includes('body'), false);
  } finally { upgraded.close(); }
  const reader = createPublicStoreReader({ universeDir: root }); t.after(() => reader.close());
  const value = await reader.query({ days: [day], q: 'needle', exclude: '', zone: '', cursor: null, limit: 50 });
  assert.equal(value.total, 1); assert.equal(value.items[0].domain, 'upgrade-two.example');
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
  const short = await feed.query({ window: '7d', q: 'ra', limit: '50' });
  assert.equal(short.total, 40); assert.ok(short.items.every(row => row.snippet.includes('rare')));
  const shortExclude = await feed.query({ window: '7d', exclude: 'ra', limit: '50' });
  assert.equal(shortExclude.total, 80);
  assert.equal(reader.status().workerPid > 0, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reader.query({ ...payload, q: 'cancelled' }, controller.signal), error => error.name === 'AbortError');
});

test('two-character literals reuse the trigram index and remain exact without rescanning every body', async t => {
  const { root, day, sites } = await setup(t);
  await append(path.join(sites, 'observations.jsonl'), [
    rec(day, 'short-one.ai', { text: 'built with ai tools' }),
    rec(day, 'robot.dev', { text: 'other wording' }),
    rec(day, 'short-three.com', { text: 'contains ailing and zed but no other requested pair' }),
    rec(day, 'unicode.dev', { text: 'Éx' }),
  ]);
  await advanceDay({ universeDir: root, day });
  const file = dbPath(root, day), db = openStore(file, { readonly: true });
  try {
    assert.equal(db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('short_terms_ready'), require('../server/live-sites-public-store').SCHEMA);
    assert.ok(db.prepare('SELECT count(*) FROM projection_terms WHERE instr(term,?)>0').pluck().get('ai') > 0);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT term FROM projection_terms WHERE term>=? AND term<?
      UNION SELECT term FROM projection_terms WHERE substr(term,-2)=?`).all('ai', `ai\u{10ffff}`, 'ai').map(row => row.detail).join('\n');
    assert.match(plan, /PRIMARY KEY/); assert.match(plan, /projection_terms_suffix/);
  } finally { db.close(); }
  const reader = createPublicStoreReader({ universeDir: root }); t.after(() => reader.close());
  const value = await reader.query({ days: [day], q: 'ai', exclude: '', zone: 'ai', cursor: null, limit: 50 });
  assert.equal(value.total, 1); assert.equal(value.items[0].domain, 'short-one.ai');
  const oneCharacter = await reader.query({ days: [day], q: 'z', exclude: '', zone: '', cursor: null, limit: 50 });
  assert.deepEqual(oneCharacter.items.map(item => item.domain), ['short-three.com']);
  const excluded = await reader.query({ days: [day], q: '', exclude: 'ai', zone: '', cursor: null, limit: 50 });
  assert.deepEqual(excluded.items.map(item => item.domain).sort(), ['robot.dev', 'unicode.dev']);
  const unicode = await reader.query({ days: [day], q: 'ÉX'.toLowerCase(), exclude: '', zone: '', cursor: null, limit: 50 });
  assert.deepEqual(unicode.items.map(item => item.domain), ['unicode.dev']);

  await append(path.join(sites, 'observations.jsonl'), [rec(day, 'fresh.dev', { text: 'xy at a boundary' })]);
  await advanceDay({ universeDir: root, day });
  const appended = await reader.query({ days: [day], q: 'xy', exclude: '', zone: '', cursor: null, limit: 50 });
  assert.deepEqual(appended.items.map(item => item.domain), ['fresh.dev']);
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
