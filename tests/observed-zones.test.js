'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const wire = require('../server/dns-wire');
const { createAuthoritativeResolver } = require('../server/authoritative-dns');
const oz = require('../server/observed-zones');
const { diffZoneDelegations, delegations } = require('../server/zone-ns-movement');

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    get: async (key) => {
      if (!objects.has(key)) throw Object.assign(Error('missing'), { code: 'ENOENT' });
      return objects.get(key);
    },
    put: async (key, body) => objects.set(key, Buffer.from(body)),
    getStream: async function (key) { return Readable.from(await this.get(key)); },
    putFile: async function (key, file) {
      const body = await fsp.readFile(file);
      objects.set(key, body);
      return { key, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
    },
  };
}

// Fake authoritative TLD servers behind the REAL resolver + wire codec.
// zone[name] = hosts[] (referral) | 'nxdomain' | 'servfail' | 'timeout'; absent = nxdomain.
function fakeDns(zone) {
  const queries = [];
  const resolver = createAuthoritativeResolver({
    enabled: true, retries: 0, timeoutMs: 200, healthMaxUnknownRatio: 1.01,
    perServerQps: 100000, perServerBurst: 100000,
    discover: async () => [
      { host: 'a.tld-servers.test', ip: '192.0.2.1', family: 4 },
      { host: 'b.tld-servers.test', ip: '192.0.2.2', family: 4 },
    ],
    sleep: async () => {},
    transport: {
      async query({ server, name }) {
        queries.push({ server, name });
        const answer = zone[name] === undefined ? 'nxdomain' : zone[name];
        if (answer === 'timeout') return { timeout: true };
        let buf;
        if (answer === 'nxdomain') buf = wire.encodeResponse({ id: 0, name, rcode: 3, aa: true, authority: [{ name: 'si', type: wire.TYPE.SOA }] });
        else if (answer === 'servfail') buf = wire.encodeResponse({ id: 0, name, rcode: 2 });
        else buf = wire.encodeResponse({ id: 0, name, rcode: 0, aa: false, authority: answer.map(h => ({ name, type: wire.TYPE.NS, data: h })) });
        return { message: wire.decodeMessage(buf) };
      },
    },
  });
  return { probe: n => resolver.probe(n), queries };
}

