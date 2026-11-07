'use strict';

// Boot must never block on large-table schema work (2026-11-07 outages).
//  1. An injected slow sale_watch.db migration runs off-main while a real HTTP
//     server answers /api/health in under a second, reporting it pending.
//  2. An interrupted (killed) or failed migration is retried and completes.
//  3. The domains.db maintenance child is supervised the same way.
//  4. Static check: no large-table CREATE INDEX / UPDATE / DELETE / backfill
//     on the main-thread boot path of server/db.js or server/index.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const repo = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'slow-migration-child.js');
const migration = require('../server/sale-watch-schema-migration');
const maintenance = require('../server/db-maintenance-child');

const quiet = { log() {}, warn() {} };

function healthServer() {
  // Mirrors server/index.js /api/health: answers from in-memory state only.
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, saleWatchMigration: migration.migrationState(), dbMaintenance: maintenance.dbMaintenanceState() }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function getHealth(port) {
  const t0 = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/health' }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data), ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('health answers in under a second while an injected slow migration is still running, then reports ready', async () => {
  migration._resetForTests();
  const server = await healthServer();
  const { port } = server.address();
  try {
    const done = migration.startSchemaMigration({ dbPath: path.join(os.tmpdir(), 'unused-sale_watch.db'), childFile: FIXTURE, env: { ...process.env, SLOW_MIGRATION_MS: '3000' }, log: quiet });
    assert.equal(migration.isMigrationReady(), false);
    assert.throws(() => migration.assertMigrationReady(), err => err.code === 'SALE_WATCH_MIGRATION_PENDING' && err.migration.status === 'running');
    for (let i = 0; i < 4; i += 1) {
      const h = await getHealth(port);
      assert.equal(h.status, 200);
      assert.ok(h.ms < 1000, `health took ${h.ms}ms`);
      assert.equal(h.body.saleWatchMigration.status, 'running', 'migration still running while health answers');
      await sleep(200);
    }
    const final = await done;
    assert.equal(final.status, 'ready');
    assert.ok(final.durationMs >= 2500, `migration really was slow (${final.durationMs}ms)`);
    const h = await getHealth(port);
    assert.equal(h.body.saleWatchMigration.status, 'ready');
    assert.doesNotThrow(() => migration.assertMigrationReady());
    const waited = await migration.whenMigrationReady();
    assert.equal(waited.ready, true);
  } finally {
    server.close();
    migration._resetForTests();
  }
});

