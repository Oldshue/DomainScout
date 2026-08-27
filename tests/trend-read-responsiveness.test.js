'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must remain discoverable`);
  return source.slice(start, end);
}

test('cold analytical trend reads use the shared read-only worker and async cache boundary', () => {
  const observedTlds = sourceBetween('async function getObservedTldTrends', 'function mergeTldTrendRows');
  const observedKeywords = sourceBetween('async function getObservedKeywordTrends', 'function mergeKeywordTrendRows');
  const routes = sourceBetween("app.get('/api/trends'", "app.get('/api/trend-keyword'");

  assert.match(observedTlds, /await dbReadQuery/);
  assert.match(observedKeywords, /await dbReadQuery/);
  assert.doesNotMatch(observedTlds, /db\.prepare/);
  assert.doesNotMatch(observedKeywords, /db\.prepare/);
  assert.match(routes, /await serveCachedTrend/);
  assert.match(routes, /await getObservedKeywordTrends/);
});

test('unrelated warehouse analytics cannot monopolize the caller event loop', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-read-worker-'));
  const dbPath = path.join(tempDir, 'domains.db');
  const database = new Database(dbPath);
  database.exec('CREATE TABLE warehouse_events(category TEXT NOT NULL); INSERT INTO warehouse_events VALUES (\'shop\'), (\'shop\'), (\'dev\');');
  database.close();

  const worker = new Worker(path.join(root, 'server', 'db-read-worker.js'), { workerData: { dbPath } });
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats += 1; }, 1);
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', resolve);
      worker.postMessage({
        id: 1,
        sql: `WITH RECURSIVE load(x) AS (
          SELECT 1 UNION ALL SELECT x + 1 FROM load WHERE x < 750000
        )
        SELECT category, COUNT(*) AS event_count, (SELECT SUM(x) FROM load) AS proof
        FROM warehouse_events GROUP BY category ORDER BY category`,
        params: {},
      });
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rows.map(row => [row.category, row.event_count]), [['dev', 1], ['shop', 2]]);
    assert.ok(heartbeats > 0, 'caller timers must run while the analytical query executes');
  } finally {
    clearInterval(timer);
    await worker.terminate();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