function observedFixture(t, { roster = [], config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-zones-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = memoryStore();
  const zone = {};
  const names = new Set(roster);
  const dns = fakeDns(zone);
  const state = { day: '2026-10-01' };
  const dataDir = path.join(root, 'data');
  const work = path.join(root, 'work');
  const env = { DOMAINSCOUT_OBSERVED_ZONES: 'si', DOMAINSCOUT_UNIVERSE_SCRATCH_DIR: path.join(root, 'scratch') };
  const runner = () => oz.createObservedZoneRunner({
    dataDir, universeDir: work, env, objectStore: store,
    now: () => new Date(state.day + 'T12:00:00Z'),
    log: { log() {}, error() {} }, sleep: async () => {}, limiter: async () => {},
    probe: dns.probe,
    feeders: [{ name: 'fixture', collect: async () => ({ names: [...names] }) }],
    config,
  });
  const run = (day) => { state.day = day; return runner().runZone({ tld: 'si', day }); };
  return { root, store, zone, names, dns, state, dataDir, work, env, run };
}

const latestKey = 'domainscout/corpora/zone-universe/v2/observed/si/latest.json';
const latestOf = async store => JSON.parse((await store.get(latestKey)).toString());
const readRows = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

// ── Snapshot synthesis ─────────────────────────────────────────────────────
test('synthesized snapshot is canonical zone lines in owner byte order and passes the merge join', async t => {
  const names = ['zz.si', 'a.si', 'b.si', 'a-b.si', 'gone.si'];
  const results = [
    { status: 'taken', nameservers: ['ns1.z.test'] },
    { status: 'taken', nameservers: ['ns1.x.test', 'ns2.x.test'] },
    { status: 'unknown', reason: 'timeout' },
    { status: 'taken', nameservers: ['ns.y.test'] },
    { status: 'not_taken' },
  ];
  const previous = new Map([['b.si', ['ns.prev.test']]]);
  const snap = oz.synthesizeSnapshot({ names, results, previous });
  assert.equal(snap.carriedForward, 1);
  assert.deepEqual(snap.text.split('\n').filter(Boolean), [
    'a-b.si.\t86400\tin\tns\tns.y.test.',
    'a.si.\t86400\tin\tns\tns1.x.test.',
    'a.si.\t86400\tin\tns\tns2.x.test.',
    'b.si.\t86400\tin\tns\tns.prev.test.',
    'zz.si.\t86400\tin\tns\tns1.z.test.',
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-snap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.gz');
  fs.writeFileSync(file, zlib.gzipSync(snap.text));
  const parsed = [];
  for await (const d of delegations(file, { zone: 'si' })) parsed.push(d);
  assert.deepEqual(parsed.map(d => d.name), ['a-b.si', 'a.si', 'b.si', 'zz.si']);
  const counts = await diffZoneDelegations({ prevPath: file, todayPath: file, zone: 'si' });
  assert.equal(counts.unchanged, 4);
});

test('referral answers parse into the NS set; NXDOMAIN is not delegated; SERVFAIL/timeout are unknown and retried', async () => {
  const zone = { 'alpha.si': ['NS2.Host.TEST.', 'ns1.host.test'], 'busy.si': 'servfail', 'slow.si': 'timeout' };
  const dns = fakeDns(zone);
  const { results, counts } = await oz.observeNames({
    names: ['alpha.si', 'none.si', 'busy.si', 'slow.si'], probe: dns.probe,
    config: { concurrency: 2, retries: 2, backoffMs: 0 }, sleep: async () => {},
  });
  assert.deepEqual(results[0], { status: 'taken', nameservers: ['ns1.host.test', 'ns2.host.test'] });
  assert.equal(results[1].status, 'not_taken');
  assert.equal(results[2].status, 'unknown');
  assert.equal(results[3].status, 'unknown');
  assert.equal(counts.delegated, 1);
  assert.equal(counts.nxdomain, 1);
  assert.equal(counts.unknown, 2);
  assert.equal(counts.retried, 4);
  assert.equal(counts.reasons.servfail, 1);
  assert.equal(counts.reasons.timeout, 1);
  assert.equal(new Set(dns.queries.map(q => q.server)).size, 2, 'load is spread across the TLD servers');
});

test('rate limiter holds the configured qps', async () => {
  let clock = 0;
  const limiter = oz.createRateLimiter(4, { now: () => clock, sleep: async ms => { clock += ms; } });
  for (let i = 0; i < 12; i += 1) await limiter();
  assert.ok(clock >= 1900, `12 takes at 4 qps with burst 4 took ${clock}ms`);
});

// ── Roster ─────────────────────────────────────────────────────────────────
test('a name answering NXDOMAIN for 30 consecutive observed days retires; delegated names stay', () => {
  const roster = oz.emptyRoster('si');
  oz.mergeIntoRoster(roster, ['gone.si', 'kept.si'], { source: 'x', day: '2026-01-01' });
  const day = i => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  for (let i = 1; i <= 30; i += 1) {
    const r = oz.applyObservationToRoster(roster, ['gone.si', 'kept.si'], [{ status: 'not_taken' }, { status: 'taken', nameservers: ['ns.t'] }], { day: day(i), retireAfterDays: 30 });
    if (i === 29) {
      assert.equal(roster.names.get('gone.si').nxStreak, 29);
      assert.equal(oz.applyObservationToRoster(roster, ['gone.si'], [{ status: 'not_taken' }], { day: day(i), retireAfterDays: 30 }).alreadyApplied, true);
      assert.equal(roster.names.get('gone.si').nxStreak, 29, 'a repeated day is not double counted');
    }
    if (i === 30) assert.equal(r.retired, 1);
  }
  assert.equal(roster.names.has('gone.si'), false);
  assert.equal(roster.retired.get('gone.si'), day(30));
  assert.equal(roster.names.get('kept.si').lastDelegated, day(30));
  // An unknown or delegated answer resets nothing / resets the streak.
  const r2 = oz.emptyRoster('si');
  oz.mergeIntoRoster(r2, ['flip.si'], { day: day(0) });
  for (let i = 1; i <= 29; i += 1) oz.applyObservationToRoster(r2, ['flip.si'], [{ status: 'not_taken' }], { day: day(i), retireAfterDays: 30 });
  oz.applyObservationToRoster(r2, ['flip.si'], [{ status: 'taken', nameservers: ['ns.t'] }], { day: day(30), retireAfterDays: 30 });
  assert.equal(r2.names.get('flip.si').nxStreak, 0);
});

test('pluggable feeders merge and dedupe; a failing feeder is recorded and never blocks the rest', async () => {
  const roster = oz.emptyRoster('si');
  roster.retired.set('old.si', '2026-01-01');
  const report = await oz.runFeeders(roster, [
    { name: 'stores', collect: async () => ({ names: ['Alpha.SI', 'alpha.si', 'sub.alpha.si', 'x.com', 'bad_.si', 'old.si', 'beta.si.'] }) },
    { name: 'broken', collect: async () => { throw new Error('crt.sh down'); } },
    { name: 'ct', fresh: true, collect: async ({ cursor }) => ({ names: ['beta.si', 'old.si', '*.gamma.si'], cursor: { n: (cursor?.n || 0) + 1 } }) },
  ], { day: '2026-10-01', now: () => new Date('2026-10-01T00:00:00Z'), maxRoster: 100 });
  assert.deepEqual([...roster.names.keys()].sort(), ['alpha.si', 'beta.si', 'gamma.si', 'old.si']);
  assert.equal(report.stores.added, 2);
  assert.equal(report.stores.skippedRetired, 1);
  assert.equal(report.broken.error, 'crt.sh down');
  assert.equal(report.ct.added, 2);
  assert.deepEqual(roster.cursors.ct, { n: 1 });
  assert.deepEqual(roster.names.get('beta.si').sources, ['stores', 'ct']);
  assert.equal(roster.retired.has('old.si'), false, 'fresh evidence revives a retired name');
  const store = memoryStore();
  await oz.saveRoster(store, 'p', roster);
  const loaded = await oz.loadRoster(store, 'p', 'si');
  assert.deepEqual([...loaded.names.entries()], [...roster.names.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  assert.deepEqual(loaded.cursors, roster.cursors);
});

test('the crt.sh feeder resumes a failed window instead of skipping it', async () => {
  const calls = [];
  let failing = true;
  const feeder = oz.createCtFeeder({
    config: { ctWindowDays: 7, ctMinWindowDays: 7, ctMaxWindows: 3, ctBackfillDays: 30, ctPaceMs: 0, ctRetryDelayMs: 0 },
    sleep: async () => {},
    log: { error() {} },
    fetchWindow: async (tld, from, to) => {
      calls.push(`${from}..${to}`);
      if (failing && calls.length >= 2) throw new Error('crt.sh 502');
      return [`w${calls.length}.si`];
    },
  });
  const now = () => new Date('2026-10-14T12:00:00Z');
  const first = await feeder.collect({ tld: 'si', cursor: null, now });
  assert.match(first.error, /crt\.sh 502/);
  assert.equal(calls.length, 3, 'the failed window was retried once');
  assert.equal(first.cursor.newest, '2026-10-14');
  assert.equal(first.cursor.oldest, '2026-10-07');
  assert.match(first.cursor.lastError.message, /crt\.sh 502/);
  failing = false;
  calls.length = 0;
  const second = await feeder.collect({ tld: 'si', cursor: first.cursor, now });
  assert.equal(calls[0], '2026-09-30..2026-10-07');
  assert.equal(second.error, null);
  assert.equal(second.cursor.lastError, undefined);
});

test('store feeder reads every name of the zone from the data-volume databases', async t => {
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-stores-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = new Database(path.join(dir, 'domains.db'));
  d.exec("CREATE TABLE domains (domain TEXT); INSERT INTO domains VALUES ('one.si'),('one.com');");
  d.close();
  const s = new Database(path.join(dir, 'sale_watch.db'));
  s.exec("CREATE TABLE sale_watch_candidates (domain TEXT); INSERT INTO sale_watch_candidates VALUES ('two.si');");
  s.close();
  const result = await oz.createStoreFeeder({ dataDir: dir }).collect({ tld: 'si' });
  assert.deepEqual([...result.names].sort(), ['one.si', 'two.si']);
  assert.equal(result.detail.research_prefix_hits, 'absent');
  assert.equal(result.detail.domains, 1);
  assert.equal(result.detail.sibling_tld_status, 'absent', 'a missing table is absent, not an error');
  assert.equal(result.error, null);
});

// ── Roster growth: stores absent, crt.sh robustness, Common Crawl ──────────
test('store feeder reports a missing database or table as absent, never as an error (DB-free)', async () => {
  const opened = [];
  const feeder = oz.createStoreFeeder({
    dataDir: '/data',
    exists: file => !file.endsWith('zone_index.db'),
    openDatabase: file => {
      opened.push(path.basename(file));
      return {
        prepare(sql) {
          if (/FROM (research_prefix_hits|sibling_tld_status)/.test(sql)) throw new Error('no such table: x');
          if (/FROM site_evidence/.test(sql)) throw new Error('database disk image is malformed');
          return { iterate: () => (/cctld_taken_idx/.test(sql) ? [{ name: 'a.si' }, { name: 'b.si' }] : []) };
        },
        close() {},
      };
    },
  });
  const r = await feeder.collect({ tld: 'si' });
  assert.deepEqual([...r.names].sort(), ['a.si', 'b.si']);
  assert.deepEqual(opened.sort(), ['domains.db', 'sale_watch.db']);
  assert.equal(r.detail.research_prefix_hits, 'absent');
  assert.equal(r.detail.sibling_tld_status, 'absent');
  assert.deepEqual(r.absent.sort(), ['research_prefix_hits', 'sibling_tld_status']);
  assert.match(r.error, /site_evidence: database disk image is malformed/, 'a real read failure is still an error');

  const roster = oz.emptyRoster('si');
  const quiet = oz.createStoreFeeder({ dataDir: '/data', exists: () => false, openDatabase: () => { throw new Error('must not open'); } });
  const report = await oz.runFeeders(roster, [quiet], { day: '2026-10-15', now: () => new Date('2026-10-15T00:00:00Z'), log: { error: () => assert.fail('absent must not log an error') } });
  assert.equal(report.stores.status, 'ok');
  assert.equal(report.stores.error, null);
  assert.ok(report.stores.absent.includes('research_prefix_hits'));
});

test('crt.sh: a failing window is retried once after a delay, then split into smaller windows; logs carry the HTTP status', async () => {
  const calls = [], sleeps = [], logs = [];
  const feeder = oz.createCtFeeder({
    config: { ctWindowDays: 8, ctMinWindowDays: 2, ctMaxWindows: 2, ctBackfillDays: 0, ctPaceMs: 5, ctRetryDelayMs: 777 },
    sleep: async ms => { sleeps.push(ms); },
    log: { error: m => logs.push(m) },
    fetchWindow: async (tld, from, to) => {
      calls.push(`${from}..${to}`);
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > 2) throw Object.assign(new Error('HTTP 404 body "Not Found"'), { status: 404 });
      return ['small.si'];
    },
  });
  const r = await feeder.collect({ tld: 'si', cursor: null, now: () => new Date('2026-10-14T12:00:00Z') });
  assert.deepEqual(calls, ['2026-10-06..2026-10-14', '2026-10-06..2026-10-14', '2026-10-10..2026-10-14', '2026-10-10..2026-10-14', '2026-10-12..2026-10-14']);
  assert.equal(sleeps.filter(ms => ms === 777).length, 2, 'one delayed retry per failed window');
  assert.equal(r.error, null);
  assert.deepEqual(r.names, ['small.si']);
  assert.equal(r.cursor.newest, '2026-10-14');
  assert.equal(r.detail.windowDays, 2);
  assert.equal(r.detail.windows.filter(w => w.failed).length, 2);
  assert.ok(logs.some(m => /attempt 1\/2 failed: HTTP 404 body "Not Found"/.test(m)), logs.join('\n'));
});

test('crt.sh: a window failing at the minimum size is an error, keeps the cursor, and is retried on a later day', async () => {
  let failing = true;
  const calls = [];
  const feeder = oz.createCtFeeder({
    config: { ctWindowDays: 2, ctMinWindowDays: 2, ctMaxWindows: 4, ctBackfillDays: 30, ctPaceMs: 0, ctRetryDelayMs: 0 },
    sleep: async () => {}, log: { error() {} },
    fetchWindow: async (tld, from, to) => { calls.push(`${from}..${to}`); if (failing) throw Object.assign(new Error('Request failed with status code 404'), { status: 404 }); return []; },
  });
  const cursor = { newest: '2026-10-10', oldest: '2026-10-03' };
  const r = await feeder.collect({ tld: 'si', cursor, now: () => new Date('2026-10-14T12:00:00Z') });
  assert.equal(r.error, 'crt.sh 2026-10-10..2026-10-12: HTTP 404: Request failed with status code 404');
  assert.equal(r.cursor.newest, '2026-10-10');
  assert.equal(r.cursor.oldest, '2026-10-03');
  failing = false;
  calls.length = 0;
  const next = await feeder.collect({ tld: 'si', cursor: r.cursor, now: () => new Date('2026-10-15T12:00:00Z') });
  assert.equal(calls[0], '2026-10-10..2026-10-12', 'the failed window is retried, never skipped');
  assert.equal(next.error, null);
});

test('crt.sh scraper failures carry HTTP status and a short body snippet', () => {
  const { describeCrtshFailure, bodySnippet } = require('../scrapers/crtsh');
  const e = describeCrtshFailure(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: '<html><body><h1>Not   Found</h1></body></html>' } }));
  assert.equal(e.status, 404);
  assert.equal(e.message, 'HTTP 404 body "Not Found"');
  assert.equal(bodySnippet('x'.repeat(500)).length, 200);
  assert.match(describeCrtshFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).message, /^ECONNRESET: socket hang up/);
});

