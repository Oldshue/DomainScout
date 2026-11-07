'use strict';

// An empty windowed search reports how many matches the longer windows hold
// ("No matches in the past week · 41 in the past 30 days"). The count is a
// bounded read over the stored views table. Uses node:sqlite so it runs
// without the better-sqlite3 native binding.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const store = require('../server/sale-watch-assessments');

const NOW = '2026-11-07T10:00:00.000Z';

function db(rows) {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE ${store.VIEWS_TABLE} (view TEXT NOT NULL, report_date TEXT NOT NULL, evidence_rank INTEGER NOT NULL, dlen INTEGER NOT NULL, domain TEXT NOT NULL, PRIMARY KEY (view, report_date DESC, evidence_rank, dlen, domain)) WITHOUT ROWID`);
  const ins = d.prepare(`INSERT INTO ${store.VIEWS_TABLE} (view, report_date, evidence_rank, dlen, domain) VALUES (?, ?, 1, ?, ?)`);
  for (const [view, day, domain] of rows) ins.run(view, day, domain.length, domain);
  return d;
}

test('wider windows: counts matches per longer page window, newest window first excluded', () => {
  const d = db([
    ['probable', '2026-11-03', 'orchardfarm.com'],
    ['probable', '2026-10-20', 'orchardlane.com'],
    ['probable', '2026-10-12', 'orchardhill.io'],
    ['probable', '2026-09-01', 'orchardold.com'],
    ['probable', '2026-10-20', 'unrelated.com'],
    ['excluded', '2026-10-21', 'orchardparked.com'],
  ]);
  const counts = store.widerWindowMatchCounts(d, { view: 'probable', needle: 'orchard', days: 2, now: NOW });
  assert.deepEqual(counts, [{ days: 7, count: 1 }, { days: 30, count: 3 }]);
  assert.deepEqual(store.widerWindowMatchCounts(d, { view: 'probable', needle: 'orchard', days: 7, now: NOW }), [{ days: 30, count: 3 }]);
  assert.deepEqual(store.widerWindowMatchCounts(d, { view: 'probable', needle: 'orchard', days: 30, now: NOW }), [], 'no longer window to offer');
  assert.deepEqual(store.widerWindowMatchCounts(d, { view: 'probable', needle: 'zzzzz', days: 7, now: NOW }), [{ days: 30, count: 0 }]);
  assert.deepEqual(store.widerWindowMatchCounts(d, { view: 'probable', needle: '', days: 7, now: NOW }), []);
});

test('wider windows: an unrelated prefix fixture behaves the same (no hard-coded vocabulary)', () => {
  const d = db([['probable', '2026-10-25', 'quillnest.com'], ['probable', '2026-10-26', 'quillpath.com']]);
  assert.deepEqual(store.widerWindowMatchCounts(d, { view: 'probable', needle: 'quill', days: 7, now: NOW }), [{ days: 30, count: 2 }]);
});
