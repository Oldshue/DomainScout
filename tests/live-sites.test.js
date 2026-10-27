'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const ls = require('../server/live-sites');

// Real loopback servers when the host allows them; this sandbox denies
// listen() (EPERM), so every behavioural test also runs against an
// in-process stub fetch that returns real WHATWG Response objects.
function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.once('error', error => resolve(error.code === 'EPERM' || error.code === 'EACCES' ? null : Promise.reject(error)));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function abortable(signal) {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return fail();
    signal?.addEventListener('abort', fail, { once: true });
  });
}

/** routes: (url: URL, init) => Response | Promise<Response> | 'hang' | Error. */
function stubFetch(route, seen = []) {
  return async (url, init = {}) => {
    const u = new URL(url);
    seen.push({ url: u.href, ua: init.headers?.['user-agent'], redirect: init.redirect });
    const out = await route(u, init);
    if (out === 'hang') return abortable(init.signal);
    if (out instanceof Error) throw out;
    return out;
  };
}

const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });
const netError = code => Object.assign(new TypeError('fetch failed'), { cause: { code } });

async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(() => resolve()));
}

const page = ({ title = '', description = '', head = '', body = '' } = {}) => `<!doctype html><html><head>${title ? `<title>${title}</title>` : ''}${description ? `<meta name="description" content="${description}">` : ''}${head}</head><body>${body}</body></html>`;

// ── Real-shaped fixtures ────────────────────────────────────────────────────
const BUILT_HTML = page({
  title: 'Acme Bakery &mdash; Sourdough &amp; Pastries in Portland',
  description: 'Family bakery baking naturally leavened sourdough and seasonal pastries every morning.',
  head: '<meta property="og:site_name" content="Acme Bakery"><link rel="stylesheet" href="/assets/site.css">',
  body: '<header class="nav"><a href="/menu">Menu</a><a href="/visit">Visit</a></header><main><h1>Acme Bakery</h1><p>Fresh sourdough loaves, croissants and seasonal pastries baked every morning on Division Street. Order ahead for pickup or visit our cafe for coffee and a slice of our famous apple pie. Open Tuesday to Sunday from 7am to 3pm. Catering available for offices and weddings.</p></main><footer>&copy; 2026 Acme Bakery</footer>',
});

const PARKED_CAF_HTML = page({
  title: 'parkedname.com',
  head: '<script type="text/javascript" src="//www.google.com/adsense/domains/caf.js"></script>',
  body: '<div id="related"><h2>Related Searches</h2><a href="#">Online Degrees</a><a href="#">Car Insurance Quotes</a><a href="#">Cheap Flights</a></div>',
});

const PARKED_REGISTRAR_HTML = page({
  title: 'parked2.com',
  body: '<div class="lander"><h1>parked2.com</h1><p>This Web page is parked for FREE, courtesy of GoDaddy.com.</p></div>',
});

const FOR_SALE_HTML = page({
  title: 'coolname.com is for sale',
  body: '<h1>coolname.com</h1><p>The domain coolname.com is for sale. Make an offer today and our broker will reply within one business day.</p>',
});

const COMING_SOON_HTML = page({ title: 'Coming Soon', body: '<h1>Coming soon</h1><p>We are launching shortly.</p>' });
const NGINX_HTML = page({ title: 'Welcome to nginx!', body: '<h1>Welcome to nginx!</h1><p>If you see this page, the nginx web server is successfully installed and working.</p>' });
const CHALLENGE_HTML = page({ title: 'Just a moment...', body: '<p>Checking your browser before accessing the site. Enable JavaScript and cookies to continue.</p>' });

const kitPage = label => page({
  title: `${label} Online Store | Best Deals 2026`,
  description: 'Shop the best deals online with free shipping.',
  body: `<div class="wrap"><nav class="top"><a href="/">Home</a><a href="/cart">Cart</a></nav><h1>${label} Online Store</h1><div class="grid"><div class="card">Running shoes from $19</div><div class="card">Sneakers from $29</div><div class="card">Boots from $39</div></div><p>Free shipping on every order over $50. Thirty day returns, secure checkout and friendly support from our customer team every day of the week.</p></div>`,
});

const ok = (domain, html, extra = {}) => ({ ok: true, status: 200, finalUrl: `https://${domain}/`, requestedUrl: `https://${domain}/`, html, hops: [], ...extra });