test('registrableName keeps only the label directly under the TLD', () => {
  const r = v => oz.registrableName(v, 'si');
  assert.equal(r('https://www.Example.SI/path?q=1'), 'example.si');
  assert.equal(r('http://a.b.shop.si:8080/x'), 'shop.si');
  assert.equal(r('HTTP://user:pw@Foo.Si:443'), 'foo.si');
  assert.equal(r('Shop.SI:80'), 'shop.si');
  assert.equal(r('example.si./'), 'example.si');
  assert.equal(r('https://www.xn--80ak6aa92e.si/'), 'xn--80ak6aa92e.si', 'IDN punycode passes through');
  assert.match(r('https://www.žaba.si/'), /^xn--[a-z0-9-]+\.si$/);
  for (const bad of ['https://example.com/a.si', 'https://si/', 'https://bad_label.si/', 'https://[::1]:80/', '', null, 'https://-x.si/']) assert.equal(r(bad), null, String(bad));
});

function fakeCdx({ crawls, pages, fail = () => null }) {
  const calls = [];
  const reply = (status, text, headers = {}) => ({ ok: status >= 200 && status < 300, status, text: async () => text, headers: { get: k => headers[k.toLowerCase()] ?? null } });
  const fetchImpl = async (url) => {
    calls.push(url);
    const f = fail(url);
    if (f) return reply(f.status, f.body || '', f.headers || {});
    if (url.endsWith('/collinfo.json')) return reply(200, JSON.stringify(crawls.map(id => ({ id, name: id }))));
    const u = new URL(url);
    assert.equal(u.searchParams.get('url'), '*.si');
    assert.equal(u.searchParams.get('output'), 'json');
    assert.equal(u.searchParams.get('fl'), 'url');
    const id = u.pathname.slice(1).replace(/-index$/, '');
    if (u.searchParams.get('showNumPages') === 'true') return reply(200, JSON.stringify({ pages: pages[id].length, pageSize: 5, blocks: 1 }));
    return reply(200, pages[id][Number(u.searchParams.get('page'))].map(x => JSON.stringify({ url: x })).join('\n') + '\n');
  };
  return { fetchImpl, calls };
}

