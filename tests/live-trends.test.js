'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lt = require('../server/live-trends');

const WORDS = ['red', 'blue', 'green', 'gold', 'silver', 'north', 'south', 'east', 'west', 'bright', 'clear', 'swift', 'bold', 'prime', 'true', 'pure', 'open', 'fresh', 'smart', 'happy', 'lucky', 'urban', 'royal', 'grand', 'solid', 'rapid', 'sunny', 'quiet', 'brave', 'noble'];

function rec(day, domain, title, extra = {}) {
  return {
    domain, day, class: 'built', reason: 'operating_site', title, description: extra.description === undefined ? `About ${title}` : extra.description,
    text: extra.text || null, titleReal: true, spam: false, kit: null,
    fingerprint: { title: extra.fpTitle || title, skeleton: extra.skeleton || `sk-${domain}` }, observedAt: `${day}T09:00:00.000Z`, ...extra.raw,
  };
}

async function writeDay(dir, day, records, file = 'observations.jsonl') {
  const sites = path.join(dir, day, 'sites');
  await fs.mkdir(sites, { recursive: true });
  await fs.appendFile(path.join(sites, file), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-trends-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { universeDir: path.join(dir, 'universe'), cacheDir: path.join(dir, 'cache') };
}

const DAYS = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];

async function standardFixture(t) {
  const dirs = await tmp(t);
  // 30 independent coffee shops (distinct titles, templates and labels).
  for (let i = 0; i < 30; i++) {
    const day = DAYS[i % DAYS.length];
    await writeDay(dirs.universeDir, day, [rec(day, `${WORDS[i]}beans.com`, `${WORDS[i]} coffee roasters`)]);
  }
  // One actor's 30-site kit: same title, different labels -> one operator.
  const kit = WORDS.map(w => rec('2026-10-19', `${w}gardenplan.net`, 'Garden Planner Suite', { skeleton: 'kitskel' }));
  await writeDay(dirs.universeDir, '2026-10-19', kit);
  // A novel term adopted by 3 independent operators on 3 days, two extensions, with frontier co-terms.
  await writeDay(dirs.universeDir, '2026-10-18', [rec('2026-10-18', 'tensorpeak.ai', 'Tensorpeak: inference for AI agents')]);
  await writeDay(dirs.universeDir, '2026-10-19', [rec('2026-10-19', 'fastlane.com', 'Fastlane serverless inference API', { text: 'gpu inference at the edge' })]);
  await writeDay(dirs.universeDir, '2026-10-20', [rec('2026-10-20', 'quietgpu.io', 'Inference clusters on demand', { text: 'gpu compute for agent builders' })]);
  // Exact forms: agent vs agents kept apart.
  await writeDay(dirs.universeDir, '2026-10-20', [
    rec('2026-10-20', 'helpdeskbot.com', 'Support agent for shops'),
    rec('2026-10-20', 'callbot.com', 'Phone agent that answers'),
    rec('2026-10-20', 'teamforge.com', 'Agents that file tickets'),
    rec('2026-10-20', 'opsrun.com', 'Agents for your ops team'),
  ]);
  return dirs;
}

const find = (list, keyword) => (list || []).find(item => item.keyword === keyword);

test('operator dedup: a 30-site same-title kit counts as one operator; 30 independent sites count 30', async t => {
  const dirs = await standardFixture(t);
  const trends = lt.createLiveTrends(dirs);
  const body = await trends.query({ window: '14d', source: 'text', kind: 'biggest', limit: '100' });
  assert.equal(find(body.biggest, 'garden').operators, 1);
  assert.equal(find(body.biggest, 'coffee').operators, 30);
  assert.equal(body.biggest[0].keyword, 'coffee');
  // numbered domain series collapse too
  const ops = lt.operatorIndex([{ ok: lt.operatorKeys({ domain: 'shop1.com', title: 'A one' }) }, { ok: lt.operatorKeys({ domain: 'shop22.com', title: 'B two' }) }].map(s => s));
  const sites = [{ ok: lt.operatorKeys({ domain: 'shop1.com', title: 'A one' }) }, { ok: lt.operatorKeys({ domain: 'shop22.com', title: 'B two' }) }];
  const idx = lt.operatorIndex(sites);
  assert.equal(idx(sites[0]), idx(sites[1]));
  assert.ok(ops);
  // a per-day cache file is written on the data volume
  const cached = JSON.parse(await fs.readFile(path.join(dirs.cacheDir, 'sites', '2026-10-19.json'), 'utf8'));
  assert.equal(cached.day, '2026-10-19');
});

