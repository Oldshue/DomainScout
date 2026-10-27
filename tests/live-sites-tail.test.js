'use strict';

// Tail-stall regression: names whose DNS, connect, headers or body never
// settle (and whose body cancel never settles) must still be recorded as error
// observations within bounded time, so the day finalizes and the next day runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const ls = require('../server/live-sites');
const { createLiveSitesStage } = require('../server/live-sites-stage');

const quiet = { log() {}, warn() {}, error() {} };
const never = () => new Promise(() => {});

/** A body stream that never yields a chunk and whose cancel never settles. */
function stuckStream(first) {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (first && !sent) { sent = true; controller.enqueue(new TextEncoder().encode(first)); return undefined; }
      return never();
    },
    cancel() { return never(); },
  });
}

async function startServers(t) {
  const sockets = new Set();
  // Accepts TCP and never speaks: a stuck TLS handshake / header wait.
  const silent = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
  // Sends headers and part of the body, then never finishes.
  const dribble = http.createServer((req, res) => {
    sockets.add(res.socket);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<html><head><title>Half</title>');
  });
  const listen = server => new Promise((resolve, reject) => {
    server.once('error', error => (error.code === 'EPERM' || error.code === 'EACCES' ? resolve(false) : reject(error)));
    server.listen(0, '127.0.0.1', () => resolve(true));
  });
  // Sandboxes that deny loopback listen fall back to pure stubs that hang the same way.
  if (!(await listen(silent)) || !(await listen(dribble))) {
    try { silent.close(); } catch { /* not listening */ }
    try { dribble.close(); } catch { /* not listening */ }
    return null;
  }
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    silent.close();
    dribble.close();
  });
  return { silentPort: silent.address().port, dribblePort: dribble.address().port };
}

const OK_HTML = '<html><head><title>Acme Bakery Fresh Bread</title></head><body>' + 'Fresh sourdough and pastries baked every morning in our neighborhood shop. '.repeat(10) + '</body></html>';

