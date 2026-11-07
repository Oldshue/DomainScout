'use strict';

// Real boot of server/index.js (2026-11-07 outage regression). It uses a fresh
// Railway-style volume, so the Sale Watch reconstruction lane is enabled. An
// injected hook holds the real off-main sale_watch.db migration for several
// seconds. While it runs, the HTTP server must already answer /api/health in
// under a second and report the migration as running. A page read must answer,
// and the freshness route must report the migration as pending (a contract
// reply, so the watchdog never restarts for it). Afterwards health must report
// ready. The test needs the better-sqlite3 native binding and skips without it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
const HOOK = path.join(__dirname, 'fixtures', 'slow-migration-hook.js');
const HOOK_MS = 6000;

let bindingError = null;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (error) {
  bindingError = error;
}

function get(port, p) {
  const t0 = process.hrtime.bigint();
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, body }));
    });
    req.on('error', error => resolve({ error: error.code || error.message, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = s => { try { return JSON.parse(s); } catch (_) { return null; } };

test('real server/index.js answers health <1s and reports Sale Watch pending while the boot migration is still running', { timeout: 90000 }, async t => {
  if (bindingError) { t.skip(`better-sqlite3 native binding unavailable: ${bindingError.message.split('\n')[0]}`); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-realboot-'));
  const baseEnv = { ...process.env, RAILWAY_VOLUME_MOUNT_PATH: dir, DOMAINSCOUT_UNIVERSE_DIR: path.join(dir, 'universe') };
  delete baseEnv.DOMAINSCOUT_SKIP_DB_MAINTENANCE;
  delete baseEnv.DOMAINSCOUT_DEFER_DB_MAINTENANCE;
  delete baseEnv.DOMAINSCOUT_SALE_WATCH_RECON_ENABLED;
  // An existing domains.db, so the server takes the deferred-maintenance path.
  const seed = spawnSync(process.execPath, ['-e', "const db=require('./server/db'); const ins=db.prepare('INSERT OR IGNORE INTO domains(domain,tld,stream) VALUES (?,?,?)'); for (let i=0;i<500;i++) ins.run('n'+i+'.com','com','x'); db.close();"], { cwd: repo, env: { ...baseEnv, DOMAINSCOUT_DEFER_DB_MAINTENANCE: '0' }, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);

  const port = 46000 + Math.floor(Math.random() * 3000);
  const env = { ...baseEnv, PORT: String(port), DOMAINSCOUT_SALE_WATCH_WAVE_TEST_HOOKS: '1', DOMAINSCOUT_SALE_WATCH_MIGRATION_TEST_HOOK: HOOK, SLOW_MIGRATION_HOOK_MS: String(HOOK_MS) };
  const t0 = Date.now();
  const child = spawn(process.execPath, ['server/index.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    // Boot (module load) must reach listen within seconds.
    let first = null;
    while (Date.now() - t0 < 30000 && child.exitCode === null) {
      const h = await get(port, '/api/health');
      if (h.status === 200) { first = { ...h, at: Date.now() - t0, body: json(h.body) }; break; }
      await sleep(100);
    }
    assert.ok(first, `server never answered /api/health (exit ${child.exitCode})\n${log.slice(-3000)}`);
    assert.ok(first.at < 15000, `first health answer ${first.at}ms after spawn`);
    assert.equal(first.body.saleWatchMigration.status, 'running', 'the injected slow migration is still running at first health');

    // While the migration runs: health is fast, the page reads, freshness reports pending.
    const during = [];
    let freshness = null;
    let page = null;
    let board = null;
    while (Date.now() - t0 < 60000) {
      const h = await get(port, '/api/health');
      const body = json(h.body);
      if (!body || body.saleWatchMigration.status !== 'running') break;
      during.push(h.ms);
      if (!freshness) {
        const f = await get(port, '/api/sale-watch/freshness');
        const fb = json(f.body);
        if (json((await get(port, '/api/health')).body).saleWatchMigration.status === 'running') freshness = { ...f, body: fb };
      }
      if (!page) page = await get(port, '/');
      if (!board) board = await get(port, '/api/portfolio-board');
      await sleep(250);
    }
    assert.ok(during.length >= 3, `expected several health samples during the migration, got ${during.length}`);
    assert.ok(Math.max(...during) < 1000, `health latency during migration: ${during.map(Math.round).join(',')}ms`);

    assert.ok(freshness, 'freshness was read while the migration was running');
    assert.equal(freshness.status, 503);
    assert.equal(freshness.body.schema, 'domainscout.sale-watch-freshness/v1', 'pending is still a contract reply');
    assert.equal(freshness.body.migrationPending.status, 'running');
    assert.equal(freshness.body.error, 'Sale Watch schema migration pending');
    const watchdog = require('../bin/sale-watch-watchdog');
    assert.equal(watchdog.migrationPending({ body: freshness.body }), true, 'the watchdog reads this as pending (no restart)');

    assert.equal(page.status, 200, 'page read answers during the migration');
    assert.ok(page.ms < 1000, `page read ${page.ms}ms`);
    assert.equal(board.status, 503);
    assert.equal(json(board.body).status, 'pending', 'a feature needing the migration reports pending');

    // The real migration then completes off-main.
    let ready = null;
    while (Date.now() - t0 < 75000) {
      const body = json((await get(port, '/api/health')).body);
      if (body && body.saleWatchMigration.status === 'ready') { ready = body; break; }
      await sleep(250);
    }
    assert.ok(ready, `migration never became ready\n${log.slice(-3000)}`);
    assert.ok(ready.saleWatchMigration.durationMs >= HOOK_MS - 500, `migration really was slow (${ready.saleWatchMigration.durationMs}ms)`);
    assert.match(log, /\[SaleWatchMigration\] schema ready/);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 3000);
    await exited;
    clearTimeout(killer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
