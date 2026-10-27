'use strict';

// Near-live CT launch detector: recorded CT fixtures (tests/fixtures/ct, made by
// scripts/make-ct-fixtures.js from openssl-issued DER certificates), the launch
// rule, dedupe, resume from persisted positions and coexistence with the daily
// live-sites stage writing the same day.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ctLog = require('../server/ct-log');
const ct = require('../server/ct-launches');
const ls = require('../server/live-sites');
const { createLiveSitesFeed } = require('../server/live-sites-feed');

const FIX = path.join(__dirname, 'fixtures', 'ct');
const NOW = Date.parse('2026-10-27T10:00:00Z');
const DAY = '2026-10-27';
const quiet = { log() {}, warn() {}, error() {} };

function html(title) {
  return `<html><head><title>${title}</title></head><body>${'We bake fresh sourdough, pastries and cakes every morning for the neighbourhood. '.repeat(10)}</body></html>`;
}
const siteFetch = async url => {
  const host = new URL(url).hostname;
  return new Response(html(`${host.split('.')[0]} Bakery and Cafe`), { status: 200, headers: { 'content-type': 'text/html' } });
};

async function tmp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-ct-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const universeDir = path.join(root, 'universe');
  await fs.mkdir(universeDir, { recursive: true });
  return { dataDir: root, universeDir };
}

async function writeTapes(universeDir) {
  // Recent add (inside the 14-day window) and a went-live movement row.
  const recent = path.join(universeDir, '2026-10-25', 'tape');
  await fs.mkdir(recent, { recursive: true });
  await fs.writeFile(path.join(recent, 'adds.tsv'), 'fresh-bakery\tcom\t2026-10-24\nother\tcom\t2026-10-24\n');
  const ns = path.join(universeDir, '2026-10-26', 'ns');
  await fs.mkdir(ns, { recursive: true });
  await fs.writeFile(path.join(ns, 'movement.jsonl'), JSON.stringify({ domain: 'golive.net', selection: 'went-live' }) + '\n');
  await fs.writeFile(path.join(ns, 'summary.json'), '{}');
  // Old add (outside the window): a renewal certificate for it is not a launch.
  const old = path.join(universeDir, '2026-09-01', 'tape');
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, 'adds.tsv'), 'oldrenewal\tcom\t2026-08-31\n');
}

// ── Parsing ──────────────────────────────────────────────────────────────

test('RFC 6962 get-entries: x509 and precert entries parse to DNS SANs and registrable domains', () => {
  const body = JSON.parse(fss.readFileSync(path.join(FIX, 'rfc6962-get-entries.json'), 'utf8'));
  const [x509, pre] = body.entries.map(ctLog.parseRfc6962Entry);
  assert.equal(x509.entryType, 0);
  assert.equal(pre.entryType, 1);
  assert.equal(x509.timestamp, 1793095200000);
  assert.deepEqual(ctLog.entryDnsNames(x509), ['www.fresh-bakery.com', 'fresh-bakery.com', '*.shop.fresh-bakery.com', 'api.newthing.ai', 'acme.co.uk']);
  assert.deepEqual(ctLog.entryDomains(x509).map(d => d.domain), ['fresh-bakery.com', 'newthing.ai', 'acme.co.uk']);
  assert.deepEqual(ctLog.entryDomains(pre).map(d => d.domain), ['oldrenewal.com', 'brandnew.io']);
  // TBS-only fallback (no extra_data precert) still yields SANs via the DER walker.
  assert.deepEqual(ctLog.entryDnsNames({ entryType: 1, tbs: pre.tbs, precert: null }), ['launch.oldrenewal.com', 'brandnew.io']);
  assert.equal(JSON.parse(fss.readFileSync(path.join(FIX, 'rfc6962-get-sth.json'), 'utf8')).tree_size, 1002);
});

test('static-ct-api: checkpoint, tile paths and a partial data tile', async () => {
  const cp = ctLog.parseCheckpoint(fss.readFileSync(path.join(FIX, 'static-checkpoint.txt'), 'utf8'));
  assert.equal(cp.treeSize, 259);
  assert.equal(ctLog.tilePath(1234067), 'x001/x234/067');
  assert.equal(ctLog.tilePath(1), '001');
  const tile = fss.readFileSync(path.join(FIX, 'static-tile-data.bin'));
  const leaves = ctLog.parseTile(tile);
  assert.deepEqual(leaves.map(l => l.entryType), [0, 1, 0]);
  assert.deepEqual(ctLog.entryDomains(leaves[1]).map(d => d.domain), ['oldrenewal.com', 'brandnew.io']);
  const requested = [];
  const fetchImpl = async url => {
    requested.push(url);
    if (url.endsWith('/checkpoint')) return new Response(fss.readFileSync(path.join(FIX, 'static-checkpoint.txt')));
    if (url.endsWith('/tile/data/001.p/3')) return new Response(tile);
    return new Response('nope', { status: 404 });
  };
  const client = ctLog.createStaticClient({ url: 'https://mon.example/log/' }, { fetchImpl });
  assert.equal((await client.head()).treeSize, 259);
  const entries = await client.read(257, 259);
  assert.deepEqual(entries.map(e => e.index), [257, 258]);
  assert.ok(requested.includes('https://mon.example/log/tile/data/001.p/3'));
});

