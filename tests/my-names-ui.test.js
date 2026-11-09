'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
const myCss = css.slice(css.indexOf('My names: new extensions'));

test('My names is a stream tab with its own tool panel', () => {
  assert.match(html, /data-stream="_mynames" onclick="app\.setStream\('_mynames'\)"[^>]*>\s*◎ My names/);
  assert.match(html, /<section id="my-names-panel"[^>]*style="display:none"/);
  for (const id of ['my-names-rollup', 'my-names-feed', 'my-names-window', 'my-names-ext', 'my-names-search', 'my-names-input', 'my-names-save']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.indexOf('id="my-names-rollup"') < html.indexOf('id="my-names-feed"'), 'rollup must lead the feed');
  assert.match(app, /_toolPanels: \[[^\]]*'_mynames'/);
  assert.match(app, /getElementById\('my-names-panel'\)\.style\.display = 'none'/);
  assert.match(app, /if \(stream === '_mynames'\)/);
});

test('My names reads the owner-names API and saves by bulk replace', () => {
  assert.ok(app.includes("'/api/owner-names/matches?'"));
  assert.ok(app.includes("'/api/owner-names/rollup?'"));
  assert.match(app, /'\/api\/owner-names', \{ method: 'PUT', headers: \{ 'content-type': 'text\/plain' \}/);
});

test('My names links out safely and shows an empty state with a paste-in path', () => {
  assert.match(app, /target="_blank" rel="noopener noreferrer"/);
  assert.match(app, /esc\(item\.domain\)/);
  assert.match(app, /esc\(ext\.url\)/);
  assert.match(app, /No names yet\. Paste your \.com and \.ai names/);
  assert.match(app, /app\.toggleMyNamesEditor\(true\)/);
});

test('My names CSS uses existing palette and phone-safe tap targets', () => {
  assert.ok(myCss.length > 100, 'My names CSS block present');
  assert.doesNotMatch(myCss, /#[0-9a-fA-F]{3,8}\b/, 'no new hex colors');
  assert.doesNotMatch(myCss, /rgba?\(/, 'no new rgb colors');
  assert.match(myCss, /\.my-names-domain \{[^}]*min-height: 44px/);
  assert.match(myCss, /\.my-names-exts a \{[^}]*min-height: 44px; min-width: 44px/);
  assert.match(myCss, /\.my-names-toolbar input, \.my-names-toolbar select, \.my-names-toolbar \.btn \{ min-height: 44px/);
  assert.match(myCss, /@media \(max-width: 600px\)/);
  assert.doesNotMatch(myCss, /(?<![-\w])width:\s*\d{3,}px/, 'no fixed wide widths');
  assert.match(myCss, /overflow-wrap: anywhere/);
});
