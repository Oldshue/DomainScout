'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const feedModule = require('../server/live-sites-feed');
const { buildProjectionFromSource, validProjection } = require('../server/live-sites-public-projection');

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

test('immutable compact projections serve unfiltered windows while explicit body search retains full fidelity', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-projection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const day = '2026-11-15';
  await writeDay(directory, day, [
    rec(day, 'projected.com', { text: `private body ${'x'.repeat(20000)} hidden-needle` }),
    rec(day, 'excluded.com', { class: 'parked', text: 'hidden-needle' }),
  ]);
  const sourcePath = path.join(directory, day, 'sites', 'observations.jsonl');
  const built = await buildProjectionFromSource({ sourcePath, day });
  assert.equal(built.meta.rows, 1);
  assert.ok(await validProjection(sourcePath));
  const sourceStat = await fs.stat(sourcePath);
  assert.ok(built.meta.projectionBytes < sourceStat.size / 20, 'private body text is absent from the compact public projection');

  const feed = createLiveSitesFeed({ universeDir: directory });
  const landing = await feed.query({ window: '7d' });
  assert.deepEqual(landing.items.map(item => item.domain), ['projected.com']);
  assert.ok(feed.cacheStats().bytesRead < sourceStat.size / 20, 'the unfiltered page does not read the private observation body');

  const searched = await feed.query({ window: '7d', q: 'hidden-needle' });
  assert.deepEqual(searched.items.map(item => item.domain), ['projected.com']);
  assert.match(searched.items[0].snippet, /hidden-needle/);
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
  // q also matches the description ("About three.site" contains 'o'), so .site has 2 matches.
  assert.deepEqual((await feed.query({ window: '7d', q: 'o', zone: 'site' })).zones.map(z => z.zone), ['site', 'com', 'si']);
  assert.deepEqual((await feed.query({ window: '7d', q: 'four' })).zones, [{ zone: 'com', count: 1 }]);
});

async function collect(feed, query) {
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const body = await feed.query({ ...query, ...(cursor ? { cursor } : {}) });
    seen.push(...body.items.map(i => i.domain));
    cursor = body.nextCursor;
    pages += 1;
  } while (cursor && pages < 50);
  return seen;
}

test('within a day rows are newest observedAt first, rows without observedAt last, then by domain', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-order-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const day = '2026-10-20';
  await writeDay(directory, day, [
    rec(day, 'aaa.com', { observedAt: `${day}T08:00:00.000Z` }),
    rec(day, 'zzz.com', { observedAt: `${day}T11:00:00.000Z` }),
    rec(day, 'noobs-b.com', { observedAt: undefined }),
    rec(day, 'mmm.com', { observedAt: `${day}T11:00:00.000Z` }),
    rec(day, 'noobs-a.com', { observedAt: null }),
    rec(day, 'bbb.com', { observedAt: `${day}T09:30:00.000Z` }),
  ]);
  await writeDay(directory, '2026-10-19', [rec('2026-10-19', 'older.com', { observedAt: '2026-10-19T23:59:00.000Z' })]);
  const feed = createLiveSitesFeed({ universeDir: directory });
  const body = await feed.query({ window: '7d' });
  assert.deepEqual(body.items.map(i => i.domain), ['mmm.com', 'zzz.com', 'bbb.com', 'aaa.com', 'noobs-a.com', 'noobs-b.com', 'older.com']);
  assert.equal(body.items.find(i => i.domain === 'noobs-a.com').observedAt, null);
  assert.deepEqual(await collect(feed, { window: '7d', limit: '2' }), body.items.map(i => i.domain));
});