function hangingFetch(servers) {
  const { silentPort, dribblePort } = servers || {};
  return async (url, init) => {
    const host = new URL(url).hostname;
    const name = host.split('.')[0].replace(/\d+$/, '');
    switch (name) {
      case 'dnshang': return never(); // lookup with no timeout, ignores the signal
      case 'connecthang': return servers ? globalThis.fetch(`http://127.0.0.1:${silentPort}/`, init) : never();
      case 'headerhang': return never();
      case 'bodyhang': return new Response(stuckStream('<html><title>x'), { status: 200, headers: { 'content-type': 'text/html' } });
      case 'realbodyhang': return servers ? globalThis.fetch(`http://127.0.0.1:${dribblePort}/`, init) : new Response(stuckStream('<html><head><title>Half</title>'), { status: 200, headers: { 'content-type': 'text/html' } });
      case 'cancelhang': return new Response(stuckStream(), { status: 302, headers: { location: `${url}next` } });
      case 'throws': throw new Error('synchronous fetch explosion');
      default: return new Response(OK_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }
  };
}

const KINDS = ['dnshang', 'connecthang', 'headerhang', 'bodyhang', 'realbodyhang', 'cancelhang', 'throws', 'acmebakery'];

async function writeDay(directory, day, copies = 3) {
  const nsDir = path.join(directory, day, 'ns');
  await fs.mkdir(nsDir, { recursive: true });
  const domains = [];
  for (let i = 0; i < copies; i += 1) for (const kind of KINDS) domains.push(`${kind}${i}.com`);
  const rows = domains.map(domain => ({ kind: 'changed', domain, selection: 'went-live', prev_class: 'none', today_class: 'hosting', today_ns: ['ns1.example-host.com'] }));
  await fs.writeFile(path.join(nsDir, 'movement.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await fs.writeFile(path.join(nsDir, 'summary.json'), JSON.stringify({ day, wentLive: domains.length }));
  return domains;
}

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-tail-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readObservations(directory, day) {
  const text = await fs.readFile(path.join(directory, day, 'sites', 'observations.jsonl'), 'utf8');
  return text.trim().split('\n').map(line => JSON.parse(line));
}

test('fetchSite settles within its deadlines when DNS, connect, headers, body and cancel all hang', async t => {
  const servers = await startServers(t);
  const fetchImpl = hangingFetch(servers);
  for (const kind of ['dnshang', 'connecthang', 'headerhang', 'bodyhang', 'realbodyhang', 'cancelhang']) {
    const started = Date.now();
    const result = await ls.fetchSite(`${kind}0.com`, { fetchImpl, timeoutMs: 250 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `${kind} took ${elapsed}ms`);
    if (kind === 'bodyhang' || kind === 'realbodyhang') assert.equal(result.status, null, `${kind} body hang is a timeout, not a page`);
    assert.equal(result.ok, false, kind);
    // cancelhang: a redirect loop whose body cancel never settles. Cancel is no
    // longer awaited, so the loop is followed promptly to its redirect cap.
    assert.equal(result.reason, kind === 'cancelhang' ? 'too_many_redirects' : 'timeout', kind);
  }
  const thrown = await ls.fetchSite('throws0.com', { fetchImpl, timeoutMs: 250 });
  assert.equal(thrown.ok, false);
});

test('observeDay finalizes in bounded time with every hanging name recorded as an error observation', async t => {
  const servers = await startServers(t);
  const directory = await tempDir(t);
  const day = '2026-10-26';
  const domains = await writeDay(directory, day, 4);
  const started = Date.now();
  const { summary } = await ls.observeDay({ directory, day, fetchImpl: hangingFetch(servers), env: {}, config: { concurrency: 8, timeoutMs: 250 }, log: quiet });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `day took ${elapsed}ms`);
  assert.equal(summary.status, 'complete');
  assert.equal(summary.total, domains.length);
  assert.equal(summary.observed, domains.length);
  assert.equal(summary.unsettled, 0);
  const records = await readObservations(directory, day);
  assert.equal(records.length, domains.length);
  for (const record of records) {
    if (record.domain.startsWith('acmebakery')) assert.equal(record.class, 'built', record.domain);
    else assert.equal(record.class, 'error', `${record.domain} ${record.class}`);
    if (record.domain.startsWith('cancelhang')) assert.equal(record.reason, 'too_many_redirects', record.domain);
    else if (/hang/.test(record.domain)) assert.equal(record.reason, 'timeout', record.domain);
  }
  await assert.rejects(fs.stat(path.join(directory, day, 'sites', 'observations.partial.jsonl')), { code: 'ENOENT' });
});

test('the per-name watchdog settles a name even when the fetch deadline would be longer', async t => {
  const directory = await tempDir(t);
  const day = '2026-10-18';
  const domains = await writeDay(directory, day, 1);
  const started = Date.now();
  const { summary } = await ls.observeDay({ directory, day, fetchImpl: () => never(), env: {}, config: { concurrency: 2, timeoutMs: 5000, watchdogMs: 150 }, log: quiet });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `day took ${elapsed}ms`);
  assert.equal(summary.status, 'complete');
  assert.equal(summary.observed, domains.length);
  assert.equal(summary.watchdogFired, domains.length);
  assert.equal(summary.errors.watchdog_timeout, domains.length);
});

test('progress is reported by time as well as by count, so a short tail is visible', async t => {
  const directory = await tempDir(t);
  const day = '2026-10-20';
  await writeDay(directory, day, 1);
  const seen = [];
  await ls.observeDay({ directory, day, fetchImpl: async () => { await new Promise(r => setTimeout(r, 30)); return new Response(OK_HTML, { status: 200, headers: { 'content-type': 'text/html' } }); }, env: {}, config: { concurrency: 1, timeoutMs: 1000, progressEveryMs: 0 }, onProgress: p => seen.push(p.observed), log: quiet });
  assert.ok(seen.length >= KINDS.length - 1, `progress reports: ${seen.length}`);
});

test('a stalled day no longer blocks the next day in the stage queue', async t => {
  const servers = await startServers(t);
  const directory = await tempDir(t);
  await writeDay(directory, '2026-10-26', 2);
  await writeDay(directory, '2026-10-25', 2);
  const fetchImpl = hangingFetch(servers);
  const stage = createLiveSitesStage({
    universeDir: directory,
    dataDir: directory,
    env: {},
    log: quiet,
    runDay: async ({ day }) => {
      await ls.observeDay({ directory, day, fetchImpl, env: {}, config: { concurrency: 8, timeoutMs: 250 }, log: quiet });
      return { ok: true };
    },
  });
  const started = Date.now();
  stage.trigger({ day: '2026-10-26' });
  stage.trigger({ day: '2026-10-25' });
  await stage.idle();
  assert.ok(Date.now() - started < 15000);
  for (const day of ['2026-10-26', '2026-10-25']) {
    const summary = await ls.readSiteSummary(directory, day);
    assert.equal(summary.status, 'complete', day);
    assert.equal(summary.observed, summary.total, day);
  }
});
