'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const feedModule = require('../server/live-sites-feed');

const { createLiveSitesFeed, registerLiveSitesFeedRoutes, createRateLimiter, PATH } = feedModule;

const FIELDS = ['day', 'description', 'domain', 'observedAt', 'title', 'url', 'zone'];

function rec(day, domain, extra = {}) {
  return {
    domain, zone: domain.slice(domain.lastIndexOf('.') + 1), day, class: 'built', reason: 'operating_site', status: 200,
    url: `https://${domain}/`, finalUrl: `https://${domain}/`, scheme: 'https', title: `${domain} Title`, description: `About ${domain}`,
    titleReal: true, spam: false, kit: null, fingerprint: { title: 'x', skeleton: 'y' }, provider: 'Cloudflare',
    nameservers: ['ns1.secret-host.com'], observedAt: `${day}T09:00:00.000Z`, version: 'live-sites-classifier-v1', ...extra,
  };
}

async function writeDay(directory, day, records, status = 'complete') {
  const dir = path.join(directory, day, 'sites');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'observations.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ day, status }));
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeDay(directory, '2026-10-18', [rec('2026-10-18', 'oldsite.com'), rec('2026-10-18', 'oldshop.io')]);
  await writeDay(directory, '2026-10-20', [
    rec('2026-10-20', 'zebra-cafe.com', { title: 'Zebra Cafe Brunch', description: null }),
    rec('2026-10-20', 'alpha.io'),
    rec('2026-10-20', 'beta.com', { title: 'The Coffee Lab' }),
    rec('2026-10-20', 'parked.com', { class: 'parked' }),
    rec('2026-10-20', 'forsale.com', { class: 'for_sale' }),
    rec('2026-10-20', 'kitone.com', { kit: { id: 'kit-1', size: 6, basis: 'template' } }),
    rec('2026-10-20', 'spammy.com', { spam: true }),
    rec('2026-10-20', 'notitle.com', { titleReal: false, title: 'notitle.com' }),
    rec('2026-10-20', 'emptytitle.com', { title: null }),
  ]);
  // An unfinished day is never published.
  await writeDay(directory, '2026-10-21', [rec('2026-10-21', 'running.com')], 'running');
  return createLiveSitesFeed({ universeDir: directory });
}

function fakeApp() {
  const routes = {};
  return { routes, get(p, h) { routes[`GET ${p}`] = h; }, options(p, h) { routes[`OPTIONS ${p}`] = h; } };
}

async function call(app, query = {}, { method = 'GET', ip = '203.0.113.5', headers = {} } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: undefined,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  await app.routes[`${method} ${PATH}`]({ query, headers, socket: { remoteAddress: ip } }, res);
  return res;
}

test('feed serves only built, non-kit, non-spam titled sites, newest day first (running days included), with exactly the public fields', async t => {
  const feed = await fixture(t);
  const body = await feed.query({ window: '7d' });
  assert.deepEqual(body.days, ['2026-10-21', '2026-10-20', '2026-10-18']);
  assert.deepEqual(body.items.map(i => i.domain), ['running.com', 'alpha.io', 'beta.com', 'zebra-cafe.com', 'oldshop.io', 'oldsite.com']);
  assert.equal(body.nextCursor, null);
  for (const item of body.items) assert.deepEqual(Object.keys(item).sort(), FIELDS);
  const zebra = body.items.find(i => i.domain === 'zebra-cafe.com');
  assert.deepEqual(zebra, { domain: 'zebra-cafe.com', zone: 'com', day: '2026-10-20', title: 'Zebra Cafe Brunch', description: null, url: 'https://zebra-cafe.com/', observedAt: '2026-10-20T09:00:00.000Z' });
  const serialized = JSON.stringify(body);
  for (const secret of ['secret-host', 'Cloudflare', 'operating_site', 'skeleton', 'built', 'kit']) assert.ok(!serialized.includes(secret), secret);
});