test('cursor paging is stable when rows are appended between page loads', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-append-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const day = '2026-10-20';
  const at = h => `${day}T${h}:00:00.000Z`;
  const base = [
    rec(day, 'a10.com', { observedAt: at('10') }), rec(day, 'a09.com', { observedAt: at('09') }),
    rec(day, 'a08.com', { observedAt: at('08') }), rec(day, 'a07.com', { observedAt: at('07') }),
    rec(day, 'nonea.com', { observedAt: null }), rec(day, 'noneb.com', { observedAt: null }),
  ];
  await writeDay(directory, day, base);
  const feed = createLiveSitesFeed({ universeDir: directory });
  const first = await feed.query({ window: '1d', limit: '2' });
  assert.deepEqual(first.items.map(i => i.domain), ['a10.com', 'a09.com']);
  await writeDay(directory, day, [
    ...base,
    rec(day, 'new12.com', { observedAt: at('12') }), rec(day, 'new11.com', { observedAt: at('11') }),
    rec(day, 'aaa-tie.com', { observedAt: at('09') }), rec(day, 'old06.com', { observedAt: at('06') }),
    rec(day, 'nonec.com', { observedAt: null }),
  ]);
  const rest = [];
  let cursor = first.nextCursor;
  while (cursor) {
    const body = await feed.query({ window: '1d', limit: '2', cursor });
    rest.push(...body.items.map(i => i.domain));
    cursor = body.nextCursor;
  }
  // aaa-tie.com ties a09.com on observedAt and sorts after it by domain, so it lands after the cursor (no gap).
  assert.deepEqual(rest, ['aaa-tie.com', 'a08.com', 'a07.com', 'old06.com', 'nonea.com', 'noneb.com', 'nonec.com']);
  assert.equal(new Set([...first.items.map(i => i.domain), ...rest]).size, 9);
  const fresh = await feed.query({ window: '1d', limit: '3' });
  assert.deepEqual(fresh.items.map(i => i.domain), ['new12.com', 'new11.com', 'a10.com']);
});

test('cursor without an observedAt position is rejected', async t => {
  const feed = await fixture(t);
  const old = Buffer.from(JSON.stringify({ d: '2026-10-20', k: 'alpha.io', h: 'x' })).toString('base64url');
  await assert.rejects(() => feed.query({ window: '7d', cursor: old }), /cursor/);
});

test('concurrent cold readers share one journal load per day', async t => {
  const feed = await fixture(t);
  const pages = await Promise.all(Array.from({ length: 8 }, () => feed.query({ window: '7d' })));
  for (const page of pages) assert.deepEqual(page.items, pages[0].items);
  assert.equal(feed.cacheStats().loads, 3);
});

test('the public feed retains no more day caches than its largest supported window', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-window-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (let day = 1; day <= 8; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    await writeDay(directory, date, [rec(date, `site${day}.com`)]);
  }
  const feed = createLiveSitesFeed({ universeDir: directory });
  await feed.query({ window: '7d' });
  assert.equal(feed.cacheStats().days, 7);
  const next = '2026-11-09';
  await writeDay(directory, next, [rec(next, 'newest.com')]);
  await feed.query({ window: '7d' });
  assert.equal(feed.cacheStats().days, 7, 'a new day evicts the day that left the supported window');
});

test('growing journals read only new bytes, finish torn UTF-8 rows, and invalidate replaced files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feed-append-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const day = '2026-10-20';
  const dir = path.join(directory, day, 'sites');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'ct-launches.jsonl');
  const old = Array.from({ length: 200 }, (_, i) => rec(day, `store${i}.com`, { title: `Store ${i}` }));
  await fs.writeFile(file, old.map(JSON.stringify).join('\n') + '\n');
  const feed = createLiveSitesFeed({ universeDir: directory });
  assert.equal((await feed.query()).total, 200);
  const before = feed.cacheStats();
  const next = Buffer.from(JSON.stringify(rec(day, 'cafe.com', { title: 'Café' })) + '\n');
  const split = next.indexOf(Buffer.from('é')) + 1;
  await fs.appendFile(file, next.subarray(0, split));
  assert.equal((await feed.query()).total, 200);
  await fs.appendFile(file, next.subarray(split));
  assert.equal((await feed.query({ q: 'Café' })).total, 1);
  assert.ok(feed.cacheStats().bytesRead - before.bytesRead <= next.length * 2);
  assert.equal(feed.cacheStats().haystacks - before.haystacks, 200,
    'the body projection is created lazily only for rows whose compact fields did not match');
  await fs.writeFile(file + '.new', JSON.stringify(rec(day, 'replacement.com')) + '\n');
  await fs.rename(file + '.new', file);
  assert.equal((await feed.query()).total, 1);
});