test('exact forms: agent and agents are counted separately; domain and text sources stay separate', async t => {
  const dirs = await standardFixture(t);
  const trends = lt.createLiveTrends(dirs);
  const text = await trends.query({ window: '7d', source: 'text', kind: 'biggest', limit: '100' });
  assert.equal(find(text.biggest, 'agent').operators, 3); // two support/phone + 'agent builders'
  assert.equal(find(text.biggest, 'agents').operators, 3); // two tickets/ops + 'ai agents'
  const domain = await trends.query({ window: '7d', source: 'domain', kind: 'biggest', limit: '100' });
  assert.equal(find(domain.biggest, 'coffee'), undefined);
  assert.equal(find(domain.biggest, 'beans').operators, 30);
  assert.deepEqual(find(domain.biggest, 'beans').sources, { domain: 30, text: 0 });
  assert.deepEqual(lt.segmentDomainLabel('computeriver'), ['compute', 'river']);
  assert.deepEqual(lt.segmentDomainLabel('gpuinference'), ['gpu', 'inference']);
});

test('incremental: rows appended to the CT journal are picked up from the saved offset', async t => {
  const dirs = await standardFixture(t);
  const trends = lt.createLiveTrends({ ...dirs, memoMs: 0 });
  await trends.query({ window: '7d', source: 'text', kind: 'biggest', limit: '100' });
  const reads = trends.cacheStats().dayReads;
  await writeDay(dirs.universeDir, '2026-10-20', [rec('2026-10-20', 'zebracafe.com', 'Zebra coffee bar'), rec('2026-10-20', 'otterbrew.com', 'Otter coffee lab')], 'ct-launches.jsonl');
  const body = await trends.query({ window: '7d', source: 'text', kind: 'biggest', limit: '100' });
  assert.equal(find(body.biggest, 'coffee').operators, 32);
  assert.equal(trends.cacheStats().dayReads, reads + 1);
});

test('rise has a minimum-count floor so 1 -> 3 is not trending', () => {
  assert.equal(lt.riseScore(3, 1), null);
  assert.equal(lt.riseScore(3, 0), null);
  assert.ok(lt.riseScore(6, 1) > 1.5);
  assert.ok(lt.riseScore(8, 20) < 1);
});

test('co-occurrence clustering groups keywords seen on the same operators', () => {
  const opTerms = new Map([
    ['o1', new Set(['compute', 'gpu', 'inference'])],
    ['o2', new Set(['compute', 'gpu', 'cluster'])],
    ['o3', new Set(['gpu', 'inference', 'cluster'])],
    ['o4', new Set(['compute', 'inference', 'cluster'])],
    ['o5', new Set(['coffee', 'roasters'])],
    ['o6', new Set(['coffee', 'roasters'])],
    ['o7', new Set(['coffee', 'bakery'])],
  ]);
  const termOps = new Map();
  for (const set of opTerms.values()) for (const t of set) termOps.set(t, (termOps.get(t) || 0) + 1);
  const clusters = lt.buildClusters(opTerms, termOps).map(c => c.slice().sort());
  assert.ok(clusters.some(c => ['cluster', 'compute', 'gpu', 'inference'].every(t => c.includes(t))));
  assert.ok(clusters.some(c => c.includes('coffee') && c.includes('roasters')));
  assert.ok(!clusters.some(c => c.includes('coffee') && c.includes('gpu')));
});

test('emerging: a novel term with 3 independent operators ranks above a common word with 30', async t => {
  assert.ok(lt.emergingScore({ term: 'inference', operators: 3, perMillion: 2, roles: 2, partners: 4, zones: 2, frontierShare: 0.6 })
    > lt.emergingScore({ term: 'coffee', operators: 30, perMillion: 400, roles: 2, partners: 10, zones: 3, frontierShare: 0 }));
  assert.equal(lt.emergingScore({ term: 'inference', operators: 1 }), 0);
  const dirs = await standardFixture(t);
  const trends = lt.createLiveTrends(dirs);
  const body = await trends.query({ window: '7d', source: 'text', kind: 'emerging', limit: '100' });
  const items = body.emerging.map(e => e.keyword);
  const at = items.indexOf('inference');
  assert.ok(at !== -1, 'inference emerges');
  const coffee = items.indexOf('coffee');
  assert.ok(coffee === -1 || coffee > at, 'common coffee never outranks inference');
  const inf = body.emerging[at];
  assert.equal(inf.evidence.operators, 3);
  assert.ok(inf.evidence.zones.length >= 2);
  assert.ok(inf.evidence.frontierShare > 0);
  assert.ok('baselineFrequency' in inf.evidence && Array.isArray(inf.evidence.roles) && Array.isArray(inf.evidence.partners));
  assert.ok(inf.evidence.examples.length >= 1 && inf.evidence.examples.length <= 5);
  // one actor's kit never emerges
  assert.equal(items.indexOf('planner'), -1);
});

