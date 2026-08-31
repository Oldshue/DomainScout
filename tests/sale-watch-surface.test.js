'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

test('Sale Watch is a first-class visible DomainScout navigation surface', () => {
  assert.match(html, /data-stream="_salewatch"[^>]*>\s*◉ Sale Watch/);
  assert.match(html, /id="sale-watch-panel"[\s\S]*id="sale-watch-title">Sale Watch/);
  assert.match(app, /_toolPanels: \[[^\]]*'_salewatch'/);
  assert.match(app, /if \(stream === '_salewatch'\)[\s\S]*this\.showSaleWatchPanel\(\)/);
});

test('Sale Watch launch is project-pinned, provider-generic, and opens outside the native app', () => {
  const link = html.match(/<a class="btn sale-watch-open"([^>]+)>/u)?.[1] || '';
  assert.match(link, /project=proj_e6a1f9bbad00aeac/);
  assert.match(link, /resourceProvider=public\.monitoring/);
  assert.match(link, /resourceAction=manage/);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener"/);
});

test('Sale Watch surface remains usable at MacBook and narrow widths', () => {
  assert.match(css, /\.sale-watch-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.sale-watch-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.sale-watch-panel\s*\{[^}]*overflow-y:\s*auto/);
});