const ccConfig = extra => ({ ccIndexBase: 'https://cc.test', ccCrawls: 2, ccPaceMs: 1000, ccRetries: 2, ccBackoffMs: 10, ccTimeoutMs: 1000, ccBudgetMs: Infinity, ccCheckpointPages: 1, ...extra });
const CC_PAGES = {
  'CC-MAIN-2026-40': [['https://www.alpha.si/', 'http://shop.alpha.si:8080/x', 'https://BETA.SI/'], ['https://x.y.gamma.si/a', 'https://example.com/z']],
  'CC-MAIN-2026-35': [['https://delta.si/', 'https://www.xn--80ak6aa92e.si/']],
  'CC-MAIN-2026-30': [['https://old.si/']],
};

test('Common Crawl: reads every page of the newest N crawls politely, retries 503/429 with backoff, and reduces URLs', async () => {
  const sleeps = [];
  let failedOnce = false, limited = false;
  const cdx = fakeCdx({
    crawls: ['CC-MAIN-2026-30', 'CC-MAIN-2026-40', 'CC-MAIN-2026-35'], pages: CC_PAGES,
    fail: url => {
      if (!failedOnce && url.includes('CC-MAIN-2026-40-index') && url.endsWith('&page=1')) { failedOnce = true; return { status: 503, body: '<h1>Slow down</h1>' }; }
      if (!limited && url.includes('CC-MAIN-2026-35-index') && url.endsWith('&page=0')) { limited = true; return { status: 429, headers: { 'retry-after': '3' } }; }
      return null;
    },
  });
  const checkpoints = [];
  const feeder = oz.createCommonCrawlFeeder({ config: ccConfig(), fetchImpl: cdx.fetchImpl, sleep: async ms => { sleeps.push(ms); } });
  const r = await feeder.collect({ tld: 'si', cursor: null, log: { error() {} }, checkpoint: async c => { checkpoints.push(JSON.parse(JSON.stringify(c))); } });
  assert.equal(r.error, null);
  assert.equal(r.status, 'ok');
  const names = new Set([...checkpoints.flatMap(c => c.names), ...r.names]);
  assert.deepEqual([...names].sort(), ['alpha.si', 'beta.si', 'delta.si', 'gamma.si', 'xn--80ak6aa92e.si']);
  assert.equal(cdx.calls.some(u => u.includes('CC-MAIN-2026-30')), false, 'only the newest 2 crawls are read');
  assert.equal(cdx.calls.filter(u => u.includes('showNumPages=true')).length, 2);
  assert.equal(r.detail.pagesRead, 3);
  assert.equal(r.detail.retries, 2);
  assert.ok(sleeps.includes(10), 'exponential backoff after 503');
  assert.ok(sleeps.includes(3000), 'Retry-After honoured on 429');
  assert.equal(sleeps.filter(ms => ms === 1000).length, cdx.calls.length - 1 - 2, 'about one request per second (paced except retries)');
  assert.deepEqual(Object.keys(r.cursor.crawls).sort(), ['CC-MAIN-2026-35', 'CC-MAIN-2026-40']);
  assert.ok(Object.values(r.cursor.crawls).every(c => c.done && c.next === c.pages));
  assert.equal(checkpoints.length, 3, 'cursor checkpointed every ccCheckpointPages pages');

  // Finished crawls are done: a later run only lists collections; a new crawl is read from page 0.
  const later = fakeCdx({ crawls: ['CC-MAIN-2026-40', 'CC-MAIN-2026-35', 'CC-MAIN-2026-44'], pages: { ...CC_PAGES, 'CC-MAIN-2026-44': [['https://epsilon.si/']] } });
  const again = await oz.createCommonCrawlFeeder({ config: ccConfig(), fetchImpl: later.fetchImpl, sleep: async () => {} }).collect({ tld: 'si', cursor: r.cursor, log: { error() {} } });
  assert.deepEqual(later.calls.map(u => u.replace('https://cc.test', '')), [
    '/collinfo.json',
    '/CC-MAIN-2026-44-index?url=*.si&output=json&fl=url&showNumPages=true',
    '/CC-MAIN-2026-44-index?url=*.si&output=json&fl=url&page=0',
  ]);
  assert.deepEqual(again.names, ['epsilon.si']);
  assert.equal(again.cursor.crawls['CC-MAIN-2026-40'].done, true);
});