test('exclude filters every searchable field before totals, facets and pagination', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-exclude-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const day = '2026-10-28';
  await writeDay(directory, day, [
    rec(day, 'computer.com', { title: 'compute domain exclusion' }),
    rec(day, 'title.io', { title: 'COMPUTER hardware compute' }),
    rec(day, 'description.net', { title: 'Compute description', description: 'computer hardware' }),
    rec(day, 'body.org', { title: 'Compute body', text: 'computer architecture' }),
    rec(day, 'keep.com', { title: 'Compute cloud' }),
    rec(day, 'keep.io', { title: 'Compute infrastructure' }),
    rec(day, 'bodykeep.dev', { title: 'Inference tools', text: 'compute economics' }),
  ]);
  const feed = createLiveSitesFeed({ universeDir: directory });
  const query = { q: 'compute', exclude: ' Computer ', limit: '1' };
  const first = await feed.query(query);
  assert.equal(first.total, 3);
  assert.deepEqual(first.zones.map(z => z.zone).sort(), ['com', 'dev', 'io']);
  const domains = first.items.map(i => i.domain);
  let cursor = first.nextCursor;
  while (cursor) {
    const next = await feed.query({ ...query, cursor });
    domains.push(...next.items.map(i => i.domain)); cursor = next.nextCursor;
  }
  assert.deepEqual(domains.sort(), ['bodykeep.dev', 'keep.com', 'keep.io']);
  assert.equal((await feed.query({ ...query, zone: 'com' })).total, 1);
  assert.equal((await feed.query({ exclude: 'computer' })).total, 3);
  assert.equal((await feed.query({ q: 'compute', exclude: '' })).total, 7);
  await assert.rejects(feed.query({ ...query, exclude: 'hardware', cursor: first.nextCursor }), /cursor does not belong/);
  await assert.rejects(feed.query({ exclude: 'x'.repeat(101) }), /exclude may not exceed/);
});


test('cross-day CT/daily duplicates keep the newest identity in totals, zones, queries and cursor pages', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-identity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeDay(directory, '2026-11-01', [
    rec('2026-11-01', 'coefficient.com', { title: 'Current business identity' }),
    rec('2026-11-01', 'harbor.io'),
  ]);
  await writeDay(directory, '2026-10-31', [
    rec('2026-10-31', 'coefficient.com', { title: 'Former unrelated keyword' }),
    rec('2026-10-31', 'cedar.com'),
  ]);
  const feed = createLiveSitesFeed({ universeDir: directory });
  const names = [];
  let cursor;
  do {
    const page = await feed.query({ window: '2d', limit: '1', ...(cursor ? { cursor } : {}) });
    assert.equal(page.total, 3);
    assert.deepEqual(page.zones, [{ zone: 'com', count: 2 }, { zone: 'io', count: 1 }]);
    names.push(...page.items.map(item => item.domain));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(names, ['coefficient.com', 'harbor.io', 'cedar.com']);
  assert.equal((await feed.query({ window: '2d', q: 'former unrelated' })).total, 0);
  assert.equal((await feed.query({ window: '2d', q: 'current business' })).total, 1);
  assert.equal((await feed.query({ window: '2d', zone: 'com' })).total, 2);
  // A shorter source window still exposes the same newest identity.
  assert.equal((await feed.query({ window: '1d' })).total, 2);
});