test('RFC 6962 client reads get-sth and get-entries with indexes', async () => {
  const fetchImpl = async url => {
    if (url.endsWith('/ct/v1/get-sth')) return new Response(fss.readFileSync(path.join(FIX, 'rfc6962-get-sth.json')));
    assert.match(url, /get-entries\?start=1000&end=1001$/);
    return new Response(fss.readFileSync(path.join(FIX, 'rfc6962-get-entries.json')));
  };
  const client = ctLog.createRfc6962Client({ url: 'https://ct.example/log' }, { fetchImpl });
  const head = await client.head();
  assert.equal(head.treeSize, 1002);
  const entries = await client.read(1000, head.treeSize, 256);
  assert.deepEqual(entries.map(e => e.index), [1000, 1001]);
});

test('log list selection prefers usable Let\'s Encrypt / Google / Cloudflare logs for the current shard', () => {
  const list = JSON.parse(fss.readFileSync(path.join(FIX, 'log_list.json'), 'utf8'));
  const picked = ctLog.selectLogs(list, { now: Date.parse('2026-12-26T00:00:00Z') });
  assert.deepEqual(picked.map(l => `${l.api}:${l.operator}`), ["static:Let's Encrypt", 'rfc6962:Google', 'rfc6962:Cloudflare']);
  assert.equal(picked[0].url, 'https://mon.willow.ct.letsencrypt.org/2026h2d/');
  assert.ok(!picked.some(l => /Old|Other/.test(l.name)), 'retired and non-preferred logs are skipped');
  const explicit = ctLog.selectLogs(list, { include: ['static:https://x.example/log'] });
  assert.deepEqual(explicit.map(l => [l.api, l.url]), [['static', 'https://x.example/log/']]);
});

test('registrable domain reduction', () => {
  const r = v => ctLog.registrableDomain(v)?.domain ?? null;
  assert.equal(r('*.WWW.Foo.co.uk'), 'foo.co.uk');
  assert.equal(r('a.b.example.ai'), 'example.ai');
  assert.equal(r('www.example.com.'), 'example.com');
  assert.equal(r('1.2.3.4'), null);
  assert.equal(r('localhost'), null);
  assert.equal(r('co.uk'), null);
});

// ── Launch rule + dedupe ─────────────────────────────────────────────────

test('launch rule: recent add and went-live launch, old renewal does not, zone-less first-seen after warm-up', async t => {
  const { universeDir } = await tmp(t);
  await writeTapes(universeDir);
  const store = ct.openLaunchStore(':memory:');
  t.after(() => store.close());
  const indexed = await ct.refreshRecentIndex({ store, universeDir, windowDays: 14, now: NOW });
  assert.equal(indexed.files, 2, 'only tapes inside the window are imported');
  const config = ct.resolveCtConfig({});
  const verdict = (domain, zone, warmedUp) => ct.evaluateLaunch({ domain, zone }, { store, config, nowMs: NOW, warmedUp });
  assert.deepEqual(verdict('fresh-bakery.com', 'com', false), { launch: true, rule: 'recent-add', addedDay: '2026-10-25' });
  assert.equal(verdict('golive.net', 'net', false).rule, 'went-live');
  assert.deepEqual(verdict('oldrenewal.com', 'com', true), { launch: false, reason: 'not-recently-added' });
  assert.equal(verdict('acme.co.uk', 'co.uk', true).reason, 'no-zone-data');
  // Zone-less: a sighting during warm-up is recorded but not a launch, and never becomes one later.
  assert.equal(verdict('newthing.ai', 'ai', false).reason, 'warming-up');
  assert.equal(verdict('newthing.ai', 'ai', true).reason, 'seen-before');
  assert.deepEqual(verdict('brandnew.io', 'io', true), { launch: true, rule: 'first-seen', addedDay: null });
  assert.equal(verdict('brandnew.io', 'io', true).reason, 'seen-before');
  // Re-import is idempotent.
  assert.equal((await ct.refreshRecentIndex({ store, universeDir, windowDays: 14, now: NOW })).files, 0);
});

