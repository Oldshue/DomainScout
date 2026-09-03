'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const zlib = require('node:zlib');
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

test('exportDay streams sorted names with an optional zone filter', async t => {
  const lane = await fixture(t);
  const collect = async stream => {
    let text = '';
    for await (const chunk of stream) text += chunk;
    return text;
  };
  const all = await lane.exportDay({ day: DAY });
  assert.equal(all.day, DAY);
  assert.equal(all.zone, '');
  assert.equal(await collect(all), `${ROWS.map(([label, zone]) => `${label}.${zone}`).sort().join('\n')}\n`);
  const xyz = await lane.exportDay({ day: DAY, zone: '.xyz' });
  assert.equal(xyz.zone, 'xyz');
  assert.equal(await collect(xyz), 'alpha.xyz\nalphonse.xyz\nbetalpha.xyz\ngamma.xyz\nhub.xyz\n');
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
  registerUniverseRoutes({
    get(routePath, handler) { routes.set(routePath, handler); },
    post(routePath, handler) { routes.set(routePath, handler); },
  }, lane);

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


function importTape(prefix = 'imported') {
  return `${Array.from({ length: 1000 }, (_, index) => (
    `${prefix}${String(index).padStart(4, '0')}\tcom\t2026-09-02T00:00:00Z`
  )).join('\n')}\n`;
}

function routeApp() {
  const routes = new Map();
  return {
    routes,
    get(routePath, handler) { routes.set(routePath, handler); },
    post(routePath, handler) { routes.set(routePath, handler); },
  };
}

function responseStub() {
  return {
    statusCode: 200,
    body: null,
    set() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('importDay stores plain tape atomically and evicts the loaded day', async t => {
  const lane = await fixture(t);
  await lane.loadDay(DAY);
  const body = importTape();
  const result = await lane.importDay({ day: DAY, stream: Readable.from(body) });
  assert.deepEqual(result, { day: DAY, lines: 1000, bytes: Buffer.byteLength(body) });
  assert.deepEqual((await lane.search({ day: DAY, q: 'imported0007', mode: 'exact' })).items, [
    'imported0007.com',
  ]);
  await assert.rejects(fs.access(path.join(lane.directory, DAY, 'tape', 'adds.tsv.part')));
});

test('import route accepts gzip with either configured token source', async t => {
  const lane = await fixture(t);
  const app = routeApp();
  registerUniverseRoutes(app, lane);
  const previousImportToken = process.env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN;
  const previousAgentToken = process.env.DOMAINSCOUT_AGENT_TOKEN;
  process.env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN = 'import-token-test';
  delete process.env.DOMAINSCOUT_AGENT_TOKEN;
  t.after(() => {
    if (previousImportToken === undefined) delete process.env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN;
    else process.env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN = previousImportToken;
    if (previousAgentToken === undefined) delete process.env.DOMAINSCOUT_AGENT_TOKEN;
    else process.env.DOMAINSCOUT_AGENT_TOKEN = previousAgentToken;
  });

  const day = '2026-09-03';
  const body = importTape('gzip');
  const request = Readable.from(zlib.gzipSync(body));
  request.query = { day };
  request.headers = { 'content-encoding': 'gzip', 'x-domainscout-token': 'import-token-test' };
  request.get = name => request.headers[name.toLowerCase()];
  const response = responseStub();
  await app.routes.get('/api/universe/import')(request, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { day, lines: 1000, bytes: Buffer.byteLength(body) });
  assert.deepEqual((await lane.search({ day, q: 'gzip0001', mode: 'exact' })).items, ['gzip0001.com']);
});

test('import route rejects bad tokens and malformed days with JSON errors', async t => {
  const lane = await fixture(t);
  const app = routeApp();
  registerUniverseRoutes(app, lane);
  const previous = process.env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN;
  const previousAgent = process.env.DOMAINSCOUT_AGENT_TOKEN;
  process.env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN = 'import-token-test';
  delete process.env.DOMAINSCOUT_AGENT_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN;
    else process.env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN = previous;
    if (previousAgent === undefined) delete process.env.DOMAINSCOUT_AGENT_TOKEN;
    else process.env.DOMAINSCOUT_AGENT_TOKEN = previousAgent;
  });
  const invoke = async query => {
    const request = Readable.from(importTape());
    request.query = query;
    request.headers = {};
    request.get = () => undefined;
    const response = responseStub();
    await app.routes.get('/api/universe/import')(request, response);
    return response;
  };
  const unauthorized = await invoke({ day: DAY, token: 'wrong-token' });
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(unauthorized.body, { error: 'Unauthorized universe import' });
  const malformed = await invoke({ day: '2026-02-30', token: 'import-token-test' });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(malformed.body, { error: 'day must be a valid YYYY-MM-DD date' });
});