test('feed pages with an opaque cursor without gaps or duplicates across days', async t => {
  const feed = await fixture(t);
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const body = await feed.query({ window: '7d', limit: '2', ...(cursor ? { cursor } : {}) });
    assert.ok(body.items.length <= 2);
    seen.push(...body.items.map(i => i.domain));
    cursor = body.nextCursor;
    if (cursor) assert.equal(typeof cursor, 'string');
    pages += 1;
  } while (cursor && pages < 10);
  assert.deepEqual(seen, ['running.com', 'alpha.io', 'beta.com', 'zebra-cafe.com', 'oldshop.io', 'oldsite.com']);
  assert.equal(pages, 3);
});

test('q matches domain or title case-insensitively; zone filters by extension', async t => {
  const feed = await fixture(t);
  assert.deepEqual((await feed.query({ window: '7d', q: 'COFFEE' })).items.map(i => i.domain), ['beta.com']);
  assert.deepEqual((await feed.query({ window: '7d', q: 'Zebra' })).items.map(i => i.domain), ['zebra-cafe.com']);
  assert.deepEqual((await feed.query({ window: '7d', q: 'old' })).items.map(i => i.domain), ['oldshop.io', 'oldsite.com']);
  assert.deepEqual((await feed.query({ window: '7d', zone: 'io' })).items.map(i => i.domain), ['alpha.io', 'oldshop.io']);
  assert.deepEqual((await feed.query({ window: '7d', zone: 'io', q: 'alpha' })).items.map(i => i.domain), ['alpha.io']);
});

test('empty universe directory returns an empty feed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-empty-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await createLiveSitesFeed({ universeDir: directory }).query({}), { items: [], nextCursor: null, total: 0, zones: [], days: [], progress: [] });
  assert.deepEqual(await createLiveSitesFeed({ universeDir: path.join(directory, 'missing') }).query({}), { items: [], nextCursor: null, total: 0, zones: [], days: [], progress: [] });
});

test('route: 200 with CORS and short public cache; invalid input is a non-200 {error}', async t => {
  const feed = await fixture(t);
  const app = fakeApp();
  registerLiveSitesFeedRoutes(app, feed, { env: {} });
  const ok = await call(app, { limit: '1' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['access-control-allow-origin'], '*');
  assert.match(ok.headers['cache-control'], /^public, max-age=\d+$/);
  assert.ok(Number(ok.headers['cache-control'].split('=')[1]) <= 300);
  assert.equal(ok.body.items.length, 1);
  assert.equal(typeof ok.body.nextCursor, 'string');
  for (const query of [{ limit: '0' }, { limit: '1001' }, { limit: 'abc' }, { zone: '.com' }, { cursor: 'garbage' }, { q: 'x'.repeat(101) }]) {
    const bad = await call(app, query);
    assert.equal(bad.statusCode, 400, JSON.stringify(query));
    assert.equal(typeof bad.body.error, 'string');
    assert.deepEqual(Object.keys(bad.body), ['error']);
    assert.equal(bad.headers['access-control-allow-origin'], '*');
  }
  const foreignCursor = await call(app, { cursor: ok.body.nextCursor, q: 'other' });
  assert.equal(foreignCursor.statusCode, 400);
  const preflight = await call(app, {}, { method: 'OPTIONS' });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
});

test('route: storage failure answers 503 {error} without leaking internals', async () => {
  const app = fakeApp();
  registerLiveSitesFeedRoutes(app, { query: async () => { throw new Error('EIO /data/universe secret path'); } }, { env: {} });
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await call(app, {});
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'live sites feed unavailable' });
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally { console.error = originalError; }
});

