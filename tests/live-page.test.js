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
  assert.match(html, /history\.replaceState\(null, '', v \? '\/live\?q=' \+ encodeURIComponent\(v\) : '\/live'\)/);
  assert.match(html, /setTimeout\(syncUrl, \d+\)/);
  // initial filter is applied before the first fetch (more() runs after the read)
  assert.ok(html.indexOf("get('q')") < html.indexOf('\n  more();'));
});
