'use strict';

// My names: new extensions (server/owner-names.js). Invented labels only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openSqlite } = require('../server/ct-launches');
const on = require('../server/owner-names');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const D1 = '2026-10-18';
const D2 = '2026-10-19';
const quiet = { log() {}, warn() {}, error() {} };

function zoneDb() {
  const { db } = openSqlite(':memory:');
  db.exec(`CREATE TABLE zone_daily_new_names (tld TEXT NOT NULL, report_date TEXT NOT NULL, base_name TEXT NOT NULL, PRIMARY KEY (tld, report_date, base_name)) WITHOUT ROWID;
    CREATE TABLE nrd_import_receipts (report_date TEXT PRIMARY KEY, source TEXT NOT NULL, source_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, completed_at TEXT NOT NULL);`);
  return db;
}

function nrdDay(db, day, names, digest = 'd1') {
  const put = db.prepare('INSERT OR IGNORE INTO zone_daily_new_names VALUES (?, ?, ?)');
  for (const name of names) { const dot = name.indexOf('.'); put.run(name.slice(dot + 1), day, name.slice(0, dot)); }
  db.prepare('INSERT OR REPLACE INTO nrd_import_receipts VALUES (?, ?, ?, ?, ?)').run(day, 'whoisds-public-nrd', digest, '{}', `${day}T23:00:00Z`);
}

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

const tsv = rows => rows.map(([label, zone]) => `${label}\t${zone}\t2026-10-18`).join('\n') + '\n';

