'use strict';

// Richer page text for live-sites search: extraction, body-text q matching with
// a snippet, backfill behaviour for rows without text, and per-day cache cost.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ls = require('../server/live-sites');
const { createLiveSitesFeed, SNIPPET_CHARS } = require('../server/live-sites-feed');

const PAGE = `<!doctype html><html><head><title>Acme Bakery</title>
<meta name="description" content="Fresh bread daily">
<script>var secretScriptToken = 1;</script><style>.hiddenStyleToken{color:red}</style></head>
<body><nav>Home About navonlyword Contact</nav>
<header><h1>Sourdough every morning</h1></header>
<section><h2>Our ovens</h2><p>We bake</p><p>rye loaves</p><h4>notaheading</h4></section>
<noscript>noscriptToken</noscript>
<footer>Copyright footeronlyword</footer></body></html>`;

test('extractSearchText keeps title, description, headings and visible body; strips scripts, styles, nav and footer', () => {
  const text = ls.extractSearchText(PAGE);
  for (const want of ['Acme Bakery', 'Fresh bread daily', 'Sourdough every morning', 'Our ovens', 'We bake rye loaves']) assert.ok(text.includes(want), want);
  for (const gone of ['secretScriptToken', 'hiddenStyleToken', 'navonlyword', 'footeronlyword', 'noscriptToken']) assert.ok(!text.includes(gone), gone);
  assert.doesNotMatch(text, /\s{2,}/, 'whitespace collapsed');
  assert.ok(!text.includes('bakerye'), 'adjacent blocks do not glue words');
});

test('extractSearchText caps body text and total size', () => {
  const big = `<html><head><title>T</title></head><body>${'<h2>' + 'heading '.repeat(40) + '</h2>'}${'<p>' + 'word '.repeat(20000) + '</p>'}</body></html>`;
  const text = ls.extractSearchText(big);
  assert.ok(text.length <= ls.SEARCH_TEXT_MAX, `total ${text.length}`);
  assert.ok(ls.extractSearchText(`<body><p>${'word '.repeat(20000)}</p></body>`).length <= ls.SEARCH_BODY_CHARS);
});

test('classified observations carry bounded text on the record (not in the public item)', () => {
  const fetched = { ok: true, status: 200, finalUrl: 'https://acme-bakery.com/', html: PAGE.replace('We bake', 'We bake '.repeat(40)), requestedUrl: 'https://acme-bakery.com/', hops: [] };
  const classified = ls.classifyObservation({ domain: 'acme-bakery.com', fetched });
  assert.ok(classified.searchText.includes('rye loaves'));
});

function rec(day, domain, extra = {}) {
  return {
    domain, zone: domain.slice(domain.lastIndexOf('.') + 1), day, class: 'built', reason: 'operating_site', status: 200,
    url: `https://${domain}/`, finalUrl: `https://${domain}/`, title: `${domain.split('.')[0]} Studio`, description: 'Independent studio',
    titleReal: true, spam: false, kit: null, observedAt: `${day}T09:00:00.000Z`, version: 'live-sites-classifier-v1', ...extra,
  };
}

async function feedWith(t, rows) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-search-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dir = path.join(directory, '2026-10-20', 'sites');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'observations.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ day: '2026-10-20', status: 'complete' }));
  return createLiveSitesFeed({ universeDir: directory });
}

test('q matches body text case-insensitively with a ~160-char snippet; domain/title/description matches carry none; old rows still match', async t => {
  const long = `${'Lorem ipsum dolor sit amet. '.repeat(20)}We handcraft Walnut Furniture for small apartments. ${'Consectetur adipiscing elit. '.repeat(20)}`;
  const feed = await feedWith(t, [
    rec('2026-10-20', 'oak.com', { text: `oak Studio | Independent studio | ${long}` }),
    rec('2026-10-20', 'walnut.com', { text: 'walnut Studio | nothing else' }),
    rec('2026-10-20', 'legacy.com', { description: 'Walnut tables' }), // pre-text row on disk
    rec('2026-10-20', 'plain.com'),
  ]);
  const out = await feed.query({ q: 'WALNUT furniture', window: '7d' });
  assert.deepEqual(out.items.map(i => i.domain), ['oak.com']);
  const snippet = out.items[0].snippet;
  assert.ok(snippet.toLowerCase().includes('walnut furniture'));
  assert.ok(snippet.length <= SNIPPET_CHARS + 2, `snippet ${snippet.length}`);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
  const walnut = await feed.query({ q: 'walnut', window: '7d' });
  assert.deepEqual(walnut.items.map(i => i.domain).sort(), ['legacy.com', 'oak.com', 'walnut.com']);
  for (const item of walnut.items) {
    if (item.domain === 'oak.com') assert.ok(item.snippet);
    else assert.equal('snippet' in item, false, item.domain);
  }
  const all = await feed.query({ window: '7d' });
  for (const item of all.items) {
    assert.deepEqual(Object.keys(item).sort(), ['day', 'description', 'domain', 'observedAt', 'title', 'url', 'zone']);
  }
  assert.ok(!JSON.stringify(all).includes('Lorem'), 'stored text is not exposed without a body match');
});

test('haystacks are built once per cache load; repeated queries reuse them', async t => {
  const rows = Array.from({ length: 200 }, (_, i) => rec('2026-10-20', `site${i}.com`, { title: `Shop number ${i}`, text: `Shop number ${i} | bespoke widget ${i}` }));
  const feed = await feedWith(t, rows);
  for (const q of ['widget', 'bespoke', 'shop', 'nothing', '']) await feed.query({ q, window: '7d' });
  const stats = feed.cacheStats();
  assert.equal(stats.loads, 1);
  assert.equal(stats.haystacks, 200);
});
