'use strict';

// My names authoritative-DNS stage (server/owner-names-dns.js). Injected
// resolver only; invented labels only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dns = require('../server/owner-names-dns');
const on = require('../server/owner-names');

const quiet = { log() {}, warn() {}, error() {} };
const at = day => () => Date.parse(`${day}T08:00:00Z`);

async function tmp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-owner-dns-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function resolver(registered, calls = []) {
  return async name => {
    calls.push(name);
    if (name.startsWith('flakylabel.')) return { status: 'unknown', reason: 'timeout' };
    return registered.has(name) ? { status: 'taken', nameservers: ['ns1.example.net'] } : { status: 'not_taken' };
  };
}

const WATCHED = () => new Map([['quillharbor', new Set(['com'])], ['flakylabel', new Set(['ai'])], ['dualowned', new Set(['com', 'io'])]]);
const TLDS = ['.com', '.ai', '.io', '.de', '.xyz', '.si'];

async function dayFile(root, day) {
  try { return await fs.readFile(path.join(root, 'owner-names', 'dns', day, 'adds.tsv'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

test('extension list: IANA root minus tape-covered zones, minus xyz', async t => {
  assert.deepEqual(dns.dnsExtensions({ allTlds: TLDS, covered: new Set(['com', 'si']) }), ['ai', 'de', 'io']);
  const universeDir = path.join(await tmp(t), 'universe');
  await fs.mkdir(path.join(universeDir, '2026-10-20', 'tape'), { recursive: true });
  await fs.writeFile(path.join(universeDir, '2026-10-20', 'tape', 'zones.json'), JSON.stringify({ zones: ['com', 'net'] }));
  await fs.mkdir(path.join(universeDir, '2026-10-19', 'ns-observed', 'si'), { recursive: true });
  assert.deepEqual([...await dns.tapeCoveredZones(universeDir)].sort(), ['com', 'net', 'si']);
});

test('first pass is baseline only; a later not-delegated -> delegated transition is a dated registration', async t => {
  const root = await tmp(t);
  const registered = new Set(['quillharbor.de']);
  const calls = [];
  const base = { dataDir: root, watched: WATCHED(), allTlds: TLDS, covered: new Set(['com']), probe: resolver(registered, calls), log: quiet };
  const first = await dns.runOwnerNamesDnsSweep({ ...base, now: at('2026-10-20') });
  assert.equal(first.complete, true);
  assert.equal(first.reported, 0, 'baseline never reports');
  assert.equal(await dayFile(root, '2026-10-20'), '', 'baseline day publishes an empty file');
  assert.ok(!calls.some(n => n.endsWith('.xyz')), '.xyz is never probed');
  assert.ok(!calls.some(n => n.endsWith('.com')), 'tape-covered zones are not probed');
  assert.ok(!calls.includes('dualowned.io') && !calls.includes('flakylabel.ai'), "owner's own extensions are not probed");
  registered.add('quillharbor.io');
  const second = await dns.runOwnerNamesDnsSweep({ ...base, now: at('2026-10-21') });
  assert.equal(second.reportedToday, 1);
  assert.equal(await dayFile(root, '2026-10-21'), 'quillharbor\tio\t2026-10-21\n');
  // Already delegated at baseline (quillharbor.de) is never reported.
  assert.ok(!(await dayFile(root, '2026-10-21')).includes('\tde\t'));
  // Same day again: complete, skipped.
  assert.deepEqual(await dns.runOwnerNamesDnsSweep({ ...base, now: at('2026-10-21') }), { skipped: 'complete', day: '2026-10-21' });
});

test('unknown answers are never a change, including unknown -> delegated', async t => {
  const root = await tmp(t);
  const watched = new Map([['quillharbor', new Set(['com'])]]);
  let mode = 'nx';
  const probe = async () => (mode === 'nx' ? { status: 'not_taken' } : mode === 'unknown' ? { status: 'unknown', reason: 'servfail' } : { status: 'taken', nameservers: ['ns1.example.net'] });
  const base = { dataDir: root, watched, allTlds: ['.io'], covered: new Set(), probe, log: quiet };
  await dns.runOwnerNamesDnsSweep({ ...base, now: at('2026-10-20') });
  mode = 'unknown';
  const u = await dns.runOwnerNamesDnsSweep({ ...base, now: at('2026-10-21') });
  assert.equal(u.reportedToday, 0);
  assert.equal(u.unknown, 1);
  mode = 'taken';
  const d = await dns.runOwnerNamesDnsSweep({ ...base, now: at('2026-10-22') });
  assert.equal(d.reportedToday, 1, 'an unknown day keeps the prior not-delegated state');
  // A pair first seen as unknown baselines on its first known answer.
  const root2 = await tmp(t);
  mode = 'unknown';
  await dns.runOwnerNamesDnsSweep({ ...base, dataDir: root2, now: at('2026-10-20') });
  mode = 'taken';
  const b = await dns.runOwnerNamesDnsSweep({ ...base, dataDir: root2, now: at('2026-10-21') });
  assert.equal(b.reportedToday, 0);
  assert.equal(b.baselined, 1);
});

test('an interrupted sweep resumes: pairs already checked today are not probed again', async t => {
  const root = await tmp(t);
  const statePath = dns.dnsPaths(root).state;
  const { db, q } = dns.openDnsState(statePath);
  q.put.run('quillharbor', 'io', 'not_delegated', '2026-10-19', '2026-10-20');
  q.put.run('quillharbor', 'de', 'not_delegated', '2026-10-19', '2026-10-20');
  q.metaSet.run('progress', JSON.stringify({ day: '2026-10-20', done: 2, delegated: 0, nxdomain: 2, unknown: 0, reported: 0, baselined: 0, reasons: {} }));
  db.close();
  const calls = [];
  const result = await dns.runOwnerNamesDnsSweep({
    dataDir: root, watched: new Map([['quillharbor', new Set(['com'])], ['inventedother', new Set(['com'])]]),
    allTlds: ['.io', '.de'], covered: new Set(), probe: resolver(new Set(), calls), log: quiet, now: at('2026-10-20'), chunkLabels: 1,
  });
  assert.deepEqual(calls.sort(), ['inventedother.de', 'inventedother.io']);
  assert.equal(result.done, 4, 'progress continues from the saved count');
});

test('the matching lane ingests DNS registrations as source authoritative-dns', async t => {
  const root = await tmp(t);
  const lane = on.createOwnerNamesLane({ dataDir: root, universeDir: path.join(root, 'universe'), zoneDbPath: null, now: at('2026-10-22'), log: quiet, enabled: true });
  t.after(() => lane.close());
  lane.replaceNames(['quillharbor.com']);
  const base = { dataDir: root, storePath: dns.dnsPaths(root).names, allTlds: ['.io', '.xyz'], covered: new Set(), log: quiet };
  await dns.runOwnerNamesDnsSweep({ ...base, probe: async () => ({ status: 'not_taken' }), now: at('2026-10-20') });
  await dns.runOwnerNamesDnsSweep({ ...base, probe: async () => ({ status: 'taken', nameservers: ['ns1.example.net'] }), now: at('2026-10-21') });
  await lane.run();
  const items = lane.matches({ days: 30 }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].domain, 'quillharbor.io');
  assert.deepEqual(items[0].sources, ['authoritative-dns']);
  assert.equal(items[0].firstSeen, '2026-10-21');
  assert.equal((await lane.health()).sources['authoritative-dns'].lastMatchedDay, '2026-10-21');
});

test('supervisor health: progress, unknown share alert, staleness, interrupted worker', async t => {
  const root = await tmp(t);
  const paths = dns.dnsPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  const write = h => fs.writeFile(paths.health, JSON.stringify(h));
  const sup = dns.createOwnerNamesDnsSupervisor({ dataDir: root, universeDir: root, enabled: true, now: at('2026-10-24'), leaseManager: { inspect: () => null }, log: quiet });
  await write({ status: 'ok', lastCompleteDay: '2026-10-24', labels: 3, done: 100, total: 100, unknown: 40 });
  let h = await sup.health();
  assert.equal(h.progressShare, 1);
  assert.equal(h.unknownShare, 0.4);
  assert.ok(h.alerts.some(a => /unknown share/.test(a)));
  await write({ status: 'ok', lastCompleteDay: '2026-10-21', labels: 3, done: 100, total: 100, unknown: 0 });
  h = await sup.health();
  assert.equal(h.behindDays, 3);
  assert.ok(h.alerts.some(a => /3 days behind/.test(a)));
  await write({ status: 'running', lastCompleteDay: '2026-10-24', labels: 3, done: 10, total: 100, unknown: 0 });
  h = await sup.health();
  assert.equal(h.status, 'failed');
  assert.ok(h.alerts.some(a => /interrupted/.test(a)));
  const off = dns.createOwnerNamesDnsSupervisor({ dataDir: root, enabled: false });
  assert.equal((await off.health()).status, 'disabled');
  assert.equal(dns.dnsEnabled({}), true);
  assert.equal(dns.dnsEnabled({ DOMAINSCOUT_OWNER_NAMES_DNS_ENABLED: '0' }), false);
});