async function fixture(t, { now = NOW } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-owner-names-'));
  const universeDir = path.join(root, 'universe');
  const zdb = zoneDb();
  // CZDS tape, day 1.
  await write(path.join(universeDir, D1, 'tape', 'adds.tsv'), tsv([
    ['WorkPilot', 'io'], ['workpilots', 'io'], ['myworkpilot', 'net'], ['workpilot', 'xyz'],
    ['workpilot', 'com'], ['quillharbor', 'app'], ['unrelatedname', 'dev'],
  ]));
  // Observed zone fragment, day 2.
  const obs = path.join(universeDir, D2, 'ns-observed', 'si');
  await write(path.join(obs, 'movement.jsonl'), '');
  await write(path.join(obs, 'summary.json'), '{}');
  await write(path.join(obs, 'adds.tsv'), tsv([['workpilot', 'si'], ['other', 'si']]));
  // CT launch journal, day 2 (IDN, uppercase, and the same io domain as CZDS).
  await write(path.join(universeDir, D2, 'sites', 'ct-launches.jsonl'),
    [{ domain: 'CAFÉZEN.net' }, { domain: 'workpilot.io' }, { domain: 'workpilot.xyz' }].map(r => JSON.stringify(r)).join('\n') + '\n');
  // NRD rows, day 1 (dedupes with CZDS io; adds .co).
  nrdDay(zdb, D1, ['workpilot.io', 'workpilot.co', 'xn--cafzen-dva.io', 'quillharbor.xyz']);
  const clock = { now };
  const lane = on.createOwnerNamesLane({
    dataDir: root, universeDir, storePath: path.join(root, 'owner-names', 'owner-names.db'),
    openZoneDb: () => zdb, now: () => clock.now, log: quiet, enabled: true, nrdPageSize: 2,
  });
  t.after(async () => { lane.close(); zdb.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, universeDir, zdb, lane, clock };
}

test('normalization: case-insensitive, URL forms, IDN punycode, multi-label suffixes', () => {
  assert.deepEqual(on.normalizeDomain('https://www.WorkPilot.com/path'), { domain: 'workpilot.com', label: 'workpilot', tld: 'com' });
  assert.deepEqual(on.normalizeDomain('Cafézen.AI'), { domain: 'xn--cafzen-dva.ai', label: 'xn--cafzen-dva', tld: 'ai' });
  assert.equal(on.asciiLabel('CAFÉZEN'), 'xn--cafzen-dva');
  assert.equal(on.normalizeDomain('not a domain'), null);
  assert.deepEqual(on.parseNameInput('a.com\nb.ai, c.io'), ['a.com', 'b.ai', 'c.io']);
  assert.deepEqual(on.parseNameInput('["a.com","b.ai"]'), ['a.com', 'b.ai']);
  assert.deepEqual(on.parseNameInput({ domains: ['a.com'] }), ['a.com']);
});

test('isMatch: exact label only, .xyz always excluded, owned extensions excluded', () => {
  const watched = new Map([['workpilot', new Set(['com', 'io'])]]);
  assert.equal(on.isMatch(watched, 'workpilot', 'net'), true);
  assert.equal(on.isMatch(watched, 'workpilot', 'io'), false);
  assert.equal(on.isMatch(watched, 'workpilot', 'com'), false);
  assert.equal(on.isMatch(watched, 'workpilot', 'xyz'), false);
  assert.equal(on.isMatch(watched, 'workpilots', 'net'), false);
  assert.equal(on.isMatch(watched, 'myworkpilot', 'net'), false);
  assert.equal(on.isExcludedTld('xyz'), true);
});

test('lane matches every source, dedupes across sources, excludes .xyz and owned extensions', async t => {
  const { lane } = await fixture(t);
  const replaced = lane.replaceNames('workpilot.com\nworkpilot.si\ncafézen.ai\nquillharbor.org\nbad entry!');
  assert.equal(replaced.total, 4);
  assert.equal(replaced.watchedLabels, 2, 'only .com/.ai names are watch sources');
  assert.equal(replaced.rejectedCount, 2);
  await lane.run({ reason: 'test' });
  const result = lane.matches({ days: 30 });
  const byDomain = Object.fromEntries(result.items.map(i => [i.domain, i]));
  assert.deepEqual(Object.keys(byDomain).sort(), ['workpilot.co', 'workpilot.io', 'xn--cafzen-dva.io', 'xn--cafzen-dva.net']);
  assert.deepEqual(byDomain['workpilot.io'].sources, ['ct', 'czds', 'nrd'], 'one row, every source recorded');
  assert.equal(byDomain['workpilot.io'].firstSeen, D1, 'earliest sighting wins');
  assert.deepEqual(byDomain['workpilot.io'].ownerNames, ['workpilot.com']);
  assert.equal(byDomain['workpilot.io'].otherExtensionsInWindow, 1);
  assert.equal(byDomain['workpilot.io'].url, 'https://workpilot.io/');
  assert.equal(byDomain['xn--cafzen-dva.net'].sources.join(), 'ct');
  assert.ok(!byDomain['workpilot.si'], 'owner holds .si for this label');
  assert.ok(!result.items.some(i => i.extension === 'xyz'));
  assert.ok(!byDomain['quillharbor.app'], 'quillharbor is held only as .org, not a watch source');
  // Newest first.
  const days = result.items.map(i => i.firstSeen);
  assert.deepEqual(days, [...days].sort().reverse());
});

test('re-runs are idempotent and skip unchanged stages', async t => {
  const { lane } = await fixture(t);
  lane.replaceNames(['workpilot.com']);
  const first = await lane.run();
  assert.ok(first.scanned >= 4);
  const before = lane.matches({}).items;
  const second = await lane.run();
  assert.equal(second.scanned, 0);
  assert.equal(second.skipped, first.scanned);
  assert.deepEqual(lane.matches({}).items, before);
  // Replacing with the same list is a no-op.
  assert.equal(lane.replaceNames(['workpilot.com']).added, 0);
});

test('adding a name backfills every retained day; removing hides its matches', async t => {
  const { lane } = await fixture(t);
  lane.replaceNames(['workpilot.com']);
  await lane.run();
  assert.ok(!lane.matches({}).items.some(i => i.label === 'xn--cafzen-dva'));
  assert.equal(lane.addName('cafézen.ai').added, true);
  await lane.run();
  const idn = lane.matches({}).items.filter(i => i.label === 'xn--cafzen-dva').map(i => i.domain).sort();
  assert.deepEqual(idn, ['xn--cafzen-dva.io', 'xn--cafzen-dva.net']);
  assert.equal(lane.removeName('workpilot.com').removed, true);
  assert.ok(!lane.matches({}).items.some(i => i.label === 'workpilot'));
});

test('matches survive their source days aging out', async t => {
  const { lane, universeDir, zdb } = await fixture(t);
  lane.replaceNames(['workpilot.com']);
  await lane.run();
  const before = lane.matches({}).items.map(i => i.domain).sort();
  await fs.rm(path.join(universeDir, D1), { recursive: true, force: true });
  zdb.exec(`DELETE FROM zone_daily_new_names WHERE report_date = '${D1}'; DELETE FROM nrd_import_receipts WHERE report_date = '${D1}';`);
  await lane.run();
  assert.deepEqual(lane.matches({}).items.map(i => i.domain).sort(), before);
  assert.equal(lane.matches({}).items.find(i => i.domain === 'workpilot.io').firstSeen, D1);
});

test('filters, pagination and rollup ordering', async t => {
  const { lane } = await fixture(t);
  lane.replaceNames(['workpilot.com', 'cafézen.ai']);
  await lane.run();
  assert.equal(lane.matches({ ext: '.io' }).total, 2);
  assert.deepEqual(lane.matches({ owner: 'workpilot.com' }).items.map(i => i.domain).sort(), ['workpilot.co', 'workpilot.io', 'workpilot.si']);
  assert.deepEqual(lane.matches({ owner: 'Cafézen' }).items.map(i => i.domain).sort(), ['xn--cafzen-dva.io', 'xn--cafzen-dva.net']);
  assert.equal(lane.matches({ q: 'pilot.c' }).total, 1);
  assert.equal(lane.matches({ days: 2 }).total, 2, 'only day-2 first sightings inside a 2-day window');
  const page1 = lane.matches({ limit: 3 });
  assert.equal(page1.items.length, 3);
  assert.equal(page1.nextCursor, 3);
  const page2 = lane.matches({ limit: 3, cursor: page1.nextCursor });
  assert.equal(page2.items.length, 2);
  assert.equal(page2.nextCursor, null);
  assert.throws(() => lane.matches({ ext: 'bad ext' }), /ext is invalid/);
  const roll = lane.rollup({ days: 30 });
  assert.equal(roll.items.length, 2);
  assert.ok(roll.items[0].count >= roll.items[1].count);
  assert.ok(roll.items.every(g => g.extensions.every(e => e.url.startsWith('https://'))));
});

test('health: per-source days, totals, and an alert when more than one day behind', async t => {
  const { lane, universeDir } = await fixture(t);
  assert.equal((await lane.health()).status, 'idle');
  lane.replaceNames(['workpilot.com']);
  await lane.run();
  let h = await lane.health();
  assert.equal(h.status, 'ok');
  assert.equal(h.namesWatched, 1);
  assert.equal(h.matchesTotal, 3);
  assert.equal(h.sources.czds.lastScannedDay, D1);
  assert.equal(h.sources.czds.lastMatchedDay, D1);
  assert.deepEqual(h.alerts, []);
  // A newer CZDS day lands three days later and the lane has not caught up.
  await write(path.join(universeDir, '2026-10-21', 'tape', 'adds.tsv'), tsv([['workpilot', 'dev']]));
  h = await lane.health();
  assert.equal(h.status, 'behind');
  assert.equal(h.sources.czds.behindDays, 3);
  assert.ok(h.alerts.some(a => /3 days behind czds/.test(a)));
  await lane.run();
  h = await lane.health();
  assert.equal(h.status, 'ok');
  assert.equal(h.sources.czds.lastMatchedDay, '2026-10-21');
});

test('a failed stage records an error, does not stop other stages, and retries', async t => {
  const { lane, universeDir } = await fixture(t);
  const ctFile = path.join(universeDir, D2, 'sites', 'ct-launches.jsonl');
  const saved = await fs.readFile(ctFile, 'utf8');
  await fs.rm(ctFile);
  await fs.mkdir(ctFile); // directory where a file is expected: reading fails
  lane.replaceNames(['workpilot.com']);
  const result = await lane.run();
  assert.ok(result.failed >= 1);
  assert.ok(lane.matches({}).items.some(i => i.domain === 'workpilot.io'), 'other stages still matched');
  let h = await lane.health();
  assert.equal(h.status, 'failed');
  assert.ok(h.lastError && h.lastError.source === 'ct');
  await fs.rm(ctFile, { recursive: true });
  await fs.writeFile(ctFile, saved);
  await lane.run();
  h = await lane.health();
  assert.equal(h.status, 'ok');
  assert.deepEqual(lane.matches({}).items.find(i => i.domain === 'workpilot.io').sources, ['ct', 'czds', 'nrd']);
});

test('HTTP routes: bulk replace (text and JSON), add/remove, matches, rollup, health', async t => {
  const express = require('express');
  const { lane } = await fixture(t);
  const app = express();
  on.registerOwnerNameRoutes(app, lane);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, type) => {
    const res = await fetch(base + url, { method, body, headers: type ? { 'content-type': type } : {} });
    return { status: res.status, body: await res.json() };
  };
  let r = await call('PUT', '/api/owner-names', 'workpilot.com\ncafézen.ai\n', 'text/plain');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  r = await call('PUT', '/api/owner-names', JSON.stringify(['workpilot.com', 'cafézen.ai']), 'application/json');
  assert.equal(r.body.added, 0, 'idempotent bulk replace');
  const big = Array.from({ length: 20000 }, (_, i) => `inventedlabel${i}.com`).join('\n');
  r = await call('PUT', '/api/owner-names', `${big}\nworkpilot.com\ncafézen.ai`, 'text/plain');
  assert.equal(r.body.total, 20002, 'tens of thousands of names');
  r = await call('POST', '/api/owner-names', JSON.stringify({ domain: 'quillharbor.com' }), 'application/json');
  assert.equal(r.status, 201);
  r = await call('DELETE', '/api/owner-names/quillharbor.com');
  assert.equal(r.body.removed, true);
  r = await call('GET', '/api/owner-names?limit=2');
  assert.equal(r.body.items.length, 2);
  assert.equal(r.body.total, 20002);
  await lane.run();
  r = await call('GET', '/api/owner-names/matches?days=30&ext=io&limit=1');
  assert.equal(r.body.total, 2);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.nextCursor, 1);
  r = await call('GET', '/api/owner-names/rollup?days=30');
  assert.equal(r.body.items.length, 2);
  r = await call('GET', '/api/owner-names/health');
  assert.equal(r.body.status, 'ok');
  r = await call('GET', '/api/owner-names/matches?ext=bad%20ext');
  assert.equal(r.status, 400);
});

test('lane is on by default and off only with DOMAINSCOUT_OWNER_NAMES_ENABLED=0', () => {
  assert.equal(on.ownerNamesEnabled({}), true);
  assert.equal(on.ownerNamesEnabled({ DOMAINSCOUT_OWNER_NAMES_ENABLED: '0' }), false);
});
