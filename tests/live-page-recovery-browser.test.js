'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-core');

const CHROME = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'live.html'), 'utf8');

function instrumentedHtml(timeoutMs = 80) {
  const setup = `<script>window.__DOMAINSCOUT_LIVE_REQUEST_TIMEOUT_MS=${timeoutMs};window.__DOMAINSCOUT_LIVE_RECOVERY_DELAYS_MS=[30];</script>\n<script>\n(function () {`;
  return source.replace('<script>\n(function () {', setup);
}

function payload(domain = 'recovered.example') {
  return JSON.stringify({
    items: [{ domain, url: `https://${domain}`, title: 'Recovered', day: '2026-11-15', zone: 'example' }],
    total: 1,
    nextCursor: null,
    zones: [{ zone: 'example', count: 1 }, { zone: 'com', count: 1 }],
    live: { status: 'live' },
    progress: [],
  });
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

test('live page deadlines recover stalled headers and bodies without a click', { skip: !fs.existsSync(CHROME) }, async () => {
  for (const mode of ['headers', 'body']) {
      let calls = 0;
      let closed = false;
      const server = await listen((req, res) => {
        if (req.url.startsWith('/live')) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(instrumentedHtml());
          return;
        }
        if (req.url.startsWith('/api/public/live-sites')) {
          calls += 1;
          if (calls === 1) {
            req.on('close', () => { closed = true; });
            if (mode === 'body') {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.write('{"items":[');
            }
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(payload());
          return;
        }
        res.writeHead(404); res.end();
      });
      const browser = await chromium.launch({ headless: true, executablePath: CHROME });
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}/live?window=2d`);
        await page.waitForSelector('#list li', { timeout: 3000 });
        assert.equal(await page.locator('#count').textContent(), '1 site');
        assert.equal(await page.locator('#list li').count(), 1);
        assert.equal(await page.locator('#retry').isHidden(), true);
        assert.equal(calls, 2, `${mode} recovery should issue one backpressured probe`);
        assert.equal(closed, true, `${mode} request should be cancelled at its deadline`);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
        await browser.close();
        await closeServer(server);
      }
  }
});

test('live page navigation cancels a stalled request and renders only the new scope', { skip: !fs.existsSync(CHROME) }, async () => {
  let calls = 0;
  let firstClosed = false;
  const requested = [];
  const server = await listen((req, res) => {
    if (req.url.startsWith('/live')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(instrumentedHtml(5000));
      return;
    }
    if (req.url.startsWith('/api/public/live-sites')) {
      calls += 1;
      requested.push(req.url);
      if (calls === 1) {
        req.on('close', () => { firstClosed = true; });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload('alpha.example'));
      return;
    }
    res.writeHead(404); res.end();
  });
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/live?window=2d`);
    await page.locator('#q').fill('alpha');
    await page.waitForSelector('#list li', { timeout: 3000 });
    assert.equal(await page.locator('#list').textContent().then(text => text.includes('alpha.example')), true);
    assert.equal(firstClosed, true);
    assert.equal(calls, 2);
    assert.match(requested[1], /[?&]q=alpha(?:&|$)/);
    assert.equal(await page.locator('#retry').isHidden(), true);
  } finally {
    await page.close();
    await browser.close();
    await closeServer(server);
  }
});

test('widening the live window retains verified rows while a cold week request recovers', { skip: !fs.existsSync(CHROME) }, async () => {
  let weekCalls = 0;
  const server = await listen((req, res) => {
    if (req.url.startsWith('/live')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(instrumentedHtml());
      return;
    }
    if (req.url.startsWith('/api/public/live-sites')) {
      if (req.url.includes('window=7d')) {
        weekCalls += 1;
        if (weekCalls === 1) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload('weekly.example'));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload('recent.example'));
      return;
    }
    res.writeHead(404); res.end();
  });
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/live?window=2d`);
    await page.waitForSelector('text=recent.example');
    await page.locator('button[data-w="7d"]').click();
    await page.waitForTimeout(30);
    assert.match(await page.locator('#count').textContent(), /Showing verified sites/);
    assert.equal(await page.locator('text=recent.example').count(), 1);
    await page.waitForSelector('text=weekly.example', { timeout: 3000 });
    assert.equal(weekCalls, 2);
    assert.equal(await page.locator('#retry').isHidden(), true);
  } finally {
    await page.close();
    await browser.close();
    await closeServer(server);
  }
});