test('a migration interrupted mid-run (child killed) or failing is retried and completes', async () => {
  migration._resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-migration-'));
  // The supervisor's retry timer is unref'd (it must never hold a server open);
  // keep this test's event loop alive while it waits for the retry.
  const keepalive = setInterval(() => {}, 1000);
  try {
    const opts = { dbPath: path.join(dir, 'sale_watch.db'), childFile: FIXTURE, env: { ...process.env, SLOW_MIGRATION_MS: '1500' }, retryBaseMs: 50, log: quiet };
    const ready = migration.whenMigrationReady();
    const first = migration.startSchemaMigration(opts);
    await sleep(300);
    const pid = migration.migrationState().pid;
    assert.ok(pid, 'child pid recorded');
    process.kill(pid, 'SIGKILL'); // a restart/crash in the middle of the migration
    const interrupted = await first;
    assert.equal(interrupted.status, 'failed');
    assert.ok(interrupted.nextRetryAt, 'a retry is scheduled');
    const after = await ready;
    assert.equal(after.status, 'ready');
    assert.equal(after.attempts, 2);

    migration._resetForTests();
    const failFile = path.join(dir, 'failed-once');
    const ready2 = migration.whenMigrationReady();
    const attempt = await migration.startSchemaMigration({ ...opts, env: { ...opts.env, SLOW_MIGRATION_MS: '50', SLOW_MIGRATION_FAIL_FILE: failFile } });
    assert.equal(attempt.status, 'failed');
    assert.match(attempt.error, /injected first-attempt failure/);
    const recovered = await ready2;
    assert.equal(recovered.status, 'ready');
  } finally {
    clearInterval(keepalive);
    migration._resetForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('domains.db maintenance runs in a supervised child after listen; health stays fast meanwhile', async () => {
  maintenance._resetForTests();
  const server = await healthServer();
  const { port } = server.address();
  try {
    let forkedEnv = null;
    const fork = (file, env) => { forkedEnv = env; return require('node:child_process').fork(file, ['--run'], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }); };
    const done = maintenance.startDbMaintenance({ childFile: FIXTURE, fork, env: { ...process.env, SLOW_MIGRATION_MS: '1500' }, log: quiet });
    assert.equal(forkedEnv.DOMAINSCOUT_DEFER_DB_MAINTENANCE, '0', 'the child runs the deferred maintenance itself');
    const h = await getHealth(port);
    assert.ok(h.ms < 1000);
    assert.equal(h.body.dbMaintenance.status, 'running');
    const final = await done;
    assert.equal(final.status, 'done');
  } finally {
    server.close();
    maintenance._resetForTests();
  }
});

// ── Static check ────────────────────────────────────────────────────────────
const LARGE_TABLE_SQL = [
  /CREATE\s+(UNIQUE\s+)?INDEX[^;]*\bON\s+(domains|drop_events|sale_watch_\w+)\s*\(/i,
  /\bUPDATE(\s+OR\s+\w+)?\s+(domains|drop_events|sale_watch_\w+)\b/i,
  /\bDELETE\s+FROM\s+(domains|drop_events|sale_watch_\w+)\b/i,
  /FROM\s+drop_events\s+GROUP\s+BY/i,
  /VALUES\s*\(\s*'rebuild'\s*\)/i,
];
function templates(src) {
  const out = [];
  const re = /(\w+(?:\.\w+)?)\(`([\s\S]*?)`\)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ callee: m[1], sql: m[2], index: m.index });
  return out;
}
function regions(src, opener) {
  const out = [];
  let i = src.indexOf(opener);
  while (i !== -1) {
    const end = src.indexOf('\n});\n', i);
    assert.notEqual(end, -1, `unterminated ${opener}`);
    out.push([i, end]);
    i = src.indexOf(opener, end);
  }
  return out;
}

test('static: server/db.js runs large-table CREATE INDEX / UPDATE / DELETE / backfills only through deferrable helpers', () => {
  const src = fs.readFileSync(path.join(repo, 'server/db.js'), 'utf8');
  const heavy = regions(src, 'runHeavy(() => {');
  assert.ok(heavy.length >= 2, 'expected runHeavy blocks for the backfills and the dedc setup');
  // The FTS build/catch-up block is guarded by _domainFtsMaintenanceEnabled, which
  // includes !deferHeavyMaintenance (asserted below), so it is off-main too.
  const ftsOpener = 'if (_domainFtsReady && _domainFtsMaintenanceEnabled) {';
  const ftsAt = src.indexOf(ftsOpener);
  assert.notEqual(ftsAt, -1, 'expected the guarded FTS build block');
  heavy.push([ftsAt, src.indexOf('\n}\n', ftsAt)]);
  const inHeavy = idx => heavy.some(([a, b]) => idx > a && idx < b);
  const offenders = [];
  for (const t of templates(src)) {
    const statements = t.sql.replace(/--[^\n]*/g, '').split(';');
    for (const st of statements) {
      if (!LARGE_TABLE_SQL.some(re => re.test(st))) continue;
      if (t.callee === 'execBootSchema' && !/^\s*CREATE\s+(VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS/i.test(st)) continue; // dropped in deferred mode
      if (inHeavy(t.index)) continue;
      offenders.push(`${t.callee}(...): ${st.trim().split('\n')[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'large-table SQL on the main-thread boot path; wrap it in execBootSchema or runHeavy');
  assert.match(src, /const _domainFtsMaintenanceEnabled =[^;]*!deferHeavyMaintenance/, 'FTS rebuild/catch-up must be deferred');
  assert.match(src, /if \(!process\.env\.DOMAINSCOUT_SKIP_DB_MAINTENANCE && !deferHeavyMaintenance\)/, 'PRAGMA optimize must be deferred');
  assert.match(src, /cheapSchemaStatements[\s\S]*CREATE\\s\+\(VIRTUAL\\s\+\)\?TABLE\\s\+IF\\s\+NOT\\s\+EXISTS/, 'deferred mode keeps only CREATE TABLE IF NOT EXISTS');
});

test('static: server/index.js does no sale_watch.db schema work or large-table SQL before listen, and defers db.js maintenance', () => {
  const src = fs.readFileSync(path.join(repo, 'server/index.js'), 'utf8');
  const listenAt = src.indexOf('\napp.listen(PORT');
  assert.notEqual(listenAt, -1);
  const beforeListen = src.slice(0, listenAt);
  // Top-level (column-0) statements run at boot; indented code runs in routes, timers or functions.
  const topLevel = beforeListen.split('\n').filter(line => /^\S/.test(line) && !/^\s*\/\//.test(line));
  const bootCalls = topLevel.filter(line => /\b(getSaleWatchReconDb|ensureReconstructionSchema|ensureAssessmentSchema|ensureAssessmentVersion|ensureIntakeBackfill)\(/.test(line) && !/^(async\s+)?function\b/.test(line));
  assert.deepEqual(bootCalls, [], 'sale_watch.db schema/backfill work must run in the off-main migration child after listen');
  const getter = src.slice(src.indexOf('function getSaleWatchReconDb() {'), src.indexOf('\n}\n', src.indexOf('function getSaleWatchReconDb() {')));
  assert.match(getter, /assertMigrationReady\(\)/);
  assert.doesNotMatch(getter, /ensure\w*Schema\(/, 'the main-thread handle must not run schema work');
  const offenders = [];
  for (const t of templates(beforeListen)) {
    const lineStart = beforeListen.lastIndexOf('\n', t.index) + 1;
    if (/^\s/.test(beforeListen.slice(lineStart, t.index + 1))) continue; // inside a function/route
    for (const st of t.sql.split(';')) if (LARGE_TABLE_SQL.some(re => re.test(st))) offenders.push(st.trim().split('\n')[0]);
  }
  assert.deepEqual(offenders, [], 'large-table SQL at the top level of server/index.js');
  const requireDb = src.indexOf("const db = require('./db');");
  assert.ok(src.lastIndexOf("process.env.DOMAINSCOUT_DEFER_DB_MAINTENANCE = '1'", requireDb) !== -1, 'db.js must be required with heavy maintenance deferred');
  const listenBody = src.slice(listenAt, listenAt + 800);
  assert.match(listenBody, /startDbMaintenance\(\)/);
  assert.match(listenBody, /startSchemaMigration\(/);
});