test('dedupe: a domain seen in many entries and logs is emitted once, even across restarts', async t => {
  const { dataDir, universeDir } = await tmp(t);
  await writeTapes(universeDir);
  const make = () => ct.createCtLaunchDetector({ dataDir, universeDir, env: {}, clock: () => NOW, log: quiet, siteFetchImpl: siteFetch, config: { recheckMs: 0, warmupDays: 0 } });
  const a = make();
  await a.refreshIndex();
  const body = JSON.parse(fss.readFileSync(path.join(FIX, 'rfc6962-get-entries.json'), 'utf8'));
  const entries = body.entries.map((item, i) => ({ index: i, ...ctLog.parseRfc6962Entry(item) }));
  const first = a.processEntries(null, entries).map(j => j.domain).sort();
  assert.deepEqual(first, ['brandnew.io', 'fresh-bakery.com', 'newthing.ai']);
  assert.deepEqual(a.processEntries(null, entries), []);
  await a.observer.idle();
  await a.stop();
  const b = make();
  await b.refreshIndex();
  assert.deepEqual(b.processEntries(null, entries), [], 'emitted set persists in sqlite');
  await b.stop();
  const lines = fss.readFileSync(path.join(universeDir, DAY, 'sites', ct.JOURNAL_FILE), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.domain).sort(), first);
  for (const line of lines) {
    assert.equal(line.source, 'ct');
    assert.equal(line.observedAt, new Date(NOW).toISOString());
    assert.equal(line.day, DAY);
    assert.equal(line.class, 'built');
  }
});

// ── Resume ───────────────────────────────────────────────────────────────

test('starts at the tree head, persists the position and resumes from it after a restart', async t => {
  const { dataDir, universeDir } = await tmp(t);
  await writeTapes(universeDir);
  const body = JSON.parse(fss.readFileSync(path.join(FIX, 'rfc6962-get-entries.json'), 'utf8'));
  let treeSize = 5000;
  const reads = [];
  const clientFactory = () => ({
    api: 'rfc6962',
    async head() { return { treeSize }; },
    async read(start, size, batch) {
      reads.push([start, size]);
      return body.entries.slice(0, Math.min(batch, size - start)).map((item, i) => ({ index: start + i, ...ctLog.parseRfc6962Entry(item) }));
    },
  });
  const log = { id: 'argon', name: 'Argon', operator: 'Google', api: 'rfc6962', url: 'https://ct.example/' };
  const make = () => ct.createCtLaunchDetector({ dataDir, universeDir, env: {}, clock: () => NOW, log: quiet, clientFactory, siteFetchImpl: siteFetch, config: { recheckMs: 0 } });
  const a = make();
  const tailA = a.newTail(log);
  a.tails.set(log.id, tailA);
  await a.stepTail(tailA);
  assert.equal(tailA.position, 5000, 'no historical replay');
  assert.deepEqual(reads, []);
  await a.stop();
  assert.equal(JSON.parse(fss.readFileSync(ct.ctPaths(dataDir).positions, 'utf8')).logs.argon.position, 5000);

  treeSize = 5002;
  const b = make();
  const tailB = b.newTail(log);
  b.tails.set(log.id, tailB);
  assert.equal(tailB.resumed, true);
  assert.equal(tailB.position, 5000);
  await b.stepTail(tailB); // stored treeSize == position -> refresh head
  await b.stepTail(tailB);
  assert.deepEqual(reads, [[5000, 5002]]);
  assert.equal(tailB.position, 5002);
  const h = b.health();
  assert.equal(h.logs[0].lag, 0);
  await b.observer.idle();
  await b.stop();
  assert.equal(JSON.parse(fss.readFileSync(ct.ctPaths(dataDir).positions, 'utf8')).logs.argon.position, 5002);
});

test('a failing log backs off exponentially and the error is visible in health', async t => {
  const { dataDir, universeDir } = await tmp(t);
  const clientFactory = () => ({ api: 'rfc6962', async head() { throw new ctLog.CtHttpError('HTTP 429', { status: 429 }); }, async read() { return []; } });
  const d = ct.createCtLaunchDetector({ dataDir, universeDir, env: {}, clock: () => NOW, log: quiet, clientFactory, config: { backoffMs: 1000, backoffMaxMs: 8000 } });
  const tail = d.newTail({ id: 'x', name: 'X', api: 'rfc6962', url: 'https://x/' });
  d.tails.set('x', tail);
  const delays = [];
  for (let i = 0; i < 5; i += 1) delays.push(await d.stepTail(tail));
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000]);
  const h = d.health();
  assert.equal(h.logs[0].consecutiveErrors, 5);
  assert.ok(h.errors.length >= 5);
  await d.writeHealth();
  const read = await ct.readCtHealth({ dataDir, env: { DOMAINSCOUT_UNIVERSE_PULL_ENABLED: '1' }, now: () => NOW });
  assert.equal(read.status, 'degraded');
  assert.ok(read.alerts.some(a => /5 consecutive errors/.test(a)));
  await d.stop();
});