// ── Classifier ─────────────────────────────────────────────────────────────
test('classifier: operating site is built with title and description', () => {
  const result = ls.classifyObservation({ domain: 'acme-bakery.com', fetched: ok('acme-bakery.com', BUILT_HTML) });
  assert.equal(result.class, 'built');
  assert.equal(result.title, 'Acme Bakery — Sourdough & Pastries in Portland');
  assert.match(result.description, /sourdough/);
  assert.equal(result.titleReal, true);
  assert.equal(result.spam, false);
});

test('classifier: ad-feed and registrar parking pages are parked', () => {
  assert.equal(ls.classifyObservation({ domain: 'parkedname.com', fetched: ok('parkedname.com', PARKED_CAF_HTML) }).class, 'parked');
  assert.equal(ls.classifyObservation({ domain: 'parked2.com', fetched: ok('parked2.com', PARKED_REGISTRAR_HTML) }).class, 'parked');
});

test('classifier: parking nameservers mark an unreachable name parked', () => {
  const result = ls.classifyObservation({ domain: 'x-parked.com', fetched: { ok: false, status: null, reason: 'timeout' }, nameservers: ['ns1.sedoparking.com', 'ns2.sedoparking.com'] });
  assert.equal(result.class, 'parked');
});

test('classifier: sale statements and marketplace redirects are for_sale', () => {
  assert.equal(ls.classifyObservation({ domain: 'coolname.com', fetched: ok('coolname.com', FOR_SALE_HTML) }).class, 'for_sale');
  const dan = ls.classifyObservation({ domain: 'coolname.com', fetched: ok('coolname.com', '<html><title>Buy</title></html>', { finalUrl: 'https://dan.com/buy-domain/coolname.com', hops: ['https://dan.com/buy-domain/coolname.com'] }) });
  assert.equal(dan.class, 'for_sale');
});

test('classifier: coming-soon, server default and empty pages are placeholder', () => {
  assert.equal(ls.classifyObservation({ domain: 'soon.io', fetched: ok('soon.io', COMING_SOON_HTML) }).class, 'placeholder');
  assert.equal(ls.classifyObservation({ domain: 'fresh.net', fetched: ok('fresh.net', NGINX_HTML) }).class, 'placeholder');
  assert.equal(ls.classifyObservation({ domain: 'blank.org', fetched: ok('blank.org', '') }).class, 'placeholder');
});

test('classifier: off-site redirect, HTTP errors, challenges and transport failures', () => {
  const off = ls.classifyObservation({ domain: 'bigcorp-promo.com', fetched: ok('bigcorp-promo.com', BUILT_HTML, { finalUrl: 'https://www.bigcorp.com/' }) });
  assert.equal(off.class, 'redirect_offsite');
  const www = ls.classifyObservation({ domain: 'acme-bakery.com', fetched: ok('acme-bakery.com', BUILT_HTML, { finalUrl: 'https://www.acme-bakery.com/en/' }) });
  assert.equal(www.class, 'built', 'www/subpath of the same domain is not off-site');
  assert.equal(ls.classifyObservation({ domain: 'down.com', fetched: { ok: true, status: 503, finalUrl: 'https://down.com/', html: page({ title: 'Service Unavailable' }) } }).class, 'error');
  assert.equal(ls.classifyObservation({ domain: 'cf.com', fetched: ok('cf.com', CHALLENGE_HTML) }).class, 'error');
  const dead = ls.classifyObservation({ domain: 'dead.com', fetched: { ok: false, status: null, reason: 'dns' } });
  assert.equal(dead.class, 'error');
  assert.equal(dead.reason, 'dns');
});

test('isRealTitle rejects domain-only and framework default titles', () => {
  assert.equal(ls.isRealTitle('Acme Bakery', 'acme.com'), true);
  for (const title of ['', 'acme.com', 'www.acme.com', 'acme', 'Home', 'React App', 'Vite + React', 'Loading...', '404 Not Found', '---']) {
    assert.equal(ls.isRealTitle(title, 'acme.com'), false, title);
  }
});

