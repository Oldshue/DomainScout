'use strict';

// 2026-11-12 owner correction: a search returns the sold names where the typed
// word or phrase literally appears (name, site title, description/headings,
// full stored site text); theme matches only in a separate related section.

const test = require('node:test');
const assert = require('node:assert/strict');
const ins = require('../server/sale-watch-insights');

const SITE = { active: true, parked: false, placeholder: false, status: 200 };
const deep = 'Welcome to our studio. '.repeat(10) + 'We also offer bare metal colocation for teams.';
const entry = (domain, hp, extra = {}) => ({ domain, reportDate: '2026-11-12', classification: 'likely-sale', tier: 'probable', evidenceRank: 0, venue: 'Afternic',
  discovery: { homepage: { ...SITE, finalUrl: `https://${domain}/`, ...hp } },
  derived: { tape: 'aftermarket', lead: true, leadReason: 'marketplace exit + registrar transfer', sold: true, soldReason: 'marketplace exit + registrar transfer', words: [], wordPairs: [] }, ...extra });
const ENTRIES = [
  entry('lmwebui.com', { title: 'LM WebUI', description: 'A web interface for local LLM inference', textSample: 'Run models on your own GPU' }),
  entry('rentcompute.io', { title: 'Rent GPU compute by the hour', textSample: 'Cheap cloud compute' }),
  entry('tensorhost.com', { title: 'TensorHost', description: 'Fast inference APIs', textSample: deep }),
  entry('phrasebox.com', { title: 'Phrasebox', textSample: 'machine learning tools; learning machine kits' }),
  entry('xssdemo.com', { title: 'Demo <b>gpu</b> & co' }),
];
const snapshot = () => {
  const searchDocs = {};
  for (const e of ENTRIES) searchDocs[e.domain] = ins.literalSearchDoc(e, []);
  const rows = ENTRIES.map(({ discovery: _d, ...r }) => r);
  return { schema: ins.SNAPSHOT_SCHEMA, status: 'ready', generatedAt: '2026-11-12T12:00:00Z', from: '2026-10-30', to: '2026-11-12', rows, searchDocs };
};
const serve = (s, q) => ins.serveDailyFromSnapshot(s, { from: s.from, to: s.to, tape: 'aftermarket', q });
const hits = page => page.days.flatMap(d => d.rows).map(r => r.domain).sort();

test('compute, gpu and inference return different sets determined by the wording', () => {
  const s = snapshot();
  assert.deepEqual(hits(serve(s, 'compute')), ['rentcompute.io']);
  assert.deepEqual(hits(serve(s, 'gpu')), ['lmwebui.com', 'rentcompute.io', 'xssdemo.com']);
  assert.deepEqual(hits(serve(s, 'inference')), ['lmwebui.com', 'tensorhost.com']);
  assert.ok(!hits(serve(s, 'compute')).includes('lmwebui.com'), 'lmwebui.com does not contain compute');
});

test('a term only deep in the stored body text is found and labelled site text with an excerpt', () => {
  const s = snapshot();
  const page = serve(s, 'colocation');
  const rows = page.days.flatMap(d => d.rows);
  assert.deepEqual(rows.map(r => [r.domain, r.matchedOn]), [['tensorhost.com', 'site text']]);
  assert.equal(rows[0].excerpt.match.toLowerCase(), 'colocation');
  assert.ok(s.rows.every(r => r.search === undefined || !String(JSON.stringify(r)).includes('colocation')), 'full wording is not in the per-row payload');
  assert.ok(!JSON.stringify(page).includes('bare metal colocation for teams.') || rows[0].excerpt, 'only an excerpt is sent');
});

test('a phrase matches only as a phrase; prefix fallback needs 4+ letters', () => {
  const s = snapshot();
  assert.deepEqual(hits(serve(s, 'machine learning')), ['phrasebox.com']);
  assert.deepEqual(hits(serve(s, 'learning tools')), ['phrasebox.com']);
  assert.deepEqual(hits(serve(s, 'tools machine')), []);
  assert.deepEqual(hits(serve(s, 'comput')), ['rentcompute.io'], 'word prefix fallback');
  assert.equal(serve(s, 'comput').matchCounts.matchMode, 'word prefix');
  assert.deepEqual(hits(serve(s, 'com')), [], 'three letters never fall back to a prefix');
});

test('ranking and counts: name, then title, then description, then body; theme rows never mixed in', () => {
  const s = snapshot();
  const page = serve(s, 'gpu');
  const rows = page.days.flatMap(d => d.rows);
  assert.deepEqual(rows.map(r => r.matchRank), [...rows.map(r => r.matchRank)].sort((a, b) => a - b));
  assert.equal(page.matchCounts.name, 0);
  assert.equal(page.matchCounts.site, 3);
  for (const r of page.related || []) assert.ok(!rows.some(x => x.domain === r.domain), 'related rows are never literal rows');
  for (const r of page.related || []) assert.equal(r.matchedOn, 'theme');
  for (const r of rows) assert.notEqual(r.matchedOn, 'theme');
});

test('screen: highlight is escaped; related section labelled; plain message when nothing contains the term', () => {
  const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const source = app.match(/const matchLabel = row => \{[\s\S]*?\n    \};/)[0];
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = serve(snapshot(), 'gpu').days.flatMap(d => d.rows).find(r => r.domain === 'xssdemo.com');
  const html = vm.runInNewContext(`${source}; matchLabel(row)`, { query: 'gpu', row, esc });
  assert.match(html, /matched: site title: "Demo &lt;b&gt;<mark>gpu<\/mark>&lt;\/b&gt; &amp; co"/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(app, /Related by theme \(the word does not appear\)/);
  assert.match(app, /No lead name or site in the past \$\{servedDays\} days contains/);
  assert.match(app, /-day window\./, 'suggests the longer window');
});

test('theme-only: the screen says once, in plain words, that the word does not appear and names the theme', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(src, /Showing names whose site matches the \$\{esc\(data\.relatedTheme \|\| 'related'\)\} theme\./);
  const page = serve(snapshot(), 'accelerator');
  assert.equal(page.matchCounts.literal, 0);
  if (page.related && page.related.length) assert.match(String(page.relatedTheme), /inference/i);
});