test('route: rate limit is per client and answers 429 {error} with Retry-After', async t => {
  const feed = await fixture(t);
  const app = fakeApp();
  let clock = 1000;
  registerLiveSitesFeedRoutes(app, feed, { env: {}, limiter: createRateLimiter({ windowMs: 60000, max: 3, now: () => clock }) });
  for (let i = 0; i < 3; i += 1) assert.equal((await call(app, {}, { ip: '198.51.100.1' })).statusCode, 200);
  const limited = await call(app, {}, { ip: '198.51.100.1' });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.body, { error: 'rate limit exceeded' });
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal(limited.headers['access-control-allow-origin'], '*');
  assert.equal((await call(app, {}, { ip: '198.51.100.2' })).statusCode, 200, 'other clients are unaffected');
  clock += 60001;
  assert.equal((await call(app, {}, { ip: '198.51.100.1' })).statusCode, 200, 'window resets');
});

test('route: a spoofed X-Forwarded-For cannot dodge the rate limit', async t => {
  const feed = await fixture(t);
  const app = fakeApp();
  registerLiveSitesFeedRoutes(app, feed, { env: {}, limiter: createRateLimiter({ windowMs: 60000, max: 2, now: () => 1000 }) });
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await call(app, {}, { ip: '198.51.100.1', headers: { 'x-forwarded-for': `192.0.2.${i + 1}` } })).statusCode, 200);
  }
  const limited = await call(app, {}, { ip: '198.51.100.1', headers: { 'x-forwarded-for': '192.0.2.99, 10.0.0.1' } });
  assert.equal(limited.statusCode, 429, 'rotating X-Forwarded-For must not yield a fresh bucket');
  const app2 = fakeApp();
  registerLiveSitesFeedRoutes(app2, feed, { env: {}, limiter: createRateLimiter({ windowMs: 60000, max: 1, now: () => 1000 }) });
  const codes = [];
  codes.push((await call(app2, {}, { ip: '198.51.100.1', headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '192.0.2.1' } })).statusCode);
  codes.push((await call(app2, {}, { ip: '198.51.100.1', headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '192.0.2.2' } })).statusCode);
  assert.deepEqual(codes, [200, 429]);
});

test('route: X-Real-IP is the per-client key, with socket address as fallback', async t => {
  const feed = await fixture(t);
  const app = fakeApp();
  registerLiveSitesFeedRoutes(app, feed, { env: {}, limiter: createRateLimiter({ windowMs: 60000, max: 1, now: () => 1000 }) });
  assert.equal((await call(app, {}, { ip: '198.51.100.1', headers: { 'x-real-ip': '203.0.113.10' } })).statusCode, 200);
  assert.equal((await call(app, {}, { ip: '198.51.100.1', headers: { 'x-real-ip': '203.0.113.11' } })).statusCode, 200, 'different X-Real-IP is a different client even on one socket');
  assert.equal((await call(app, {}, { ip: '198.51.100.2', headers: { 'x-real-ip': '203.0.113.10' } })).statusCode, 429, 'same X-Real-IP is the same client across sockets');
  assert.equal((await call(app, {}, { ip: '198.51.100.3' })).statusCode, 200);
  assert.equal((await call(app, {}, { ip: '198.51.100.3' })).statusCode, 429, 'socket address is used when X-Real-IP is absent');
});

test('route: limit accepts up to 1000 and rejects 1001; default stays 50', async t => {
  const feed = await fixture(t);
  const app = fakeApp();
  registerLiveSitesFeedRoutes(app, feed, { env: {} });
  assert.equal((await call(app, { limit: '1000' })).statusCode, 200);
  assert.equal((await call(app, { limit: '1' })).statusCode, 200);
  const bad = await call(app, { limit: '1001' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /1 to 1000/);
  assert.equal((await call(app, {})).statusCode, 200);
});

async function progressFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const put = async (day, summary, tape = true) => {
    if (tape) { await fs.mkdir(path.join(directory, day, 'ns'), { recursive: true }); await fs.writeFile(path.join(directory, day, 'ns', 'movement.jsonl'), '{}\n'); }
    if (summary) { await fs.mkdir(path.join(directory, day, 'sites'), { recursive: true }); await fs.writeFile(path.join(directory, day, 'sites', 'summary.json'), JSON.stringify(summary)); }
  };
  const healthPath = path.join(directory, 'health.json');
  return { directory, healthPath, put };
}