// ── Kit collapse ───────────────────────────────────────────────────────────
test('collapseKits marks one actor\'s templated batch and keeps distinct sites', () => {
  const labels = ['alphashoes', 'betashoes', 'gammashoes', 'deltashoes', 'epsilonshoes', 'zetashoes'];
  const records = labels.map(label => ({ domain: `${label}.com`, ...ls.classifyObservation({ domain: `${label}.com`, fetched: ok(`${label}.com`, kitPage(label)) }) }));
  records.push({ domain: 'acme-bakery.com', ...ls.classifyObservation({ domain: 'acme-bakery.com', fetched: ok('acme-bakery.com', BUILT_HTML) }) });
  records.push({ domain: 'parkedname.com', ...ls.classifyObservation({ domain: 'parkedname.com', fetched: ok('parkedname.com', PARKED_CAF_HTML) }) });
  for (const record of records.slice(0, 6)) assert.equal(record.class, 'built');
  const kits = ls.collapseKits(records, { kitThreshold: 5, kitTitleThreshold: 8 });
  assert.equal(kits.length, 1);
  assert.equal(kits[0].size, 6);
  assert.equal(kits[0].builtMembers, 6);
  for (const record of records.slice(0, 6)) assert.ok(record.kit && record.kit.id === kits[0].id);
  assert.equal(records[6].kit, null);
  assert.equal(records[7].kit, null);
});

test('collapseKits leaves groups below the threshold alone', () => {
  const records = ['onestore', 'twostore', 'threestore'].map(label => ({ domain: `${label}.com`, ...ls.classifyObservation({ domain: `${label}.com`, fetched: ok(`${label}.com`, kitPage(label)) }) }));
  assert.deepEqual(ls.collapseKits(records, { kitThreshold: 5, kitTitleThreshold: 8 }), []);
  assert.ok(records.every(record => record.kit === null));
});

// ── fetchSite against a stub origin ────────────────────────────────────────
const STUB_ROUTE = u => {
  if (u.hostname === 'refused.test') return netError('ECONNREFUSED');
  if (u.pathname === '/redirect') return redirect('/final');
  if (u.pathname === '/final') return html(BUILT_HTML);
  if (u.pathname === '/big') return html('<html><title>Big</title>' + 'x'.repeat(1024 * 1024));
  if (u.pathname === '/loop') return redirect('/loop', 301);
  if (u.pathname === '/hang') return 'hang';
  if (u.pathname === '/image') return new Response('binary', { status: 200, headers: { 'content-type': 'image/png' } });
  return html('nope', 404);
};

test('fetchSite follows redirects, caps size, sends an honest UA, times out and falls back to HTTP', async () => {
  const seen = [];
  const fetchImpl = stubFetch(STUB_ROUTE, seen);
  const base = 'http://origin.test';

  const redirected = await ls.fetchSite('example.test', { fetchImpl, urlFor: () => `${base}/redirect` });
  assert.equal(redirected.ok, true);
  assert.equal(redirected.status, 200);
  assert.equal(redirected.finalUrl, `${base}/final`);
  assert.equal(redirected.hops.length, 1);
  assert.equal(seen[0].ua, ls.DEFAULT_USER_AGENT);
  assert.match(seen[0].ua, /DomainScout/);
  assert.equal(seen[0].redirect, 'manual', 'redirects are followed by the stage, hop by hop');

  const big = await ls.fetchSite('example.test', { fetchImpl, urlFor: () => `${base}/big`, maxBytes: 20000 });
  assert.equal(big.ok, true);
  assert.equal(big.truncated, true);
  assert.equal(big.bytes, 20000);

  const image = await ls.fetchSite('example.test', { fetchImpl, urlFor: () => `${base}/image` });
  assert.equal(image.ok, true);
  assert.equal(image.bytes, 0, 'non-HTML bodies are not read');

  const loop = await ls.fetchSite('example.test', { fetchImpl, urlFor: () => `${base}/loop`, maxRedirects: 3 });
  assert.equal(loop.ok, false);
  assert.equal(loop.reason, 'too_many_redirects');

  const started = Date.now();
  const hung = await ls.fetchSite('example.test', { fetchImpl, urlFor: () => `${base}/hang`, timeoutMs: 300 });
  assert.equal(hung.ok, false);
  assert.equal(hung.reason, 'timeout');
  assert.ok(Date.now() - started < 3000, 'both schemes bounded by the deadline');

  const fallback = await ls.fetchSite('example.test', { fetchImpl, urlFor: scheme => (scheme === 'https' ? 'https://refused.test/' : `${base}/final`) });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.scheme, 'http');
  assert.equal(fallback.attempts[0].scheme, 'https');
  assert.equal(fallback.attempts[0].reason, 'refused');

  const httpsStatus = await ls.fetchSite('example.test', { fetchImpl, urlFor: scheme => (scheme === 'https' ? `${base}/missing` : `${base}/final`) });
  assert.equal(httpsStatus.scheme, 'https', 'an HTTPS HTTP-status answer is kept, not retried over HTTP');
  assert.equal(httpsStatus.status, 404);
});