test('retained rows with old spam flags are rechecked from multilingual promotional metadata', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-quality-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeDay(directory, '2026-11-01', [
    rec('2026-11-01', 'retained-promotion.com', { title: '星空综合官网', description: '体彩全站，真人游戏，棋牌捕鱼，注册即送', spam: false }),
    rec('2026-11-01', 'retained-casino.com', { title: 'Сервис', description: 'Онлайн казино и игровые автоматы', spam: false }),
    rec('2026-11-01', 'factory.com', { title: '光学设备制造', description: '汽车配件、工业设计和精密仪器。' }),
    rec('2026-11-01', 'sports.com', { title: '体育训练中心', description: '足球篮球训练、赛事新闻和学生课程。' }),
  ]);
  const feed = createLiveSitesFeed({ universeDir: directory });
  const page = await feed.query({ window: '1d' });
  assert.equal(page.total, 2);
  assert.deepEqual(page.items.map(x => x.domain), ['factory.com', 'sports.com']);
  assert.equal((await feed.query({ window: '1d', q: '棋牌' })).total, 0);
});


test('retained titleReal flags cannot publish hosting defaults or access challenges', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-title-replay-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeDay(directory, '2026-10-20', [
    rec('2026-10-20', 'default.com', { title: 'Site is created successfully!' }),
    rec('2026-10-20', 'challenge.com', { title: '请验证... / Please verify...' }),
    rec('2026-10-20', 'successacademy.com', { title: 'Success Academy' }),
  ]);
  const body = await createLiveSitesFeed({ universeDir: directory }).query({ window: '2d' });
  assert.deepEqual(body.items.map(i => i.domain), ['successacademy.com']);
});

