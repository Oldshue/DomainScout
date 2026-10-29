'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const serverRequire = createRequire(path.join(__dirname, '..', 'server', 'index.js'));
const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

function loadRequireAuth() {
  const a = source.indexOf('function normalizeRemoteIp');
  const b = source.indexOf('\n}\n\n// Read-only agent access', a) + 2;
  const c = source.indexOf('function agentTokenAllowed');
  const d = source.indexOf('\n}\n\nfunction requireAuth', c) + 2;
  const e = source.indexOf('function requireAuth');
  const f = source.indexOf('\n}\n\n// ── Login page', e) + 2;
  const stub = 'function safeReturnPath(v, fallback) { return v || fallback; }';
  const body = `${stub}\n${source.slice(a, b)}\n${source.slice(c, d)}\n${source.slice(e, f)}\nreturn requireAuth;`;
  return Function('require', 'process', body)(serverRequire, { env: {} });
}

function run(method, reqPath) {
  const out = { next: false, status: null, redirected: null };
  const req = { method, path: reqPath, originalUrl: reqPath, headers: {}, query: {}, session: null, socket: {} };
  const res = {
    status(code) { out.status = code; return this; },
    json() { return this; },
    redirect(url) { out.redirected = url; return this; },
  };
  loadRequireAuth()(req, res, () => { out.next = true; });
  return out;
}

test('/live is served without auth and other paths still require it', () => {
  assert.equal(run('GET', '/live').next, true);
  for (const [m, p] of [['POST', '/live'], ['GET', '/live/'], ['GET', '/live.html'], ['GET', '/live/x'], ['GET', '/']]) {
    const out = run(m, p);
    assert.equal(out.next, false, `${m} ${p}`);
    assert.ok(out.redirected, `${m} ${p}`);
  }
  assert.match(source, /app\.get\('\/live', /);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'live.html')));
});

test('live page script reads and writes the q parameter', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'live.html'), 'utf8');
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\('q'\)/);
  assert.match(html, /q\.value = new URLSearchParams/);
  assert.match(html, /history\.replaceState\(null, '', '\/live\?' \+ /);
  assert.match(html, /'window=' \+ win/);
  // initial filter is applied before the first fetch (more() runs after the read)
  assert.ok(html.indexOf("get('q')") < html.indexOf('\n  more();'));
});

test('live page sends q and window to the feed server-side and shows the total', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'live.html'), 'utf8');
  assert.match(html, /url \+= '&q=' \+ encodeURIComponent\(v\)/);
  assert.match(html, /'\?limit=50&window=' \+ encodeURIComponent\(win\)/);
  assert.doesNotMatch(html, /li\.hidden|_text/);
  for (const w of ['1d', '2d', '7d']) assert.match(html, new RegExp('data-w="' + w + '"'));
  assert.match(html, /Past day/);
  assert.match(html, /params\.get\('window'\)/);
  assert.match(html, /setTotal\(d\.total\)/);
  assert.match(html, /' sites'/);
  assert.match(html, /function reset\(\)[\s\S]*list\.textContent = ''[\s\S]*more\(\)/);
});

test('live page has an extension dropdown that round-trips through &ext= and the zone parameter', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'live.html'), 'utf8');
  assert.match(html, /<select id="ext"/);
  assert.match(html, /All extensions/);
  assert.match(html, /params\.get\('ext'\)/);
  assert.match(html, /'&ext=' \+ encodeURIComponent\(ext\)/);
  assert.match(html, /url \+= '&zone=' \+ encodeURIComponent\(ext\)/);
  assert.match(html, /setZones\(d\.zones\)/);
  assert.match(html, /PINNED = \['com', 'ai', 'si', 'io', 'bot', 'sh', 'dev'\]/);
  assert.match(html, /counts\[p\] \|\| 0/);
  assert.match(html, /PINNED\.indexOf\(z\.zone\) !== -1\) return/);
  assert.ok(html.indexOf('PINNED.forEach') < html.indexOf('sep.disabled') && html.indexOf('sep.disabled') < html.indexOf('zones.forEach(function (z) {\n      if (PINNED'));
  assert.match(html, /extSel\.addEventListener\('change'[\s\S]*reset\(\)/);
  assert.ok(html.indexOf("get('ext')") < html.indexOf('\n  more();'));
});

test('live page poll prepends only unseen rows from the newest-first first page', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'live.html'), 'utf8');
  const poll = html.slice(html.indexOf('function poll()'), html.indexOf('function reset()'));
  assert.match(poll, /fetchPage\(null\)/);
  assert.match(poll, /!seen\[s\.domain\]/);
  assert.match(poll, /list\.insertBefore\(render\(fresh\[i\], true\), list\.firstChild\)/);
  assert.doesNotMatch(poll, /sort\(/);
});

test('live page shows the body-text match snippet directly under the title', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'live.html'), 'utf8');
  const render = html.slice(html.indexOf('function render('), html.indexOf('function refreshEmpty()'));
  assert.match(render, /line\('s', s\.snippet\)/);
  assert.ok(render.indexOf("line('t', s.title)") < render.indexOf("line('s', s.snippet)"));
  assert.ok(render.indexOf("line('s', s.snippet)") < render.indexOf("line('d', s.description)"));
  // textContent only: the snippet is page text and must never be parsed as HTML.
  assert.match(render, /d\.textContent = text/);
  assert.doesNotMatch(render, /innerHTML/);
  assert.match(html, /\.s\{/);
});

test('live page focuses on Sites and does not start retired Trends work', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'live.html'), 'utf8');
  assert.match(html, /<section id="sites-view">/);
  assert.doesNotMatch(html, /trends-view|data-tab|live-trends|loadTrends/);
  assert.doesNotMatch(source, /createLiveTrendsService|liveTrends\.refresh/);
});
