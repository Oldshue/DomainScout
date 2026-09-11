'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySite } = require('../server/site-evidence');
const { inspectHomepage } = require('../server/sale-watch-discovery');

function fetchImplFor(html, { status = 200 } = {}) {
  return async (url) => ({ ok: status >= 200 && status < 300, status, url: String(url), text: async () => html });
}

function inspectVia(html, opts = {}) {
  const fetchImpl = fetchImplFor(html, opts);
  return (domain) => inspectHomepage(domain, fetchImpl);
}

test('empty <title> with og:title falls back to the og title and classifies built', async () => {
  const html = '<html><head><title></title><meta property="og:title" content="Acme Widgets"></head><body><p>Welcome to our storefront.</p></body></html>';
  const result = await classifySite('example.com', { inspect: inspectVia(html) });
  assert.equal(result.status, 'built');
  assert.equal(result.title, 'Acme Widgets');
});

test('empty <title> with no fallback markup but substantial visible text classifies built using the text sample as summary', async () => {
  const bodyText = 'This is a fully custom single page application shell rendered entirely client-side with no static title tag content present in the markup at all.';
  const html = `<html><head><title></title></head><body><div id="root"><p>${bodyText}</p></div></body></html>`;
  const result = await classifySite('example.com', { inspect: inspectVia(html) });
  assert.equal(result.status, 'built');
  assert.equal(result.title, null);
  assert.ok(result.summary && result.summary.length >= 80, `expected substantial summary, got: ${JSON.stringify(result.summary)}`);
});

test('empty page with no fallback title and no substantial text classifies unknown', async () => {
  const html = '<html><head><title></title></head><body></body></html>';
  const result = await classifySite('example.com', { inspect: inspectVia(html) });
  assert.equal(result.status, 'unknown');
  assert.equal(result.title, null);
});

test('existing parked/for-sale detection is unchanged by the fallback-title logic', async () => {
  const html = '<html><head><title>Domain For Sale</title></head><body><p>This domain is for sale. Buy this domain now via our marketplace partner.</p></body></html>';
  const result = await classifySite('example.com', { inspect: inspectVia(html) });
  assert.equal(result.status, 'for-sale');
  assert.equal(result.title, 'Domain For Sale');
});