test('Common Crawl: a failure is recorded, earlier pages are kept, and a restart resumes at the stored page cursor', async () => {
  let broken = true;
  const cdx = fakeCdx({
    crawls: ['CC-MAIN-2026-40', 'CC-MAIN-2026-35'], pages: CC_PAGES,
    fail: url => (broken && url.includes('CC-MAIN-2026-40-index') && url.endsWith('&page=1') ? { status: 500, body: 'Internal Server Error' } : null),
  });
  const feeder = oz.createCommonCrawlFeeder({ config: ccConfig({ ccRetries: 1 }), fetchImpl: cdx.fetchImpl, sleep: async () => {} });
  const roster = oz.emptyRoster('si');
  let saves = 0;
  const ctx = { day: '2026-10-15', now: () => new Date('2026-10-15T08:00:00Z'), log: { error() {} }, save: async () => { saves += 1; } };
  const report = await oz.runFeeders(roster, [feeder], ctx);
  assert.equal(report.commoncrawl.status, 'error');
  assert.match(report.commoncrawl.error, /CC-MAIN-2026-40 page 1\/2: HTTP 500 "Internal Server Error"/);
  assert.deepEqual([...roster.names.keys()].sort(), ['alpha.si', 'beta.si'], 'names from finished pages were merged');
  assert.equal(report.commoncrawl.added, 2);
  assert.ok(saves >= 1, 'the roster (with its cursor) was persisted mid-feed');
  assert.deepEqual({ pages: roster.cursors.commoncrawl.crawls['CC-MAIN-2026-40'].pages, next: roster.cursors.commoncrawl.crawls['CC-MAIN-2026-40'].next, done: roster.cursors.commoncrawl.crawls['CC-MAIN-2026-40'].done }, { pages: 2, next: 1, done: false });

  // The cursor survives the roster round trip; the restart continues at page 1 without recounting pages.
  const store = memoryStore();
  await oz.saveRoster(store, 'p', roster);
  const reloaded = await oz.loadRoster(store, 'p', 'si');
  broken = false;
  cdx.calls.length = 0;
  const resumed = await oz.runFeeders(reloaded, [feeder], ctx);
  assert.equal(resumed.commoncrawl.error, null);
  const pageCalls = cdx.calls.filter(u => !u.endsWith('collinfo.json')).map(u => u.replace(/^.*\/(CC-MAIN-[0-9-]+)-index.*?(page=\d+|showNumPages=true)$/, '$1 $2'));
  assert.deepEqual(pageCalls, ['CC-MAIN-2026-40 page=1', 'CC-MAIN-2026-35 showNumPages=true', 'CC-MAIN-2026-35 page=0']);
  assert.deepEqual([...reloaded.names.keys()].sort(), ['alpha.si', 'beta.si', 'delta.si', 'gamma.si', 'xn--80ak6aa92e.si']);
});

test('Common Crawl: the per-run time budget stops cleanly and leaves the remainder for the next run', async () => {
  let clock = 0;
  const cdx = fakeCdx({ crawls: ['CC-MAIN-2026-40'], pages: CC_PAGES });
  const feeder = oz.createCommonCrawlFeeder({ config: ccConfig({ ccCrawls: 1, ccBudgetMs: 2500 }), fetchImpl: cdx.fetchImpl, sleep: async ms => { clock += ms; }, clock: () => clock });
  const r = await feeder.collect({ tld: 'si', cursor: null, log: { error() {} } });
  assert.equal(r.status, 'partial');
  assert.equal(r.error, null);
  assert.equal(r.detail.budgetExhausted, true);
  assert.equal(r.cursor.crawls['CC-MAIN-2026-40'].done, false);
  assert.ok(r.cursor.crawls['CC-MAIN-2026-40'].next < 2);
});

test('Common Crawl collinfo failure is a feeder error that never blocks the other feeders', async () => {
  const feeder = oz.createCommonCrawlFeeder({ config: ccConfig({ ccRetries: 0 }), fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, sleep: async () => {} });
  const roster = oz.emptyRoster('si');
  const report = await oz.runFeeders(roster, [feeder, { name: 'other', collect: async () => ({ names: ['ok.si'] }) }], { day: '2026-10-15', now: () => new Date(), log: { error() {} } });
  assert.match(report.commoncrawl.error, /commoncrawl collinfo: network: getaddrinfo ENOTFOUND/);
  assert.equal(report.other.added, 1);
});

// ── Capacity and gates at 50k–150k names ──────────────────────────────────
test('default qps finishes a 150k roster inside the run budget, beside the Common Crawl budget', () => {
  const config = oz.observedConfig({});
  assert.equal(config.ccCrawls, 3);
  assert.equal(config.ccPaceMs, 1000);
  const c = oz.capacityEstimate(150000, config);
  assert.equal(c.observeMinutes, 62.5);
  assert.equal(c.fitsBudget, true);
  assert.ok(c.worstCaseMinutes < c.budgetMinutes / 2, JSON.stringify(c));
  assert.equal(oz.capacityEstimate(150000, { ...config, qps: 5 }).fitsBudget, false, 'a too-slow qps is flagged');
});