test('progress: running day with partial counts, complete day, failed day, queued day; counts only', async t => {
  const { directory, healthPath, put } = await progressFixture(t);
  await put('2026-10-20', { status: 'complete', total: 100, observed: 100, counts: { built: 9, error: 12 }, errorsObserved: 3, built: { publishable: 7 }, finishedAt: '2026-10-20T12:00:00.000Z', nameservers: ['ns1.secret.com'] });
  await put('2026-10-21', { status: 'running', total: 1000, observed: 250, errorsObserved: 140, updatedAt: '2026-10-21T10:00:00.000Z', error: 'boom secret' });
  await put('2026-10-22', null);
  await put('2026-10-19', null);
  await fs.writeFile(healthPath, JSON.stringify({ failures: { '2026-10-19': { error: 'secret failure text', at: '2026-10-19T08:00:00.000Z' } } }));
  const feed = createLiveSitesFeed({ universeDir: directory, healthPath });
  const body = await feed.query({});
  assert.deepEqual(body.days, ['2026-10-20']);
  assert.deepEqual(body.progress, [
    { day: '2026-10-22', status: 'queued', checked: 0, total: 0, kept: 0, errors: 0, updatedAt: null },
    { day: '2026-10-21', status: 'running', checked: 250, total: 1000, kept: 0, errors: 140, updatedAt: '2026-10-21T10:00:00.000Z' },
    { day: '2026-10-20', status: 'complete', checked: 100, total: 100, kept: 7, errors: 12, updatedAt: '2026-10-20T12:00:00.000Z' },
    { day: '2026-10-19', status: 'failed', checked: 0, total: 0, kept: 0, errors: 0, updatedAt: '2026-10-19T08:00:00.000Z' },
  ]);
  const text = JSON.stringify(body.progress);
  for (const secret of ['secret', 'boom', 'ns1']) assert.ok(!text.includes(secret), secret);
});

test('progress: failed day keeps partial counts; no state yields an empty array', async t => {
  const { directory, healthPath, put } = await progressFixture(t);
  await put('2026-10-21', { status: 'running', total: 50, observed: 20, updatedAt: '2026-10-21T10:00:00.000Z' });
  await fs.writeFile(healthPath, JSON.stringify({ failures: { '2026-10-21': { error: 'x', at: '2026-10-21T11:00:00.000Z' } } }));
  const body = await createLiveSitesFeed({ universeDir: directory, healthPath }).query({});
  assert.deepEqual(body.progress, [{ day: '2026-10-21', status: 'failed', checked: 20, total: 50, kept: 0, errors: 0, updatedAt: '2026-10-21T11:00:00.000Z' }]);
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-progress-empty-'));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  assert.deepEqual((await createLiveSitesFeed({ universeDir: empty, healthPath: path.join(empty, 'none.json') }).query({})).progress, []);
});