test('stages: watch, forming, confirmed; speculative = registrations up while built flat', () => {
  assert.equal(lt.stageFor({ opsLastWeek: 2, daysLastWeek: 2, roles: 2, zones: 2 }), 'watch');
  assert.equal(lt.stageFor({ opsLastWeek: 3, daysLastWeek: 3, roles: 2, zones: 1, partners: 0 }), 'forming');
  assert.equal(lt.stageFor({ opsLastWeek: 3, daysLastWeek: 3, roles: 2, builtShareFalling: true }), 'watch');
  assert.equal(lt.stageFor({ opsFirstWeek: 4, opsLastWeek: 6, daysFirstWeek: 3, daysLastWeek: 4, operators14: 10, zones: 3, described: 6, roles: 2 }), 'confirmed');
  const built = Array(14).fill(1);
  const regsUp = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 40, 50, 60];
  assert.equal(lt.speculativeFlag(built, regsUp), true);
  const builtUp = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 5, 6];
  assert.equal(lt.speculativeFlag(builtUp, regsUp), false);
  assert.equal(lt.organicFlag(builtUp), true);
  assert.equal(lt.speculativeFlag(built, null), false);
  assert.equal(lt.builtShareFalling(built, regsUp), true);
});

test('registrations series come from universe zone adds next to built launches', async t => {
  const dirs = await standardFixture(t);
  for (const day of DAYS) {
    const dir = path.join(dirs.universeDir, day, 'tape');
    await fs.mkdir(dir, { recursive: true });
    const lines = day >= '2026-10-18' ? ['gpuinference\tcom', 'inferencecloud\tai', 'inferencecloud\tio'] : ['bluebeans\tcom'];
    await fs.writeFile(path.join(dir, 'adds.tsv'), lines.map(l => `${l}\t${day}`).join('\n') + '\n');
  }
  const trends = lt.createLiveTrends({ ...dirs, buildBudget: 20 });
  const body = await trends.query({ window: '7d', source: 'all', kind: 'biggest', limit: '100' });
  const inf = find(body.biggest, 'inference');
  assert.equal(inf.registrations.length, 14);
  assert.equal(inf.registrations[13], 2); // one label in two zones counts once
  assert.equal(inf.series.length, 14);
  assert.ok(['watch', 'forming', 'confirmed'].includes(inf.stage));
  assert.equal(typeof inf.speculative, 'boolean');
});

test('sales join: end-user venues only, exact word, display-only (no effect on rank)', async t => {
  const dirs = await standardFixture(t);
  const salesLoader = async () => [
    { domain: 'distributedcompute.com', price: 25000, date: '2026-10-10', venue: 'Sedo', side: 'enduser', sourceUrl: 'https://www.dnjournal.com/archive/domainsales/2026/1010.htm' },
    { domain: 'inferencelab.com', price: 9000, date: '2026-10-12', venue: 'Afternic', side: 'enduser', sourceUrl: 'https://x/1' },
    { domain: 'inferencehub.com', price: 5000, date: '2026-10-12', venue: 'NameJet', side: 'enduser', sourceUrl: 'https://x/2' },
    { domain: 'inferencenow.com', price: 4000, date: '2026-10-12', venue: 'Sedo', side: 'auction', sourceUrl: 'https://x/3' },
    { domain: 'inferencedeal.com', price: 3000, date: '2026-10-12', venue: 'Closeout', side: 'enduser', sourceUrl: 'https://x/4' },
    { domain: 'conferences.com', price: 3000, date: '2026-10-12', venue: 'Sedo', side: 'enduser', sourceUrl: 'https://x/5' },
  ];
  assert.equal(lt.isEndUserSale({ domain: 'a.com', venue: 'NameJet', side: 'enduser' }), false);
  assert.equal(lt.isEndUserSale({ domain: 'a.com', venue: 'Sedo', side: 'auction' }), false);
  assert.equal(lt.isEndUserSale({ domain: 'a.com', venue: 'Sedo', side: 'enduser' }), true);
  const withSales = lt.createLiveTrends({ ...dirs, salesLoader, now: () => Date.parse('2026-10-21T00:00:00Z') });
  const without = lt.createLiveTrends({ ...dirs, cacheDir: dirs.cacheDir + '-b', now: () => Date.parse('2026-10-21T00:00:00Z') });
  const a = await withSales.query({ window: '7d', source: 'all', limit: '100' });
  const b = await without.query({ window: '7d', source: 'all', limit: '100' });
  const inf = find(a.biggest, 'inference');
  assert.equal(inf.sales.count, 1);
  assert.deepEqual(inf.sales.recent.map(s => s.domain), ['inferencelab.com']);
  assert.deepEqual(Object.keys(inf.sales.recent[0]).sort(), ['date', 'domain', 'price', 'sourceUrl', 'venue']);
  for (const kind of ['emerging', 'trending', 'biggest']) {
    assert.deepEqual(a[kind].map(x => [x.keyword, x.score ?? null, x.stage, x.speculative]), b[kind].map(x => [x.keyword, x.score ?? null, x.stage, x.speculative]), kind);
  }
  assert.equal(find(b.biggest, 'inference').sales.count, 0);
});