test('fetchSite against a real local server (skipped where loopback listen is denied)', async t => {
  const server = await listen((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/final' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(BUILT_HTML);
  });
  if (!server) return t.skip('loopback listen denied in this sandbox');
  t.after(() => close(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await ls.fetchSite('example.test', { urlFor: () => `${base}/redirect` });
  assert.equal(result.ok, true);
  assert.equal(result.finalUrl, `${base}/final`);
});

// ── Day stage ──────────────────────────────────────────────────────────────
const DAY = '2026-10-20';
const KIT_LABELS = ['alphashoes', 'betashoes', 'gammashoes', 'deltashoes', 'epsilonshoes', 'zetashoes'];
const PAGES = {
  'acme-bakery.com': { body: BUILT_HTML },
  'parkedname.com': { body: PARKED_CAF_HTML },
  'coolname.com': { body: FOR_SALE_HTML },
  'soon.io': { body: COMING_SOON_HTML },
  'redirectme.com': { status: 302, headers: { location: 'https://www.bigcorp.com/' } },
  'www.bigcorp.com': { body: page({ title: 'BigCorp', body: '<p>' + 'BigCorp builds industrial pumps. '.repeat(10) + '</p>' }) },
  'httponly.org': { body: page({ title: 'Riverside Chess Club', body: '<p>' + 'Weekly blitz nights and coaching for juniors. '.repeat(8) + '</p>' }) },
  ...Object.fromEntries(KIT_LABELS.map(label => [`${label}.com`, { body: kitPage(label) }])),
};
const WENT_LIVE = ['acme-bakery.com', 'parkedname.com', 'coolname.com', 'soon.io', 'gone.net', 'redirectme.com', 'httponly.org', ...KIT_LABELS.map(label => `${label}.com`)];

async function dayFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-sites-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const nsDir = path.join(directory, DAY, 'ns');
  await fs.mkdir(nsDir, { recursive: true });
  const rows = WENT_LIVE.map(domain => ({ kind: 'changed', domain, selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', today_ns: ['ns1.example-host.com'], today_provider: 'Example' }));
  rows.push({ kind: 'changed', domain: 'acme-bakery.com', selection: 'went-live', prev_class: 'none', today_class: 'hosting' });
  rows.push({ kind: 'changed', domain: 'sold.com', selection: 'departures', prev_class: 'seller', today_class: 'hosting' });
  await fs.writeFile(path.join(nsDir, 'movement.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await fs.writeFile(path.join(nsDir, 'summary.json'), JSON.stringify({ day: DAY, wentLive: WENT_LIVE.length }));
  const hits = new Map();
  const fetchImpl = stubFetch(u => {
    hits.set(u.hostname, (hits.get(u.hostname) || 0) + 1);
    if (u.hostname === 'gone.net') return netError('ENOTFOUND');
    if (u.hostname === 'httponly.org' && u.protocol === 'https:') return netError('ECONNREFUSED');
    const spec = PAGES[u.hostname];
    if (!spec) return html('nope', 404);
    if (spec.status >= 300 && spec.status < 400) return redirect(spec.headers.location, spec.status);
    return html(spec.body || '', spec.status || 200);
  });
  return { directory, fetchImpl, hits };
}

const quiet = { log() {}, warn() {}, error() {} };

test('observeDay classifies every went-live name, collapses kits and persists next to the tape', async t => {
  const { directory, fetchImpl, hits } = await dayFixture(t);
  const result = await ls.observeDay({ directory, day: DAY, fetchImpl, env: {}, config: { concurrency: 4, timeoutMs: 3000 }, log: quiet });
  const summary = result.summary;
  assert.equal(summary.status, 'complete');
  assert.equal(summary.total, WENT_LIVE.length);
  assert.equal(hits.get('sold.com'), undefined, 'departures are not observed');
  const lines = (await fs.readFile(path.join(directory, DAY, 'sites', 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const byDomain = Object.fromEntries(lines.map(record => [record.domain, record]));
  assert.equal(lines.length, WENT_LIVE.length);
  assert.equal(byDomain['acme-bakery.com'].class, 'built');
  assert.equal(byDomain['parkedname.com'].class, 'parked');
  assert.equal(byDomain['coolname.com'].class, 'for_sale');
  assert.equal(byDomain['soon.io'].class, 'placeholder');
  assert.equal(byDomain['gone.net'].class, 'error');
  assert.equal(byDomain['gone.net'].reason, 'dns');
  assert.equal(byDomain['redirectme.com'].class, 'redirect_offsite');
  assert.equal(byDomain['redirectme.com'].finalUrl, 'https://www.bigcorp.com/');
  assert.equal(byDomain['httponly.org'].class, 'built');
  assert.equal(byDomain['httponly.org'].scheme, 'http');
  for (const label of KIT_LABELS) assert.ok(byDomain[`${label}.com`].kit, label);
  assert.equal(byDomain['acme-bakery.com'].kit, null);
  assert.equal(summary.counts.built, 8);
  assert.deepEqual(summary.built, { pages: 8, independent: 2, kitBatches: 1, distinct: 3, publishable: 2 });
  assert.equal(summary.kits.count, 1);
  assert.equal(summary.kits.names, 6);
  await assert.rejects(fs.access(path.join(directory, DAY, 'sites', 'observations.partial.jsonl')));

  hits.clear();
  const again = await ls.observeDay({ directory, day: DAY, fetchImpl, env: {}, log: quiet });
  assert.equal(again.skipped, 'complete');
  assert.equal(hits.size, 0, 'a complete day is idempotent');
});

test('observeDay resumes from its journal after an interrupted run', async t => {
  const { directory, fetchImpl, hits } = await dayFixture(t);
  const outDir = path.join(directory, DAY, 'sites');
  await fs.mkdir(outDir, { recursive: true });
  const journaled = { domain: 'acme-bakery.com', zone: 'com', day: DAY, class: 'built', reason: 'operating_site', title: 'Acme Bakery', titleReal: true, spam: false, fingerprint: { title: 'acme bakery', skeleton: 'x' }, observedAt: '2026-10-20T08:00:00.000Z', version: ls.CLASSIFIER_VERSION };
  await fs.writeFile(path.join(outDir, 'observations.partial.jsonl'), JSON.stringify(journaled) + '\n{"torn":');
  const { summary } = await ls.observeDay({ directory, day: DAY, fetchImpl, env: {}, config: { concurrency: 4 }, log: quiet });
  assert.equal(summary.resumed, 1);
  assert.equal(hits.get('acme-bakery.com'), undefined);
  assert.equal(summary.observed, WENT_LIVE.length);
});

test('observeDay completes when every fetch fails, and reports a missing tape', async t => {
  const { directory } = await dayFixture(t);
  const failing = () => Promise.reject(new TypeError('fetch failed'));
  const { summary } = await ls.observeDay({ directory, day: DAY, fetchImpl: failing, env: {}, config: { concurrency: 8 }, log: quiet });
  assert.equal(summary.status, 'complete');
  assert.equal(summary.counts.error, WENT_LIVE.length);
  await assert.rejects(ls.observeDay({ directory, day: '2026-10-19', fetchImpl: failing, env: {}, log: quiet }), error => error.code === 'NO_TAPE');
});

test('resolveLiveSitesConfig clamps env values', () => {
  const config = ls.resolveLiveSitesConfig({ DOMAINSCOUT_LIVE_SITES_CONCURRENCY: '9999', DOMAINSCOUT_LIVE_SITES_TIMEOUT_MS: '5000' });
  assert.equal(config.concurrency, ls.DEFAULTS.concurrency);
  assert.equal(ls.DEFAULTS.concurrency, 48);
  assert.equal(ls.resolveLiveSitesConfig({}).concurrency, 48);
  assert.equal(ls.resolveLiveSitesConfig({ DOMAINSCOUT_LIVE_SITES_CONCURRENCY: '64' }).concurrency, 64);
  assert.equal(ls.resolveLiveSitesConfig({ DOMAINSCOUT_LIVE_SITES_CONCURRENCY: '128' }).concurrency, 128, 'env override unchanged');
  assert.equal(ls.resolveLiveSitesConfig({}).timeoutMs, 8000);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.userAgent, ls.DEFAULT_USER_AGENT);
});

test('error guard halves concurrency when the rolling error share of the window exceeds 92%, floor 16', () => {
  const guard = ls.createErrorGuard({ initial: 48, now: () => new Date('2026-10-21T00:00:00.000Z') });
  // Exactly 92% errors (920/1000) in a full window does not trip (must exceed).
  // The oldest observation (i=0) is a success, so the next error evicts it.
  for (let i = 0; i < 1000; i += 1) assert.equal(guard.observe(i % 25 >= 2), null);
  assert.equal(guard.limit(), 48);
  // The window is full (rolling): one more error replaces the oldest success, 921/1000 > 92%.
  const event = guard.observe(true);
  assert.ok(event, 'rolling share 921/1000 trips the guard');
  assert.deepEqual({ from: event.from, to: event.to, window: event.window }, { from: 48, to: 24, window: 1000 });
  assert.equal(guard.limit(), 24);
  // A fresh window is required before the next halving.
  for (let i = 0; i < 999; i += 1) assert.equal(guard.observe(true), null);
  assert.equal(guard.observe(true).to, 16);
  for (let i = 0; i < 5000; i += 1) assert.equal(guard.observe(true), null, 'never below the floor');
  assert.equal(guard.limit(), 16);
  const state = guard.state();
  assert.equal(state.throttled, true);
  assert.equal(state.initialConcurrency, 48);
  assert.equal(state.concurrency, 16);
  assert.equal(state.events.length, 2);
  // A healthy day is never throttled.
  const healthy = ls.createErrorGuard({ initial: 48 });
  for (let i = 0; i < 5000; i += 1) healthy.observe(i % 5 === 0);
  assert.equal(healthy.limit(), 48);
  assert.equal(healthy.state().throttled, false);
  // Resuming a throttled day keeps the reduced level.
  assert.equal(ls.createErrorGuard({ initial: 48, start: state }).limit(), 16);
  // An env override at or below the floor is never reduced.
  const low = ls.createErrorGuard({ initial: 8, window: 4 });
  for (let i = 0; i < 20; i += 1) low.observe(true);
  assert.equal(low.limit(), 8);
});

test('mapLimit retires slots when the limit function drops, without aborting in-flight work', async () => {
  let limit = 8;
  let inflight = 0;
  const peaksAfterDrop = [];
  let processed = 0;
  await ls.mapLimit(Array.from({ length: 200 }, (_, i) => i), () => limit, async () => {
    inflight += 1;
    if (processed >= 50) peaksAfterDrop.push(inflight);
    await new Promise(resolve => setImmediate(resolve));
    inflight -= 1;
    processed += 1;
    if (processed === 20) limit = 2;
  });
  assert.equal(processed, 200, 'every item is processed');
  assert.ok(peaksAfterDrop.length > 0);
  assert.ok(Math.max(...peaksAfterDrop) <= 2, `in-flight after the drop: ${Math.max(...peaksAfterDrop)}`);
});

test('observeDay throttles and records it in the summary when most fetches error', async t => {
  const { directory } = await dayFixture(t);
  const failing = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } }));
  const { summary } = await ls.observeDay({ directory, day: DAY, fetchImpl: failing, env: {}, config: { concurrency: 8, errorWindow: 4, minConcurrency: 2 }, log: quiet });
  assert.equal(summary.counts.error, WENT_LIVE.length);
  assert.equal(summary.errors.dns, WENT_LIVE.length, 'resolver exhaustion lands in class error, reason dns');
  assert.equal(summary.limits.concurrency, 8);
  assert.equal(summary.throttle.throttled, true);
  assert.equal(summary.throttle.initialConcurrency, 8);
  assert.equal(summary.throttle.concurrency, 2);
  assert.deepEqual(summary.throttle.events.map(e => [e.from, e.to]), [[8, 4], [4, 2]]);
  const ok = await dayFixture(t);
  const healthy = await ls.observeDay({ directory: ok.directory, day: DAY, fetchImpl: ok.fetchImpl, env: {}, config: { concurrency: 4, errorWindow: 4, minConcurrency: 2 }, log: quiet });
  assert.equal(healthy.summary.throttle.throttled, false);
  assert.equal(healthy.summary.throttle.concurrency, 4);
});

test('observeDay surfaces a running error count and the feed progress reports errors per day', async t => {
  const { directory, fetchImpl } = await dayFixture(t);
  const { summary } = await ls.observeDay({ directory, day: DAY, fetchImpl, env: {}, config: { concurrency: 2, progressEveryMs: 0 }, log: quiet });
  assert.equal(summary.counts.error, 1, 'gone.net (dns) is the only error');
  const { createLiveSitesFeed } = require('../server/live-sites-feed');
  const body = await createLiveSitesFeed({ universeDir: directory }).query({});
  const row = body.progress.find(entry => entry.day === DAY);
  assert.equal(row.status, 'complete');
  assert.equal(row.errors, 1);
});

test('retryErrors re-observes a complete day once: keeps successful rows, refetches only error rows, never loops', async t => {
  const { directory, fetchImpl, hits } = await dayFixture(t);
  // First pass: resolver exhaustion turns every non-acme fetch into a dns error.
  const flaky = (url, init) => (new URL(url).hostname === 'acme-bakery.com' ? fetchImpl(url, init) : Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } })));
  const first = await ls.observeDay({ directory, day: DAY, fetchImpl: flaky, env: {}, config: { concurrency: 4 }, log: quiet });
  assert.equal(first.summary.counts.error, WENT_LIVE.length - 1);
  const firstAcme = JSON.parse((await fs.readFile(path.join(directory, DAY, 'sites', 'observations.jsonl'), 'utf8')).split('\n').find(line => line.includes('"acme-bakery.com"')));
  hits.clear();
  const retry = await ls.observeDay({ directory, day: DAY, fetchImpl, retryErrors: true, env: {}, config: { concurrency: 4 }, log: quiet });
  assert.equal(retry.summary.status, 'complete');
  assert.equal(hits.get('acme-bakery.com'), undefined, 'successful rows are kept, not refetched');
  assert.ok(hits.get('coolname.com') >= 1, 'error rows are retried');
  assert.equal(retry.summary.counts.error, 1, 'only gone.net still errors');
  assert.equal(retry.summary.observed, WENT_LIVE.length);
  assert.equal(retry.summary.reobservation.kept, 1);
  assert.equal(retry.summary.reobservation.retried, WENT_LIVE.length - 1);
  assert.equal(retry.summary.reobservation.previousErrors, WENT_LIVE.length - 1);
  const lines = (await fs.readFile(path.join(directory, DAY, 'sites', 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.find(r => r.domain === 'acme-bakery.com').observedAt, firstAcme.observedAt, 'kept journal entry is the original');
  await assert.rejects(fs.access(path.join(directory, DAY, 'sites', 'observations.partial.jsonl')));
  hits.clear();
  const again = await ls.observeDay({ directory, day: DAY, fetchImpl, retryErrors: true, env: {}, log: quiet });
  assert.equal(again.skipped, 'reobserved');
  assert.equal(hits.size, 0, 'a day is retried only once');
});

test('error thresholds default to 92% (guard) and 90% (re-observation) and are env-overridable', () => {
  assert.equal(ls.DEFAULT_ERROR_GUARD_THRESHOLD, 0.92);
  assert.equal(ls.DEFAULT_REOBSERVE_ERROR_SHARE, 0.9);
  assert.equal(ls.resolveLiveSitesConfig({}).errorThreshold, 0.92);
  assert.equal(ls.resolveLiveSitesConfig({ DOMAINSCOUT_LIVE_SITES_ERROR_GUARD_THRESHOLD: '0.8' }).errorThreshold, 0.8);
  assert.equal(ls.resolveLiveSitesConfig({ DOMAINSCOUT_LIVE_SITES_ERROR_GUARD_THRESHOLD: 'bad' }).errorThreshold, 0.92);
});
