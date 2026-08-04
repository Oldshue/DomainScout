'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child, logs) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode != null) throw new Error(`server exited early\n${logs.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready\n${logs.join('')}`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-taken-in-'));
  // db.js supports long-lived production databases whose later migrations already
  // added these columns. Seed that current schema shape before loading its indexes.
  const bootstrap = new Database(path.join(dataDir, 'domains.db'));
  bootstrap.exec(`
    CREATE TABLE domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      base_name TEXT,
      tld TEXT NOT NULL,
      stream TEXT NOT NULL,
      source TEXT,
      status TEXT DEFAULT 'active',
      auction_end TEXT,
      auction_price REAL,
      auction_url TEXT,
      age_years INTEGER,
      wayback_snapshots INTEGER,
      wayback_first TEXT,
      wayback_last TEXT,
      dns_available INTEGER DEFAULT NULL,
      registration_available INTEGER DEFAULT NULL,
      first_available_at TEXT,
      availability_checked_at TEXT,
      availability_source TEXT,
      availability_error TEXT,
      registry_expiry TEXT,
      quality_score INTEGER DEFAULT 0,
      quality_reasons TEXT,
      length INTEGER,
      has_numbers INTEGER DEFAULT 0,
      has_hyphens INTEGER DEFAULT 0,
      drop_date TEXT,
      expiry_date TEXT,
      whois_checked TEXT,
      discovered_at TEXT DEFAULT (datetime('now')),
      tlds_taken INTEGER DEFAULT 0,
      tlds_checked_at TEXT,
      bid_count INTEGER DEFAULT 0,
      seen INTEGER DEFAULT 0,
      saved INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      notes TEXT,
      UNIQUE(domain, stream)
    );
  `);
  bootstrap.close();
  const oldDataPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;
  const db = require('../server/db');
  const insert = db.prepare(`
    INSERT INTO domains (
      domain, base_name, tld, stream, source, registration_available,
      length, drop_date, discovered_at
    ) VALUES (@domain, @base, '.ai', 'just-dropped', 'test-zone-diff', 1, @length, '2026-08-04', @discovered)
  `);
  for (const [base, discovered] of [
    ['alpha', '2026-08-04 12:04:00'],
    ['beta', '2026-08-04 12:03:00'],
    ['gamma', '2026-08-04 12:02:00'],
    ['delta', '2026-08-04 12:01:00'],
  ]) insert.run({ domain: `${base}.ai`, base, length: base.length, discovered });
  db.prepare(`
    INSERT INTO tld_check_cache (base_name, count, taken_json, all_count, source, checked_at)
    VALUES ('delta', 1, '[".ai"]', 3, 'dns-focus:ai+io+co', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO domains (
      domain, base_name, tld, stream, source, registration_available,
      length, expiry_date, discovered_at
    ) VALUES ('epsilon.ai', 'epsilon', '.ai', 'discovered', 'test-discovery', NULL, 7, '2026-08-03', '2026-08-01 12:00:00')
  `).run();
  const { projectConfirmedDrops } = require('../server/expired-availability');
  const confirmation = {
    domain: 'epsilon.ai',
    dns_available: 1,
    registration_available: 1,
    availability_checked_at: '2026-08-04 12:05:00',
    availability_source: 'test-rdap',
    registry_expiry: null,
  };
  assert.strictEqual(projectConfirmedDrops([confirmation]), 1);
  projectConfirmedDrops([confirmation]);
  const projected = db.prepare("SELECT * FROM domains WHERE domain = 'epsilon.ai' AND stream = 'just-dropped'").get();
  assert.strictEqual(projected.registration_available, 1);
  assert.strictEqual(projected.source, 'Availability Confirmation');
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM domains WHERE domain = 'epsilon.ai' AND stream = 'just-dropped'").get().n,
    1
  );
  db.close();
  if (oldDataPath == null) delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  else process.env.RAILWAY_VOLUME_MOUNT_PATH = oldDataPath;

  const zone = new Database(path.join(dataDir, 'zone_index.db'));
  zone.exec(`
    CREATE TABLE zone_indexed_tlds (tld TEXT PRIMARY KEY, file_date TEXT NOT NULL, record_count INTEGER);
    CREATE TABLE zone_names (
      base_name TEXT NOT NULL,
      base_name_rev TEXT NOT NULL,
      tld TEXT NOT NULL,
      PRIMARY KEY (base_name, tld)
    ) WITHOUT ROWID;
  `);
  const addZone = zone.prepare('INSERT INTO zone_names (base_name, base_name_rev, tld) VALUES (?, ?, ?)');
  const addIndexed = zone.prepare('INSERT INTO zone_indexed_tlds (tld, file_date, record_count) VALUES (?, ?, ?)');
  for (const [tld, names] of Object.entries({ dev: ['alpha', 'gamma'], app: ['gamma'], shop: ['beta'] })) {
    addIndexed.run(tld, '2026-08-04', names.length);
    for (const base of names) addZone.run(base, [...base].reverse().join(''), `.${tld}`);
  }
  zone.close();

  const port = await unusedPort();
  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      RAILWAY_VOLUME_MOUNT_PATH: dataDir,
      DISABLE_AUTH: '1',
      DOMAINSCOUT_SKIP_SERVER_LOCK: '1',
      DOMAINSCOUT_STARTUP_MAINTENANCE_ENABLED: '0',
      DOMAINSCOUT_STARTUP_ZONE_INDEX_ENABLED: '0',
      DOMAINSCOUT_DB_READ_WORKER: '0',
      DOMAINSCOUT_EXPIRED_DOGFOOD_ENABLED: '0',
      DOMAINSCOUT_TLD_ACCURACY_WORKER: '0',
      ENABLE_TLDS_WORKER: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  const query = async params => {
    const response = await fetch(`${baseUrl}/api/domains?${new URLSearchParams({
      stream: 'just-dropped', tld: '.ai', limit: '20', ...params,
    })}`);
    const body = await response.text();
    assert.strictEqual(response.status, 200, body);
    return JSON.parse(body);
  };

  try {
    await waitForServer(`${baseUrl}/api/stats`, child, logs);

    assert.deepStrictEqual(
      (await query({ takenIn: '.dev', takenInMode: 'taken' })).domains.map(row => row.domain),
      ['alpha.ai', 'gamma.ai']
    );
    assert.deepStrictEqual(
      (await query({ takenIn: '.dev', takenInMode: 'not_taken' })).domains.map(row => row.domain),
      ['epsilon.ai', 'beta.ai', 'delta.ai']
    );
    assert.deepStrictEqual(
      (await query({ takenIn: '.app', takenInMode: 'taken' })).domains.map(row => row.domain),
      ['gamma.ai']
    );

    const sorted = await query({
      takenIn: '.dev', takenInMode: 'any', sortField: 'taken_in_status', sortDir: 'DESC',
    });
    assert.deepStrictEqual(sorted.domains.map(row => row.domain), ['alpha.ai', 'gamma.ai', 'epsilon.ai', 'beta.ai', 'delta.ai']);
    assert.deepStrictEqual(
      sorted.domains.map(row => [row.domain, row.taken_in_count, row.taken_in_checked_count]),
      [['alpha.ai', 1, 1], ['gamma.ai', 1, 1], ['epsilon.ai', 0, 1], ['beta.ai', 0, 1], ['delta.ai', 0, 1]]
    );

    const notTakenFirst = await query({
      takenIn: '.dev', takenInMode: 'any', sortField: 'taken_in_status', sortDir: 'ASC',
    });
    assert.deepStrictEqual(notTakenFirst.domains.map(row => row.domain), ['epsilon.ai', 'beta.ai', 'delta.ai', 'alpha.ai', 'gamma.ai']);

    // Unrelated TLD proof: the same generic path sorts .shop without a product branch.
    const shop = await query({
      takenIn: '.shop', takenInMode: 'any', sortField: 'taken_in_status', sortDir: 'DESC',
    });
    assert.strictEqual(shop.domains[0].domain, 'beta.ai');
    assert.strictEqual(shop.domains[0].taken_in_count, 1);

    // delta's partial ai/io/co cache row does not confirm anything about .gg.
    const strictUnknown = await query({ takenIn: '.gg', takenInMode: 'not_taken' });
    assert.deepStrictEqual(strictUnknown.domains, []);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode != null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('taken-in-api.test.js: all assertions passed');
}

main().catch(err => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