test('a running day drops titles repeated 8+ times among its rows so far (kit) and serves the rest', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-running-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const day = '2026-10-26';
  await fs.mkdir(path.join(directory, day, 'sites'), { recursive: true });
  const rows = [];
  for (let i = 0; i < 8; i += 1) rows.push({ domain: `kit${i}.com`, class: 'built', titleReal: true, title: 'Same Template Store' });
  rows.push({ domain: 'realshop.com', class: 'built', titleReal: true, title: 'Real Shop' });
  await fs.writeFile(path.join(directory, day, 'sites', 'observations.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const body = await createLiveSitesFeed({ universeDir: directory }).query({});
  assert.deepEqual(body.days, [day]);
  assert.deepEqual(body.items.map(i => i.domain), ['realshop.com']);
});

test('window picks the N newest days with observations (default 2d) and total counts the same filtered rows', async t => {
  const feed = await fixture(t);
  const d2 = await feed.query({});
  assert.deepEqual(d2.items.map(i => i.day), ['2026-10-21', '2026-10-20', '2026-10-20', '2026-10-20']);
  assert.equal(d2.total, 4);
  const d1 = await feed.query({ window: '1d' });
  assert.deepEqual(d1.items.map(i => i.domain), ['running.com']);
  assert.equal(d1.total, 1);
  const d7 = await feed.query({ window: '7d' });
  assert.equal(d7.total, 6);
  assert.equal(d7.items.length, 6);
  assert.equal((await feed.query({ window: '7d', q: 'old' })).total, 2);
  assert.equal((await feed.query({ window: '2d', q: 'old' })).total, 0);
  assert.equal((await feed.query({ window: '7d', zone: 'io' })).total, 2);
  const paged = await feed.query({ window: '7d', limit: '2' });
  assert.equal(paged.items.length, 2);
  assert.equal(paged.total, 6);
  const next = await feed.query({ window: '7d', limit: '2', cursor: paged.nextCursor });
  assert.equal(next.total, 6);
  await assert.rejects(() => feed.query({ window: '7d', limit: '2', cursor: paged.nextCursor, q: 'x' }), /cursor/);
  await assert.rejects(() => feed.query({ window: '3d' }), /window must be/);
  await assert.rejects(() => feed.query({ window: '1d', limit: '1', cursor: paged.nextCursor }), /cursor/);
});

test('a day with only a partial journal is listed and read, tolerating a torn last line, and a growing journal refreshes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-partial-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const day = '2026-10-22';
  const dir = path.join(directory, day, 'sites');
  await fs.mkdir(dir, { recursive: true });
  const journal = path.join(dir, 'observations.partial.jsonl');
  const rows = [rec(day, 'inprogress.com'), rec(day, 'parkedone.com', { class: 'parked' })];
  const torn = JSON.stringify(rec(day, 'torn.com')).slice(0, 40);
  await fs.writeFile(journal, rows.map(r => JSON.stringify(r)).join('\n') + '\n' + torn);
  const feed = createLiveSitesFeed({ universeDir: directory });
  const first = await feed.query({});
  assert.deepEqual(first.days, [day]);
  assert.deepEqual(first.items.map(i => i.domain), ['inprogress.com']);
  assert.equal(first.total, 1);
  for (const item of first.items) assert.deepEqual(Object.keys(item).sort(), FIELDS);
  await fs.writeFile(journal, [...rows, rec(day, 'torn.com'), rec(day, 'later.com')].map(r => JSON.stringify(r)).join('\n') + '\n');
  const second = await feed.query({});
  assert.deepEqual(second.items.map(i => i.domain), ['inprogress.com', 'later.com', 'torn.com']);
  await fs.writeFile(path.join(dir, 'observations.jsonl'), JSON.stringify(rec(day, 'final.com')) + '\n');
  const third = await feed.query({});
  assert.deepEqual(third.items.map(i => i.domain), ['final.com']);
});

test('zone is an exact extension match and zones lists bounded counts for the window', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-zones-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeDay(directory, '2026-10-20', [rec('2026-10-20', 'one.si'), rec('2026-10-20', 'two.site'), rec('2026-10-20', 'three.site'), rec('2026-10-20', 'four.com')]);
  const feed = createLiveSitesFeed({ universeDir: directory });
  const si = await feed.query({ window: '7d', zone: 'si' });
  assert.deepEqual(si.items.map(i => i.domain), ['one.si']);
  assert.equal(si.total, 1);
  assert.deepEqual(si.zones, [{ zone: 'site', count: 2 }, { zone: 'com', count: 1 }, { zone: 'si', count: 1 }]);
  assert.deepEqual((await feed.query({ window: '7d', q: 'o', zone: 'site' })).zones.map(z => z.zone), ['com', 'si', 'site']);
  assert.deepEqual((await feed.query({ window: '7d', q: 'four' })).zones, [{ zone: 'com', count: 1 }]);
});