test('gates stay meaningful at size: new-name batches cannot dilute established unknowns; mass delegated loss fails', () => {
  const est = Array.from({ length: 100 }, (_, i) => `e${i}.si`);
  const fresh = Array.from({ length: 10000 }, (_, i) => `n${i}.si`);
  const previous = new Map(est.map(n => [n, ['ns1.t']]));
  const isNew = n => n.startsWith('n');
  const names = [...est, ...fresh];
  const results = names.map((n, i) => (i < 10 ? { status: 'unknown', reason: 'timeout' } : { status: 'taken', nameservers: ['ns1.t'] }));
  const g = oz.gateObservation({ names, results, previous, isNew, config: { maxUnknownRatio: 0.05, maxDelegatedLossRatio: 0.2, minGateSample: 50 } });
  assert.ok(g.unknownRatio < 0.05);
  assert.equal(g.ok, false);
  assert.match(g.error, /established names 10\.00%/);
  const lossResults = names.map((n, i) => (i < 30 ? { status: 'not_taken' } : { status: 'taken', nameservers: ['ns1.t'] }));
  const loss = oz.gateObservation({ names, results: lossResults, previous, isNew, config: { maxUnknownRatio: 0.05, maxDelegatedLossRatio: 0.2, minGateSample: 50 } });
  assert.match(loss.error, /Delegated-loss share 30\.00%/);
  const ok = oz.gateObservation({ names, results: names.map(() => ({ status: 'taken', nameservers: ['ns1.t'] })), previous, isNew, config: {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.newNames, 10000);
});

test('names added mid-roster are queried the same day and their first observation is a baseline, never movement', async t => {
  const f = observedFixture(t, { roster: ['alpha.si', 'beta.si'] });
  f.zone['alpha.si'] = ['ns1.dan.com', 'ns2.dan.com'];
  f.zone['beta.si'] = ['ns1.dan.com', 'ns2.dan.com'];
  assert.equal((await f.run('2026-10-01')).complete, true);
  for (const n of ['newsale.si', 'newlive.si', 'newnx.si']) f.names.add(n);
  f.zone['newsale.si'] = ['ns1.dan.com', 'ns2.dan.com'];
  f.zone['newlive.si'] = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
  f.zone['alpha.si'] = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
  const before = f.dns.queries.length;
  const r = await f.run('2026-10-02');
  assert.equal(r.complete, true, r.error);
  const asked = new Set(f.dns.queries.slice(before).map(q => q.name));
  for (const n of ['newsale.si', 'newlive.si', 'newnx.si']) assert.ok(asked.has(n), `${n} queried the day it joined`);
  assert.equal(r.stats.rosterSize, 5);
  const dir2 = path.join(f.work, '2026-10-02/ns-observed/si');
  assert.equal(fs.readFileSync(path.join(dir2, 'adds.tsv'), 'utf8'), '', 'new roster names are not registrations');
  assert.deepEqual([...new Set(readRows(path.join(dir2, 'movement.jsonl')).map(x => x.domain))], ['alpha.si']);
  assert.equal((await latestOf(f.store)).movement.counts.added, 0);
  const health = JSON.parse(fs.readFileSync(oz.healthFile(f.dataDir, 'si'), 'utf8'));
  assert.equal(health.baselined, 2);
  assert.equal(health.gate.newNames, 3);

  // Day 3: the baselined name moves for real, and an observed-NXDOMAIN name gets delegated.
  f.zone['newsale.si'] = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
  f.zone['newnx.si'] = ['ns1.dan.com'];
  const r3 = await f.run('2026-10-03');
  assert.equal(r3.complete, true, r3.error);
  const dir3 = path.join(f.work, '2026-10-03/ns-observed/si');
  const rows3 = readRows(path.join(dir3, 'movement.jsonl'));
  assert.ok(rows3.some(x => x.domain === 'newsale.si' && x.selection === 'departures'), JSON.stringify(rows3));
  assert.equal(rows3.some(x => x.domain === 'newlive.si'), false);
  assert.match(fs.readFileSync(path.join(dir3, 'adds.tsv'), 'utf8'), /^newnx\tsi\t2026-10-02$/m);
});

// ── Runner end to end through captureZone/diff/tape ────────────────────────
async function twoDaySale(t) {
  const f = observedFixture(t, { roster: ['alpha.si', 'beta.si', 'gamma.si'] });
  f.zone['alpha.si'] = ['ns1.dan.com', 'ns2.dan.com'];
  f.zone['beta.si'] = ['ns1.example-dns.test'];
  const first = await f.run('2026-10-01');
  f.zone['alpha.si'] = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
  const second = await f.run('2026-10-02');
  return { f, first, second };
}

test('fake DNS: day one is a baseline, day two records the seller-to-hosting move in the shared movement tape', async t => {
  const { f, first, second } = await twoDaySale(t);
  assert.equal(first.complete, true, first.error);
  assert.equal(first.baseline, true);
  assert.equal(first.stats.delegated, 2);
  assert.equal(first.stats.nxdomain, 1);
  assert.equal(fs.readFileSync(path.join(f.work, '2026-10-01/ns-observed/si/movement.jsonl'), 'utf8'), '');
  assert.equal(second.complete, true, second.error);
  assert.equal(second.baseline, false);
  assert.equal(second.movement.departures, 1);
  const rows = readRows(path.join(f.work, '2026-10-02/ns-observed/si/movement.jsonl'));
  const alpha = rows.find(r => r.domain === 'alpha.si' && r.selection === 'departures');
  assert.ok(alpha, JSON.stringify(rows));
  assert.deepEqual(alpha.prev_ns, ['ns1.dan.com', 'ns2.dan.com']);
  assert.ok(['seller', 'parking'].includes(alpha.prev_class));
  const lane = require('../server/universe-lane').createUniverseLane({ directory: f.work });
  const q = await lane.queryNsMovement({ day: '2026-10-02', zone: 'si', selection: 'departures' });
  assert.deepEqual(q.items.map(r => r.domain), ['alpha.si']);
  const health = await oz.observedHealth({ dataDir: f.dataDir, env: f.env, now: () => new Date('2026-10-02T12:00:00Z') });
  assert.equal(health.zones.si.status, 'ok');
  assert.equal(health.zones.si.lastGoodDay, '2026-10-02');
  assert.equal(health.zones.si.rosterSize, 3);
  assert.deepEqual(health.alerts, []);
});

test('fake DNS: the observed .si sale lands in Sale Watch ingest', async t => {
  const { f } = await twoDaySale(t);
  const Database = require('better-sqlite3');
  const recon = require('../server/sale-watch-reconstruction');
  const db = new Database(':memory:');
  recon.ensureReconstructionSchema(db);
  await recon.ingestMovementCandidates(db, { directory: f.work });
  const row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('alpha.si');
  assert.ok(row, 'alpha.si queued');
  assert.equal(row.exit_observed_day, '2026-10-02');
  assert.equal(row.last_stream, 'zone-seller-departure');
  assert.equal(JSON.parse(row.evidence_json).discovery.movement.prevDay, '2026-10-01');
});

test('unknown answers carry the previous NS set forward and fabricate no movement', async t => {
  const f = observedFixture(t, { roster: ['alpha.si', 'beta.si'], config: { maxUnknownRatio: 0.5 } });
  f.zone['alpha.si'] = ['ns1.dan.com'];
  f.zone['beta.si'] = ['ns1.dan.com'];
  assert.equal((await f.run('2026-10-01')).complete, true);
  f.zone['beta.si'] = 'servfail';
  const r = await f.run('2026-10-02');
  assert.equal(r.complete, true, r.error);
  assert.equal(r.stats.unknown, 1);
  assert.equal(r.stats.carriedForward, 1);
  const latest = await latestOf(f.store);
  assert.equal(latest.movement.counts.dropped, 0);
  assert.equal(latest.movement.counts.changed, 0);
  assert.equal(fs.readFileSync(path.join(f.work, '2026-10-02/ns-observed/si/movement.jsonl'), 'utf8'), '');
});

test('a day whose unknown share exceeds the threshold fails and publishes nothing', async t => {
  const f = observedFixture(t, { roster: ['alpha.si', 'beta.si', 'gamma.si'] });
  for (const n of f.names) f.zone[n] = ['ns1.dan.com'];
  assert.equal((await f.run('2026-10-01')).complete, true);
  f.zone['alpha.si'] = 'timeout';
  const r = await f.run('2026-10-02');
  assert.equal(r.complete, false);
  assert.match(r.error, /Unknown share/);
  assert.equal((await latestOf(f.store)).day, '2026-10-01');
  assert.equal(fs.existsSync(path.join(f.work, '2026-10-02/ns-observed')), false);
  const health = await oz.observedHealth({ dataDir: f.dataDir, env: f.env, now: () => new Date('2026-10-02T12:00:00Z') });
  assert.equal(health.zones.si.status, 'failed');
  assert.equal(health.zones.si.lastGoodDay, '2026-10-01');
  assert.equal(health.zones.si.unknown, 1);
  assert.match(health.alerts[0], /Observed zone \.si.*Unknown share/);
});

// ── Isolation from the CZDS lane ───────────────────────────────────────────
function czdsPuller(f, day, { fail = false } = {}) {
  const { createUniversePuller } = require('../server/universe-puller');
  return createUniversePuller({
    dataDir: f.dataDir, universeDir: f.work, objectStore: f.store,
    env: { CZDS_USER: 'u', CZDS_PASS: 'p', DOMAINSCOUT_UNIVERSE_PULL_CONCURRENCY: '1', DOMAINSCOUT_UNIVERSE_SCRATCH_DIR: f.env.DOMAINSCOUT_UNIVERSE_SCRATCH_DIR },
    now: () => new Date(day + 'T12:00:00Z'), log: { log() {}, error() {} },
    fetchImpl: async (url) => {
      if (fail) return { ok: false, status: 503 };
      if (url.includes('authenticate')) return { ok: true, json: async () => ({ accessToken: 'fixture' }) };
      if (url.endsWith('/links')) return { ok: true, json: async () => ['https://czds-api.icann.org/czds/downloads/com.zone'] };
      return { ok: true, body: Readable.from(zlib.gzipSync('alpha.com. 3600 IN NS ns1.dan.com.\n')) };
    },
    summary: {
      buildUniverseSummaryTape: async ({ outDir }) => {
        await fsp.mkdir(outDir, { recursive: true });
        const tapePath = path.join(outDir, 'summary.gz');
        await fsp.writeFile(tapePath, zlib.gzipSync('fixture'));
        return { tapePath, zones: 1 };
      },
      importUniverseSummaryTape: async () => {},
    },
  });
}

test('an observed-zone failure leaves the CZDS day complete; health shows both', async t => {
  const f = observedFixture(t, { roster: ['alpha.si'] });
  f.zone['alpha.si'] = 'timeout';
  const day = '2026-10-01';
  assert.equal((await f.run(day)).complete, false);
  assert.equal((await czdsPuller(f, day).runDay()).complete, true);
  const latest = JSON.parse((await f.store.get('domainscout/corpora/zone-universe/v2/latest.json')).toString());
  assert.equal(latest.day, day);
  assert.deepEqual(latest.inventory, ['com']);
  const { createUniverseSupervisor } = require('../server/universe-pull-supervisor');
  const h = await createUniverseSupervisor({ dataDir: f.dataDir, universeDir: f.work, env: f.env, now: () => new Date(day + 'T12:00:00Z') }).health();
  assert.equal(h.status, 'ok');
  assert.equal(h.lastCompleteDay, day);
  assert.equal(h.observed.zones.si.status, 'failed');
  assert.ok(h.alerts.some(a => /Observed zone \.si/.test(a)));
});

test('a CZDS failure never blocks the observed capture', async t => {
  const f = observedFixture(t, { roster: ['alpha.si'] });
  f.zone['alpha.si'] = ['ns1.dan.com'];
  const day = '2026-10-01';
  await assert.rejects(czdsPuller(f, day, { fail: true }).runDay());
  const r = await f.run(day);
  assert.equal(r.complete, true, r.error);
  const { createUniverseSupervisor } = require('../server/universe-pull-supervisor');
  const h = await createUniverseSupervisor({ dataDir: f.dataDir, universeDir: f.work, env: f.env, now: () => new Date(day + 'T12:00:00Z') }).health();
  assert.equal(h.status, 'failed');
  assert.equal(h.observed.zones.si.status, 'ok');
});

// ── Manual trigger route auth ──────────────────────────────────────────────
function fakeApp() {
  const routes = {};
  return { routes, post: (p, h) => { routes['POST ' + p] = h; }, get: (p, h) => { routes['GET ' + p] = h; } };
}
function fakeReq(query = {}, headers = {}) {
  return { query, headers, get(name) { return this.headers[name.toLowerCase()]; } };
}
function fakeRes() {
  return { statusCode: 200, body: null, set() { return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('observed run/status routes use the universe import token and reject everything else', async () => {
  const calls = [];
  const supervisor = {
    runZone: async (args) => { calls.push(args); return args.tld === 'busy' ? { skipped: 'running', tld: 'busy' } : { started: true, tld: args.tld, day: '2026-10-01', pid: 1 }; },
    status: async (tld) => ({ tld, running: false, health: null }),
  };
  const unconfigured = fakeApp();
  oz.registerObservedZoneRoutes(unconfigured, supervisor, { env: {} });
  let res = fakeRes();
  await unconfigured.routes['POST /api/universe/observed/run'](fakeReq({ tld: 'si' }), res);
  assert.equal(res.statusCode, 503);

  const app = fakeApp();
  oz.registerObservedZoneRoutes(app, supervisor, { env: { DOMAINSCOUT_AGENT_TOKEN: 'secret' } });
  res = fakeRes();
  await app.routes['POST /api/universe/observed/run'](fakeReq({ tld: 'si' }), res);
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await app.routes['POST /api/universe/observed/run'](fakeReq({ tld: 'si' }, { 'x-domainscout-token': 'wrong' }), res);
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await app.routes['GET /api/universe/observed/status'](fakeReq({ tld: 'si' }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);

  res = fakeRes();
  await app.routes['POST /api/universe/observed/run'](fakeReq({ tld: 'si', force: '1' }, { 'x-domainscout-token': 'secret' }), res);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(calls[0], { tld: 'si', force: true });
  res = fakeRes();
  await app.routes['POST /api/universe/observed/run'](fakeReq({ tld: 'busy', token: 'secret' }), res);
  assert.equal(res.statusCode, 409);
  res = fakeRes();
  await app.routes['GET /api/universe/observed/status'](fakeReq({ tld: 'si', token: 'secret' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tld, 'si');
});

test('the real supervisor rejects a TLD that is not a configured observed zone', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-sup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { DOMAINSCOUT_OBSERVED_ZONES: 'si', DOMAINSCOUT_AGENT_TOKEN: 'secret' };
  const supervisor = oz.createObservedZoneSupervisor({ dataDir: dir, universeDir: dir, env, spawnImpl: () => { throw new Error('must not spawn'); } });
  const app = fakeApp();
  oz.registerObservedZoneRoutes(app, supervisor, { env });
  const res = fakeRes();
  await app.routes['POST /api/universe/observed/run'](fakeReq({ tld: 'com' }, { 'x-domainscout-token': 'secret' }), res);
  assert.equal(res.statusCode, 400);
  const status = fakeRes();
  await app.routes['GET /api/universe/observed/status'](fakeReq({ tld: 'si' }, { 'x-domainscout-token': 'secret' }), status);
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.health, null);
});

// ── RDAP per-registry-host pacing ──────────────────────────────────────────
const discovery = require('../server/sale-watch-discovery');

test('RDAP host pacer never exceeds 6 reads per 20 s and leaves unpaced hosts alone', async () => {
  let clock = 0;
  const pacer = discovery.createRdapHostPacer({ now: () => clock, sleep: async ms => { clock += ms; } });
  const policy = discovery.rdapPaceFor('example.si', {});
  assert.deepEqual(policy, { reads: 6, windowMs: 20000 });
  assert.equal(discovery.rdapPaceFor('example.com', {}), null);
  const stamps = [];
  await Promise.all(Array.from({ length: 20 }, () => pacer('https://rdap.registry.test', policy).then(() => stamps.push(clock))));
  stamps.sort((a, b) => a - b);
  for (const s of stamps) assert.ok(stamps.filter(x => x >= s && x < s + 20000).length <= 6);
  assert.equal(stamps[6], 20000);
  const before = clock;
  await pacer('https://rdap.other.test', null);
  assert.equal(clock, before);
});

test('inspectRdap resolves the registry origin from the IANA bootstrap and paces only paced TLDs', async () => {
  const paced = [];
  const pacer = async (origin, policy) => { paced.push({ origin, policy }); };
  const fetchImpl = async (url) => {
    const body = url === 'https://data.iana.org/rdap/dns.json'
      ? { services: [[['si'], ['https://rdap.si-registry.test/']], [['com'], ['https://rdap.com-registry.test/']]] }
      : { objectClassName: 'domain', ldhName: url.split('/').pop(), events: [], status: ['active'] };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const si = await discovery.inspectRdap('alpha.si', fetchImpl, { pacer, env: {} });
  const com = await discovery.inspectRdap('alpha.com', fetchImpl, { pacer, env: {} });
  assert.equal(si.sourceUrl, 'https://rdap.si-registry.test/domain/alpha.si');
  assert.equal(com.sourceUrl, 'https://rdap.com-registry.test/domain/alpha.com');
  assert.deepEqual(paced, [
    { origin: 'https://rdap.si-registry.test', policy: { reads: 6, windowMs: 20000 } },
    { origin: 'https://rdap.com-registry.test', policy: null },
  ]);
});

test('mapLimitPaced serializes and paces .si rows while other registries keep full concurrency', async () => {
  const keys = [];
  const pacer = async (key, policy) => { keys.push([key, policy]); };
  const rows = [...Array.from({ length: 6 }, (_, i) => ({ domain: `s${i}.si` })), ...Array.from({ length: 20 }, (_, i) => ({ domain: `c${i}.com` }))];
  const inflight = { si: 0, com: 0 }, peak = { si: 0, com: 0 };
  const out = await discovery.mapLimitPaced(rows, 8, async (row) => {
    const tld = row.domain.split('.').pop();
    inflight[tld] += 1; peak[tld] = Math.max(peak[tld], inflight[tld]);
    await new Promise(resolve => setImmediate(resolve));
    inflight[tld] -= 1;
    return row.domain;
  }, { env: {}, pacer });
  assert.deepEqual(out, rows.map(r => r.domain));
  assert.equal(peak.si, 1);
  assert.ok(peak.com > 1);
  assert.equal(keys.length, 6);
  assert.ok(keys.every(([key, policy]) => key === 'tld:si' && policy.reads === 6));
});

// ── Sale Watch fit ─────────────────────────────────────────────────────────
test('.si is an alpha TLD and host-based seller evidence applies to .si delegations', () => {
  assert.ok(require('../server/domain-quality').ALPHA_TLDS.includes('si'));
  const ev = require('../server/sale-watch-dns').delegationEvidence({ sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['ada.ns.cloudflare.com'] });
  assert.equal(ev.sellerOrigin, true);
  assert.equal(ev.parking, false);
  assert.equal(oz.observedZones({}).join(','), 'si');
  assert.deepEqual(oz.observedZones({ DOMAINSCOUT_OBSERVED_ZONES: ' .SI , cz,,bad zone ' }), ['si', 'cz']);
});
