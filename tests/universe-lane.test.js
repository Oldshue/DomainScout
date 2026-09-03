'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createUniverseLane, registerUniverseRoutes } = require('../server/universe-lane');

const DAY = '2026-09-02';
const ROWS = [
  ['alpha', 'com'],
  ['alphabet', 'com'],
  ['betalpha', 'com'],
  ['gamma', 'com'],
  ['hub', 'com'],
  ['myhub', 'com'],
  ['zeta', 'com'],
  ['alpha', 'xyz'],
  ['alphonse', 'xyz'],
  ['betalpha', 'xyz'],
  ['gamma', 'xyz'],
  ['hub', 'xyz'],
];

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-universe-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tape = path.join(directory, DAY, 'tape');
  await fs.mkdir(tape, { recursive: true });
  await fs.writeFile(path.join(tape, 'adds.tsv'), `${ROWS.map(([label, zone]) => `${label}\t${zone}\t2026-09-01T00:00:00Z`).join('\n')}\n`);
  await fs.writeFile(path.join(tape, 'zones.json'), JSON.stringify({ zones: ['com', 'xyz'] }));
  return createUniverseLane({ directory });
}

test('lists and loads registration-universe days', async t => {
  const lane = await fixture(t);
  assert.deepEqual(await lane.listDays(), [{ day: DAY, adds: 12, zones: 2 }]);
  const loaded = await lane.loadDay();
  assert.equal(loaded.day, DAY);
  assert.equal(loaded.names.length, 12);
  assert.deepEqual(loaded.zoneCounts, { com: 7, xyz: 5 });
});

test('search supports every mode and a zone filter', async t => {
  const lane = await fixture(t);
  assert.deepEqual((await lane.search({ q: 'alpha' })).items, [
    'alpha.com', 'alpha.xyz', 'alphabet.com', 'betalpha.com', 'betalpha.xyz',
  ]);
  assert.deepEqual((await lane.search({ q: 'alpha', mode: 'prefix' })).items, [
    'alpha.com', 'alpha.xyz', 'alphabet.com',
  ]);
  assert.deepEqual((await lane.search({ q: 'hub.com', mode: 'suffix' })).items, ['hub.com', 'myhub.com']);
  assert.deepEqual((await lane.search({ q: 'gamma.xyz', mode: 'exact' })).items, ['gamma.xyz']);
  assert.deepEqual((await lane.search({ q: 'alpha.com', mode: 'regex' })).items, ['alpha.com', 'betalpha.com']);
  assert.deepEqual((await lane.search({ q: 'alpha', zone: 'xyz' })).items, ['alpha.xyz', 'betalpha.xyz']);
});

test('search pages by scan cursor and sampling is deterministic', async t => {
  const lane = await fixture(t);
  const first = await lane.search({ q: '', limit: 3 });
  const second = await lane.search({ q: '', limit: 3, cursor: first.nextCursor });
  assert.equal(first.total, 12);
  assert.deepEqual(first.items, ['alpha.com', 'alpha.xyz', 'alphabet.com']);
  assert.equal(first.nextCursor, 3);
  assert.deepEqual(second.items, ['alphonse.xyz', 'betalpha.com', 'betalpha.xyz']);
  assert.equal(second.nextCursor, 6);
  assert.deepEqual(await lane.sample({ zone: 'com', n: 4 }), await lane.sample({ zone: 'com', n: 4 }));
});

test('routes return closed JSON errors for unknown days and bad regexes', async t => {
  const lane = await fixture(t);
  const routes = new Map();
  registerUniverseRoutes({ get(routePath, handler) { routes.set(routePath, handler); } }, lane);

  async function invoke(routePath, query) {
    const response = {
      statusCode: 200,
      body: null,
      set() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await routes.get(routePath)({ query }, response);
    return response;
  }

  const missing = await invoke('/api/universe/search', { day: '2026-09-01', q: 'alpha' });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.body, { error: 'Unknown universe day: 2026-09-01' });
  const badRegex = await invoke('/api/universe/search', { mode: 'regex', q: '[' });
  assert.equal(badRegex.statusCode, 400);
  assert.deepEqual(badRegex.body, { error: 'q may contain only a-z, 0-9, dot, and hyphen' });
});
