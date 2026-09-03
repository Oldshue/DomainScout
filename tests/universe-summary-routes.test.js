'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const express = require('express');
const { registerUniverseSummaryRoutes } = require('../server/universe-summary-routes');

function makeStubSummary() {
  const calls = [];
  return {
    calls,
    spawnUniverseSummaryImport: async args => {
      calls.push(args);
      return { day: args.day };
    },
    openUniverseSummary: () => ({
      status: () => ({ source: 'universe-summary', day: '2026-09-03' }),
    }),
  };
}

async function withServer(opts, fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'us-routes-'));
  const summary = makeStubSummary();
  const env = Object.assign({ DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: 'universe-summary-test-token' }, opts.env || {});
  const app = express();
  registerUniverseSummaryRoutes(app, { dataDir, summary, env, log: { log() {}, error() {} } });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on('error', reject);
  });
  const port = server.address().port;
  try {
    await fn({ dataDir, summary, port });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function request(port, method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('bad token -> 401', async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port, 'POST', '/api/universe/summary/import?day=2026-09-03&token=wrong-token', {}, Buffer.from('x'));
    assert.equal(res.status, 401);
  });
});

test('bad day -> 400', async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port, 'POST', '/api/universe/summary/import?day=notaday&token=universe-summary-test-token', {}, Buffer.from('x'));
    assert.equal(res.status, 400);
  });
});

test('stores gzip body byte-identical and spawns import', async () => {
  await withServer({}, async ({ port, dataDir, summary }) => {
    const gz = zlib.gzipSync(Buffer.from('hello universe summary'));
    const res = await request(port, 'POST', '/api/universe/summary/import?day=2026-09-03&token=universe-summary-test-token', { 'Content-Length': gz.length }, gz);
    assert.equal(res.status, 202);
    assert.equal(res.json.importing, true);
    const finalPath = path.join(dataDir, 'universe-summary', 'universe-summary-2026-09-03.tsv.gz');
    const stored = await fs.readFile(finalPath);
    assert.ok(stored.equals(gz));
    assert.equal(summary.calls.length, 1);
    assert.equal(summary.calls[0].tapePath, finalPath);
  });
});

test('import=0 stores without spawning', async () => {
  await withServer({}, async ({ port, dataDir, summary }) => {
    const gz = zlib.gzipSync(Buffer.from('no import please'));
    const res = await request(port, 'POST', '/api/universe/summary/import?day=2026-09-04&token=universe-summary-test-token&import=0', { 'Content-Length': gz.length }, gz);
    assert.equal(res.status, 202);
    assert.equal(res.json.importing, false);
    assert.equal(summary.calls.length, 0);
    const finalPath = path.join(dataDir, 'universe-summary', 'universe-summary-2026-09-04.tsv.gz');
    await fs.access(finalPath);
  });
});

test('status route lists tape and summary status', async () => {
  await withServer({}, async ({ port, dataDir }) => {
    const gz = zlib.gzipSync(Buffer.from('status test'));
    await request(port, 'POST', '/api/universe/summary/import?day=2026-09-05&token=universe-summary-test-token&import=0', { 'Content-Length': gz.length }, gz);
    const res = await request(port, 'GET', '/api/universe/summary/status', {});
    assert.equal(res.status, 200);
    assert.equal(res.json.summary.source, 'universe-summary');
    assert.ok(res.json.tapes.some(t => t.day === '2026-09-05'));
  });
});

test('body over max bytes -> 413, no leftover file', async () => {
  await withServer({ env: { DOMAINSCOUT_UNIVERSE_SUMMARY_MAX_BYTES: '4' } }, async ({ port, dataDir }) => {
    const body = Buffer.from('this body is way over four bytes');
    const res = await request(port, 'POST', '/api/universe/summary/import?day=2026-09-06&token=universe-summary-test-token', { 'Content-Length': body.length }, body);
    assert.equal(res.status, 413);
    const finalPath = path.join(dataDir, 'universe-summary', 'universe-summary-2026-09-06.tsv.gz');
    await assert.rejects(fs.access(finalPath));
    await assert.rejects(fs.access(`${finalPath}.part`));
  });
});