// ── Health / public line / gate ──────────────────────────────────────────

test('gate matches the live-sites stage and the public line hides internals', () => {
  assert.equal(ct.ctEnabled({ DOMAINSCOUT_UNIVERSE_PULL_ENABLED: '1' }), true);
  assert.equal(ct.ctEnabled({}), false);
  assert.equal(ct.ctEnabled({ DOMAINSCOUT_UNIVERSE_PULL_ENABLED: '1', DOMAINSCOUT_LIVE_SITES_ENABLED: '0' }), false);
  assert.equal(ct.ctEnabled({ DOMAINSCOUT_UNIVERSE_PULL_ENABLED: '1', DOMAINSCOUT_CT_LAUNCHES_ENABLED: '0' }), false);
  const line = ct.publicLiveLine({ status: 'ok', updatedAt: new Date(NOW - 10000).toISOString(), launches: { lastPublishableAt: '2026-10-27T09:58:00.000Z', publishableLastHour: 42 }, warmup: { complete: true }, logs: [{ name: 'secret' }] }, NOW);
  assert.deepEqual(line, { status: 'live', lastLaunchAt: '2026-10-27T09:58:00.000Z', launchesLastHour: 42, warmingUp: false });
  assert.equal(ct.publicLiveLine({ status: 'ok', updatedAt: new Date(NOW - 3600000).toISOString() }, NOW).status, 'stale');
  assert.equal(ct.publicLiveLine({ status: 'disabled' }, NOW).status, 'off');
});

// ── Coexistence with the daily stage ─────────────────────────────────────

test('CT launches and the daily stage write the same day without interfering; the feed serves both', async t => {
  const { dataDir, universeDir } = await tmp(t);
  await writeTapes(universeDir);
  const ns = path.join(universeDir, DAY, 'ns');
  await fs.mkdir(ns, { recursive: true });
  await fs.writeFile(path.join(ns, 'movement.jsonl'), ['daily-shop.com', 'fresh-bakery.com'].map(domain => JSON.stringify({ domain, selection: 'went-live', today_ns: [] })).join('\n') + '\n');
  await fs.writeFile(path.join(ns, 'summary.json'), '{}');
  const d = ct.createCtLaunchDetector({ dataDir, universeDir, env: {}, clock: () => NOW, log: quiet, siteFetchImpl: siteFetch, config: { recheckMs: 0 } });
  await d.refreshIndex();
  const feed = createLiveSitesFeed({ universeDir, liveStatus: async () => ({ status: 'live', lastLaunchAt: null, launchesLastHour: 0, warmingUp: false }) });
  // CT emits while the daily day runs.
  const daily = ls.observeDay({ directory: universeDir, day: DAY, env: {}, fetchImpl: siteFetch, log: quiet, now: () => new Date(NOW), config: { concurrency: 2 } });
  d.processDomains([{ domain: 'fresh-bakery.com', zone: 'com' }]);
  await d.observer.idle();
  const mid = await feed.query({ window: '1d' });
  assert.ok(mid.items.some(i => i.domain === 'fresh-bakery.com'), 'CT launch is served immediately');
  await daily;
  d.processDomains([{ domain: 'golive.net', zone: 'net' }]);
  await d.observer.idle();
  await d.stop();
  const sites = path.join(universeDir, DAY, 'sites');
  const ctRows = fss.readFileSync(path.join(sites, ct.JOURNAL_FILE), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(ctRows.map(r => r.domain), ['fresh-bakery.com', 'golive.net'], 'daily finalize never touches the CT journal');
  const dailyRows = fss.readFileSync(path.join(sites, 'observations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(dailyRows.map(r => r.domain).sort(), ['daily-shop.com', 'fresh-bakery.com']);
  const out = await feed.query({ window: '1d' });
  assert.deepEqual(out.items.map(i => i.domain), ['daily-shop.com', 'fresh-bakery.com', 'golive.net'], 'merged and de-duplicated');
  assert.equal(out.live.status, 'live');
  for (const item of out.items) assert.deepEqual(Object.keys(item).sort(), ['day', 'description', 'domain', 'observedAt', 'title', 'url', 'zone']);
});
