'use strict';

// Process-backed read lanes (server/db-read-process.js): a statement past its
// deadline dies with its process, so its WAL read snapshot is released and a
// checkpoint can reset the log. A thread-backed worker cannot do this:
// better-sqlite3 cannot cancel a running statement.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createDbReadPool } = require('../server/db-read-pool');
const { createProcessWorker } = require('../server/db-read-process');

const WORKER = path.join(__dirname, '..', 'server', 'db-read-worker.js');
// Runs for minutes if nothing stops it.
const ENDLESS = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000000000) SELECT COUNT(*) AS c FROM n, t';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise(r => setTimeout(r, 25)); }
  return check();
}

test('a read past its deadline is killed with its process and no longer pins the WAL', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-read-process-'));
  const dbPath = path.join(dir, 'lane.db');
  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const insert = writer.prepare('INSERT INTO t (v) VALUES (?)');
  writer.transaction(() => { for (let i = 0; i < 200; i += 1) insert.run('x'.repeat(200)); })();
  const created = [];
  const pool = createDbReadPool({
    laneFor: (_sql, hint) => hint || 'lane',
    createWorker: () => { const w = createProcessWorker(WORKER, { workerData: { dbPath } }); created.push(w); return w; },
  });
  t.after(async () => {
    await Promise.all(created.map(w => w.terminate()));
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // An ordinary read answers through the forked worker.
  assert.deepEqual(await pool.query('SELECT COUNT(*) AS c FROM t', {}, 10000, 'lane'), [{ c: 200 }]);
  assert.equal(created.length, 1);
  const first = created[0];
  assert.ok(alive(first.pid));

  // The endless read holds a snapshot: while it runs, a checkpoint cannot finish.
  const hung = pool.query(ENDLESS, {}, 600, 'lane').then(() => 'answered', error => error.message);
  await new Promise(r => setTimeout(r, 250));
  writer.transaction(() => { for (let i = 0; i < 200; i += 1) insert.run('y'.repeat(200)); })();
  assert.equal(writer.pragma('wal_checkpoint(TRUNCATE)')[0].busy, 1, 'the running read pins the log');

  assert.equal(await hung, 'db-read-worker-timeout');
  assert.ok(await until(() => !alive(first.pid)), 'the timed-out worker process is gone');
  assert.equal(writer.pragma('wal_checkpoint(TRUNCATE)')[0].busy, 0, 'the snapshot went with the process');
  assert.equal(fs.statSync(`${dbPath}-wal`).size, 0);

  // The lane keeps serving on a replacement process.
  assert.deepEqual(await pool.query('SELECT COUNT(*) AS c FROM t', {}, 10000, 'lane'), [{ c: 400 }]);
  assert.equal(created.length, 2);
  assert.notEqual(created[1].pid, first.pid);
});

test('a worker process that dies on its own fails only its running read and the lane respawns', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-read-process-'));
  const dbPath = path.join(dir, 'lane.db');
  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL');
  writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES (\'a\')');
  const created = [];
  const pool = createDbReadPool({
    laneFor: (_sql, hint) => hint || 'lane',
    createWorker: () => { const w = createProcessWorker(WORKER, { workerData: { dbPath } }); created.push(w); return w; },
  });
  t.after(async () => {
    await Promise.all(created.map(w => w.terminate()));
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await pool.query('SELECT v FROM t', {}, 10000, 'lane'), [{ v: 'a' }]);
  const running = pool.query(ENDLESS, {}, 30000, 'lane').then(() => 'answered', error => error.message);
  await new Promise(r => setTimeout(r, 200));
  process.kill(created[0].pid, 'SIGKILL');
  assert.equal(await running, 'db-read-worker-exit');
  assert.deepEqual(await pool.query('SELECT v FROM t', {}, 10000, 'lane'), [{ v: 'a' }]);
  assert.equal(created.length, 2);
});