test('a 7-day window pages through the public store without rescanning, matching the direct read row for row', async t => {
  const { advanceDay } = require('../server/live-sites-public-store');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-7d-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const days = ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'];
  const zones = ['com', 'ai', 'io', 'net', 'dev'];
  const PER_DAY = 2500, CT_PER_DAY = 700;
  const row = (day, index, source) => rec(day, `${source}-${day.slice(8)}-${String(index).padStart(5, '0')}.${zones[index % zones.length]}`, {
    title: index % 400 < 9 ? 'Shared Kit Storefront' : `${index % 7 === 0 ? 'Compute' : 'Studio'} ${source} ${index}`,
    description: index % 11 === 0 ? 'GPU inference for teams' : `About ${index}`,
    text: index % 13 === 0 ? `plain words then a rare inference cluster ${index}` : `ordinary page ${index}`,
    observedAt: index % 97 === 0 ? null : `${day}T${String(index % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
  });
  for (const [at, day] of days.entries()) {
    const sites = path.join(directory, day, 'sites');
    await fs.mkdir(sites, { recursive: true });
    const daily = Array.from({ length: PER_DAY }, (_, index) => row(day, index, 'daily'));
    // The same domains seen a day earlier must stay owned by the newer day.
    if (at > 0) for (let index = 0; index < 50; index += 1) daily.push(rec(day, `daily-${days[at - 1].slice(8)}-${String(index * 3).padStart(5, '0')}.${zones[(index * 3) % zones.length]}`, { title: `Renamed ${index}`, text: 'no longer matches' }));
    const ct = Array.from({ length: CT_PER_DAY }, (_, index) => row(day, index, 'ct'));
    for (let index = 0; index < 40; index += 1) ct.push(rec(day, `daily-${day.slice(8)}-${String(index).padStart(5, '0')}.${zones[index % zones.length]}`, { title: 'CT copy loses to the daily row' }));
    const final = day !== days.at(-1);
    await fs.writeFile(path.join(sites, final ? 'observations.jsonl' : 'observations.partial.jsonl'), daily.map(r => `${JSON.stringify(r)}\n`).join(''));
    await fs.writeFile(path.join(sites, 'ct-launches.jsonl'), ct.map(r => `${JSON.stringify(r)}\n`).join(''));
    await fs.writeFile(path.join(sites, 'summary.json'), JSON.stringify({ day, status: final ? 'complete' : 'running' }));
    await advanceDay({ universeDir: directory, day });
  }
  const reader = feedModule.createPublicStoreReader({ universeDir: directory });
  t.after(() => reader.close());
  const stored = createLiveSitesFeed({ universeDir: directory, publicStore: reader, projectionRepair: () => {} });
  const direct = createLiveSitesFeed({ universeDir: directory });
  const pageAll = async (feed, query, onPage = null) => {
    const items = [], timings = [];
    let cursor, first = null, pages = 0;
    do {
      const started = process.hrtime.bigint();
      const body = await feed.query({ ...query, ...(cursor ? { cursor } : {}) });
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      first ||= body; items.push(...body.items); cursor = body.nextCursor; pages += 1;
      if (onPage) await onPage(pages);
    } while (cursor);
    return { items, pages, timings, total: first.total, zones: first.zones };
  };

  await stored.query({ window: '7d', limit: '1' });
  const pid = reader.status().workerPid;
  for (const query of [
    { window: '7d', limit: '1000' },
    { window: '7d', q: 'inference', limit: '200' },
    { window: '7d', q: 'compute', exclude: 'ct-', zone: 'ai', limit: '100' },
    { window: '7d', q: 'gp', limit: '300' },
    { window: '2d', zone: 'dev', limit: '300' },
  ]) {
    const [got, want] = [await pageAll(stored, query), await pageAll(direct, query)];
    assert.ok(got.pages >= 5, `${JSON.stringify(query)} spans ${got.pages} pages`);
    assert.equal(got.total, want.total);
    assert.equal(got.items.length, got.total, 'every counted row is served exactly once');
    assert.equal(new Set(got.items.map(item => item.domain)).size, got.items.length);
    assert.deepEqual(got.items, want.items);
    assert.deepEqual(got.zones, want.zones);
    // Later pages resume from the cursor; they do not repeat the first page's work.
    const later = got.timings.slice(1).sort((a, b) => a - b);
    assert.ok(later[Math.floor(later.length / 2)] < 500, `median later page took ${later[Math.floor(later.length / 2)]} ms`);
  }
  assert.equal(reader.status().workerPid, pid, 'one reader process served every page');

  // Rows appended to the running day mid-paging neither repeat nor drop rows already paged past.
  const today = days.at(-1), todaySites = path.join(directory, today, 'sites');
  const before = await pageAll(stored, { window: '7d', q: 'inference', limit: '200' });
  const during = await pageAll(stored, { window: '7d', q: 'inference', limit: '200' }, async pages => {
    if (pages !== 2) return;
    await fs.appendFile(path.join(todaySites, 'ct-launches.jsonl'), `${JSON.stringify(rec(today, 'appended-late.ai', { text: 'fresh inference row', observedAt: `${today}T23:59:59.000Z` }))}\n`);
    await advanceDay({ universeDir: directory, day: today });
  });
  assert.deepEqual(during.items.map(item => item.domain), before.items.map(item => item.domain));
  const after = await pageAll(stored, { window: '7d', q: 'inference', limit: '200' });
  assert.equal(after.total, before.total + 1);
  assert.equal(after.items[0].domain, 'appended-late.ai');
  assert.deepEqual(after.items, (await pageAll(direct, { window: '7d', q: 'inference', limit: '200' })).items);

  // A visitor who leaves mid-read does not cost the next one a cold reader.
  const controller = new AbortController();
  const abandoned = reader.query({ days: days.slice().reverse(), q: 'studio', exclude: '', zone: '', cursor: null, limit: 50 }, controller.signal);
  controller.abort();
  await assert.rejects(abandoned, error => error.name === 'AbortError');
  assert.equal((await stored.query({ window: '7d', q: 'studio' })).items.length, 50);
  assert.equal(reader.status().workerPid, pid);
});

test('a cold reader loading a long window is held to its deadline per day, not for the whole window', async t => {
  const { advanceDay } = require('../server/live-sites-public-store');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-cold-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const days = ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'];
  for (const day of days) await writeDay(directory, day, [rec(day, `only-${day.slice(8)}.com`)]).then(() => advanceDay({ universeDir: directory, day }));
  const workerPath = path.join(directory, 'slow-reader.js');
  // Stand-in reader: every day takes 150 ms to load, 1050 ms for the window.
  await fs.writeFile(workerPath, `process.on('message', async message => {
    for (const day of message.payload.days) { await new Promise(resolve => setTimeout(resolve, 150)); if (message.payload.report) process.send({ id: message.id, progress: true }); }
    process.send({ id: message.id, ok: true, value: { days: message.payload.days.length } });
  });`);
  const reader = feedModule.createPublicStoreReader({ universeDir: directory, deadlineMs: 600, workerPath });
  t.after(() => reader.close());
  assert.deepEqual(await reader.query({ days, report: true }), { days: 7 });
  await assert.rejects(reader.query({ days, report: false }), /exceeded its deadline/);
});

test('a two-character search stays exact from the index alone, however many distinct terms carry the pair', async t => {
  const { advanceDay } = require('../server/live-sites-public-store');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-feed-pair-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const days = ['2026-11-16', '2026-11-17'];
  for (const day of days) {
    // 4,500 different characters follow or precede the pair: more terms than one lookup carries.
    const rows = Array.from({ length: 4500 }, (_, index) => rec(day, `pair-${day.slice(8)}-${index}.com`, {
      title: `Page ${index}`, description: null,
      text: index % 2 ? `x3d${String.fromCodePoint(0x4e00 + index)} tail` : `head ${String.fromCodePoint(0x4e00 + index)}3d`,
    }));
    rows.push(rec(day, `without-${day.slice(8)}.com`, { title: 'Nothing here', description: null, text: '3 d apart' }));
    rows.push(rec(day, `upper-${day.slice(8)}.com`, { title: 'Printed in 3D', description: null, text: 'capital letters' }));
    rows.push(rec(day, `accent-${day.slice(8)}.com`, { title: 'Café Étoile', description: null, text: 'ÉCLAIR et crème' }));
    rows.push(rec(day, `kana-${day.slice(8)}.com`, { title: 'みんなの店', description: null, text: '東京の花屋' }));
    await writeDay(directory, day, rows);
    await advanceDay({ universeDir: directory, day });
  }
  const reader = feedModule.createPublicStoreReader({ universeDir: directory });
  t.after(() => reader.close());
  const stored = createLiveSitesFeed({ universeDir: directory, publicStore: reader, projectionRepair: () => {} });
  const direct = createLiveSitesFeed({ universeDir: directory });
  for (const query of [{ window: '7d', q: '3d', limit: '1000' }, { window: '7d', exclude: '3d', limit: '1000' }, { window: '7d', q: 'page', exclude: '3d', limit: '1000' },
    { window: '7d', q: 'é' }, { window: '7d', q: 'É' }, { window: '7d', q: 'の' }, { window: '7d', q: 'の店' }, { window: '7d', q: 'éc' }, { window: '7d', q: '\u4e2d', limit: '1000' },
    { window: '7d', q: 'd', limit: '1000' }, { window: '7d', q: 'D', zone: 'com' }, { window: '7d', exclude: 'p' }, { window: '7d', q: '~' }, { window: '7d', q: 'x', exclude: '3' }]) {
    const [got, want] = [await stored.query(query), await direct.query(query)];
    assert.equal(got.total, want.total);
    assert.deepEqual(got.items, want.items);
    assert.equal(got.projection.status, 'verified');
  }
  assert.equal((await stored.query({ window: '7d', q: '3d' })).total, 9002);
  assert.equal((await stored.query({ window: '7d', exclude: '3d' })).total, 6);
  assert.equal((await stored.query({ window: '7d', q: 'の' })).total, 2);
  assert.equal((await stored.query({ window: '7d', q: 'é' })).total, 2);
});