function fakeApp() {
  const routes = {};
  return { routes, get(p, h) { routes[`GET ${p}`] = h; }, options(p, h) { routes[`OPTIONS ${p}`] = h; } };
}

async function call(app, query = {}, { method = 'GET', ip = '203.0.113.9' } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: undefined,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  await app.routes[`${method} ${lt.PATH}`]({ query, headers: {}, socket: { remoteAddress: ip } }, res);
  return res;
}

test('endpoint shape: public GET with CORS, cache headers, validation and rate limit', async t => {
  const dirs = await standardFixture(t);
  const trends = lt.createLiveTrends(dirs);
  const app = fakeApp();
  lt.registerLiveTrendsRoutes(app, trends, { env: { DOMAINSCOUT_LIVE_SITES_RATE_LIMIT: '3' } });
  assert.equal(lt.PATH, '/api/public/live-trends');
  const res = await call(app, { window: '14d', source: 'all', limit: '10' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['cache-control'], 'public, max-age=60');
  for (const key of ['window', 'source', 'kind', 'asOf', 'days', 'coverage', 'emerging', 'trending', 'biggest', 'clusters']) assert.ok(key in res.body, key);
  assert.equal(res.body.days.length, 14);
  for (const item of res.body.biggest) {
    for (const key of ['keyword', 'operators', 'daysActive', 'rise', 'series', 'registrations', 'stage', 'speculative', 'examples', 'sales']) assert.ok(key in item, key);
    assert.ok(item.examples.length <= 5);
    for (const ex of item.examples) assert.deepEqual(Object.keys(ex).sort(), ['day', 'domain', 'title']);
  }
  for (const c of res.body.clusters) for (const key of ['name', 'members', 'operators', 'rise', 'series', 'examples']) assert.ok(key in c, key);
  const emerging = await call(app, { kind: 'emerging' }, { ip: '198.51.100.1' });
  assert.deepEqual(Object.keys(emerging.body).filter(k => ['emerging', 'trending', 'biggest', 'clusters'].includes(k)), ['emerging']);
  const bad = await call(app, { window: '30d' }, { ip: '198.51.100.2' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.headers['cache-control'], 'no-store');
  await call(app, {}, { ip: '198.51.100.3' }); await call(app, {}, { ip: '198.51.100.3' }); await call(app, {}, { ip: '198.51.100.3' });
  const limited = await call(app, {}, { ip: '198.51.100.3' });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
  const opt = await call(app, {}, { method: 'OPTIONS' });
  assert.equal(opt.statusCode, 204);
});

test('empty universe answers an empty, well-formed body', async t => {
  const dirs = await tmp(t);
  const body = await lt.createLiveTrends(dirs).query({});
  assert.deepEqual(body.days, []);
  assert.deepEqual(body.emerging, []);
  assert.deepEqual(body.clusters, []);
});

test('concurrent cold requests build once and appended observations replace obsolete models', async t => {
  const dirs = await standardFixture(t);
  const trends = lt.createLiveTrends(dirs);
  const input = { source: 'text', kind: 'biggest', limit: '100' };
  const bodies = await Promise.all(Array.from({ length: 6 }, () => trends.query(input)));
  for (const body of bodies) assert.deepEqual(body.biggest, bodies[0].biggest);
  assert.equal(trends.cacheStats().models, 1);
  await writeDay(dirs.universeDir, '2026-10-20', [rec('2026-10-20', 'newroaster.com', 'New coffee roasters')]);
  const updated = await trends.query(input);
  assert.equal(find(updated.biggest, 'coffee').operators, 31);
  assert.equal(trends.cacheStats().models, 2);
  assert.equal(trends.cacheStats().retainedModels, 1);
});
