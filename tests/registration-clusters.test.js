'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  ensureClusterSchema,
  detectKitClusters,
  detectFamilyClusters,
  detectSweepClusters,
  recordClusters,
  runDailyClusterPass,
  runForwardJoinPass,
  readClusterOutcomes,
  DEFAULT_MAX_MEMBERS_PER_CLUSTER,
} = require('../server/registration-clusters');
const { ensureReconstructionSchema, persistUniverseDay } = require('../server/sale-watch-reconstruction');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reg-clusters-'));
}

async function* fixtureBatches(batches) {
  for (const batch of batches) yield batch;
}

function buildZoneDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE zone_daily_tokens (
      report_date TEXT NOT NULL,
      tld TEXT NOT NULL,
      token TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      reg_count INTEGER NOT NULL
    );
    CREATE TABLE zone_daily_new_names (
      report_date TEXT NOT NULL,
      tld TEXT NOT NULL,
      base_name TEXT NOT NULL
    );
    CREATE TABLE zone_keyword_tld_history (
      trend_date TEXT NOT NULL,
      keyword TEXT NOT NULL,
      tld_count INTEGER NOT NULL,
      tlds_json TEXT,
      source TEXT NOT NULL
    );
  `);
  return db;
}

function buildClusterDb() {
  const db = new Database(':memory:');
  ensureClusterSchema(db);
  ensureReconstructionSchema(db);
  return db;
}

function insertToken(db, overrides = {}) {
  const row = { report_date: '2026-08-10', tld: 'com', token: [redacted]]', word_count: 2, reg_count: 20, ...overrides };
  db.prepare('INSERT INTO zone_daily_tokens (report_date, tld, token, word_count, reg_count) VALUES (@report_date, @tld, @token, @word_count, @reg_count)').run(row);
}

function insertName(db, overrides = {}) {
  const row = { report_date: '2026-08-10', tld: 'com', base_name: 'x', ...overrides };
  db.prepare('INSERT INTO zone_daily_new_names (report_date, tld, base_name) VALUES (@report_date, @tld, @base_name)').run(row);
}

function insertKeywordHistory(db, overrides = {}) {
  const row = {
    trend_date: '2026-08-10', keyword: 'brandx', tld_count: 3,
    tlds_json: JSON.stringify(['com', 'net', 'io']), source: 'nrd-feed', ...overrides,
  };
  db.prepare('INSERT INTO zone_keyword_tld_history (trend_date, keyword, tld_count, tlds_json, source) VALUES (@trend_date, @keyword, @tld_count, @tlds_json, @source)').run(row);
}

function insertCandidate(db, overrides = {}) {
  const row = {
    domain: 'example.com',
    first_seen_day: '2026-08-01',
    last_seen_day: '2026-08-01',
    last_stream: 'godaddy-auction',
    last_price: null,
    exit_observed_day: '2026-08-01',
    state: 'exited',
    next_probe_at: '2026-08-01',
    probe_count: 0,
    outcome: null,
    outcome_tier: null,
    evidence_json: null,
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, last_price, exit_observed_day, state, next_probe_at, probe_count, outcome, outcome_tier, evidence_json, updated_at)
    VALUES (@domain, @first_seen_day, @last_seen_day, @last_stream, @last_price, @exit_observed_day, @state, @next_probe_at, @probe_count, @outcome, @outcome_tier, @evidence_json, @updated_at)
  `).run(row);
}

// ── ensureClusterSchema ──────────────────────────────────────────────────────

test('ensureClusterSchema is idempotent (safe to run twice)', () => {
  const db = new Database(':memory:');
  ensureClusterSchema(db);
  ensureClusterSchema(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).sort();
  assert.ok(tables.includes('registration_clusters'));
  assert.ok(tables.includes('registration_cluster_members'));
  assert.ok(tables.includes('cluster_pass_days'));
});

// ── detectKitClusters ────────────────────────────────────────────────────────

test('detectKitClusters finds a com token burst above the min and recovers only matching base_names', () => {
  const zoneDb = buildZoneDb();
  insertToken(zoneDb, { token: [redacted]]', word_count: 2, reg_count: 25 });
  insertName(zoneDb, { base_name: 'sunsetvistahomes' });
  insertName(zoneDb, { base_name: 'sunset-vista-realty' });
  insertName(zoneDb, { base_name: 'unrelatedname' });

  const clusters = detectKitClusters(zoneDb, { day: '2026-08-10', minMembers: 15 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].clusterKey, 'sunset vista');
  assert.equal(clusters[0].type, 'kit');
  assert.deepEqual(clusters[0].members.sort(), ['sunset-vista-realty.com', 'sunsetvistahomes.com'].sort());
});

test('detectKitClusters below-threshold token yields nothing', () => {
  const zoneDb = buildZoneDb();
  insertToken(zoneDb, { token: [redacted]]', word_count: 2, reg_count: 5 });
  insertName(zoneDb, { base_name: 'lowvolumewordsite' });

  const clusters = detectKitClusters(zoneDb, { day: '2026-08-10', minMembers: 15 });
  assert.equal(clusters.length, 0);
});

test('detectKitClusters caps members at the per-cluster maximum', () => {
  const zoneDb = buildZoneDb();
  insertToken(zoneDb, { token: [redacted]]', word_count: 2, reg_count: 500 });
  const insertNameStmt = zoneDb.prepare('INSERT INTO zone_daily_new_names (report_date, tld, base_name) VALUES (?, ?, ?)');
  const insertMany = zoneDb.transaction((n) => {
    for (let i = 0; i < n; i += 1) insertNameStmt.run('2026-08-10', 'com', `captoken${i}`);
  });
  insertMany(DEFAULT_MAX_MEMBERS_PER_CLUSTER + 50);

  const clusters = detectKitClusters(zoneDb, { day: '2026-08-10', minMembers: 15 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, DEFAULT_MAX_MEMBERS_PER_CLUSTER);
});

// ── detectFamilyClusters ─────────────────────────────────────────────────────

test('detectFamilyClusters reads an nrd-feed row with tld_count >= 3 and builds keyword+tld members', () => {
  const zoneDb = buildZoneDb();
  insertKeywordHistory(zoneDb, { keyword: 'brandx', tld_count: 3, tlds_json: JSON.stringify(['com', 'net', 'io']), source: 'nrd-feed' });

  const clusters = detectFamilyClusters(zoneDb, { day: '2026-08-10', minZones: 3 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].clusterKey, 'brandx');
  assert.equal(clusters[0].type, 'family');
  assert.deepEqual(clusters[0].members.sort(), ['brandx.com', 'brandx.io', 'brandx.net'].sort());
});

test('detectFamilyClusters excludes a tld_count 2 row at the default threshold', () => {
  const zoneDb = buildZoneDb();
  insertKeywordHistory(zoneDb, { keyword: 'smallfamily', tld_count: 2, tlds_json: JSON.stringify(['com', 'net']), source: 'nrd-feed' });

  const clusters = detectFamilyClusters(zoneDb, { day: '2026-08-10' });
  assert.equal(clusters.length, 0);
});

// ── detectSweepClusters ──────────────────────────────────────────────────────

test('detectSweepClusters: a kit key on 3 distinct birth_days within lookback produces one sweep with the union of members', () => {
  const clusterDb = buildClusterDb();
  recordClusters(clusterDb, [{ clusterKey: 'sweepkit', type: 'kit', day: '2026-08-01', members: ['a.com', 'b.com'] }], { day: '2026-08-01' });
  recordClusters(clusterDb, [{ clusterKey: 'sweepkit', type: 'kit', day: '2026-08-05', members: ['b.com', 'c.com'] }], { day: '2026-08-05' });
  recordClusters(clusterDb, [{ clusterKey: 'sweepkit', type: 'kit', day: '2026-08-10', members: ['d.com'] }], { day: '2026-08-10' });

  const sweeps = detectSweepClusters(clusterDb, { day: '2026-08-15', lookbackDays: 21, minDays: 3 });
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].clusterKey, 'sweepkit');
  assert.equal(sweeps[0].type, 'sweep');
  assert.equal(sweeps[0].day, '2026-08-01');
  assert.deepEqual(sweeps[0].members.sort(), ['a.com', 'b.com', 'c.com', 'd.com'].sort());
});

test('detectSweepClusters: a kit key on only 2 distinct birth_days does not produce a sweep', () => {
  const clusterDb = buildClusterDb();
  recordClusters(clusterDb, [{ clusterKey: 'twoday', type: 'kit', day: '2026-08-01', members: ['a.com'] }], { day: '2026-08-01' });
  recordClusters(clusterDb, [{ clusterKey: 'twoday', type: 'kit', day: '2026-08-05', members: ['b.com'] }], { day: '2026-08-05' });

  const sweeps = detectSweepClusters(clusterDb, { day: '2026-08-15', lookbackDays: 21, minDays: 3 });
  assert.equal(sweeps.find((s) => s.clusterKey === 'twoday'), undefined);
});

// ── recordClusters ───────────────────────────────────────────────────────────

test('recordClusters is idempotent on re-run: no duplicate members; member_count and last_active_day updated', () => {
  const clusterDb = buildClusterDb();
  const cluster = { clusterKey: 'idem', type: 'kit', day: '2026-08-01', members: ['a.com', 'b.com'] };
  const first = recordClusters(clusterDb, [cluster], { day: '2026-08-01' });
  assert.equal(first.clusters, 1);
  assert.equal(first.members, 2);

  const second = recordClusters(clusterDb, [{ ...cluster, members: ['a.com', 'b.com', 'c.com'] }], { day: '2026-08-10' });
  assert.equal(second.clusters, 1);
  assert.equal(second.members, 1, 'only the new member c.com counted');

  const row = clusterDb.prepare('SELECT * FROM registration_clusters WHERE cluster_key = ?').get('idem');
  assert.equal(row.member_count, 3);
  assert.equal(row.last_active_day, '2026-08-10');

  const memberCount = clusterDb.prepare('SELECT COUNT(*) AS n FROM registration_cluster_members WHERE cluster_id = ?').get(row.id).n;
  assert.equal(memberCount, 3, 'no duplicates');
});

// ── runDailyClusterPass ──────────────────────────────────────────────────────

test('runDailyClusterPass end-to-end records kits and families with correct summary counts; second call skips as already-passed', async () => {
  const zoneDb = buildZoneDb();
  insertToken(zoneDb, { report_date: '2026-08-10', token: [redacted]]', word_count: 2, reg_count: 20 });
  insertName(zoneDb, { report_date: '2026-08-10', base_name: 'dailypasssite' });
  insertKeywordHistory(zoneDb, { trend_date: '2026-08-10', keyword: 'dailyfam', tld_count: 3, tlds_json: JSON.stringify(['com', 'net', 'org']), source: 'nrd-feed' });

  const clusterDb = buildClusterDb();
  const result = await runDailyClusterPass(clusterDb, zoneDb, { day: '2026-08-10' });
  assert.equal(result.ran, true);
  assert.equal(result.day, '2026-08-10');
  assert.equal(result.kits, 1);
  assert.equal(result.families, 1);
  assert.ok(result.newMembers >= 2);

  const second = await runDailyClusterPass(clusterDb, zoneDb, { day: '2026-08-10' });
  assert.equal(second.ran, false);
  assert.equal(second.reason, 'already-passed');
});

// ── runForwardJoinPass ───────────────────────────────────────────────────────

test('runForwardJoinPass marks listed_seen_day from a fixture day-set, sold_seen_day from a detected candidate, sets last_checked_day, and re-run marks nothing new', async () => {
  const clusterDb = buildClusterDb();
  const universeDir = mkTmpDir();

  recordClusters(clusterDb, [{ clusterKey: 'joinkit', type: 'kit', day: '2026-08-15', members: ['listed.com', 'sold.com', 'neither.com'] }], { day: '2026-08-15' });

  await persistUniverseDay(clusterDb, {
    day: '2026-08-20',
    dir: universeDir,
    enumerate: () => fixtureBatches([[{ domain: 'listed.com' }]]),
  });

  insertCandidate(clusterDb, { domain: 'sold.com', state: 'detected', exit_observed_day: '2026-08-19', updated_at: '2026-08-19T00:00:00Z' });

  const first = await runForwardJoinPass(clusterDb, { universeDir, day: '2026-08-21' });
  assert.equal(first.ran, true);
  assert.equal(first.checked, 3);
  assert.equal(first.listed, 1);
  assert.equal(first.sold, 1);

  const rows = clusterDb.prepare('SELECT domain, listed_seen_day, sold_seen_day, last_checked_day FROM registration_cluster_members ORDER BY domain').all();
  const byDomain = Object.fromEntries(rows.map((r) => [r.domain, r]));
  assert.equal(byDomain['listed.com'].listed_seen_day, '2026-08-20');
  assert.equal(byDomain['sold.com'].sold_seen_day, '2026-08-19');
  for (const row of rows) assert.equal(row.last_checked_day, '2026-08-21');

  const second = await runForwardJoinPass(clusterDb, { universeDir, day: '2026-08-22' });
  assert.equal(second.listed, 0, 're-run marks no new listings');
  assert.equal(second.sold, 0, 're-run marks no new sales');
});

// ── readClusterOutcomes ──────────────────────────────────────────────────────

test('readClusterOutcomes rolls up member/listed/sold counts and orders by birth_day desc', () => {
  const clusterDb = buildClusterDb();
  recordClusters(clusterDb, [{ clusterKey: 'k1', type: 'kit', day: '2026-08-01', members: ['a.com', 'b.com'] }], { day: '2026-08-01' });
  recordClusters(clusterDb, [{ clusterKey: 'k2', type: 'kit', day: '2026-08-05', members: ['c.com'] }], { day: '2026-08-05' });

  const k1 = clusterDb.prepare('SELECT id FROM registration_clusters WHERE cluster_key = ?').get('k1');
  clusterDb.prepare('UPDATE registration_cluster_members SET listed_seen_day = ? WHERE cluster_id = ? AND domain = ?').run('2026-08-02', k1.id, 'a.com');
  clusterDb.prepare('UPDATE registration_cluster_members SET sold_seen_day = ? WHERE cluster_id = ? AND domain = ?').run('2026-08-03', k1.id, 'b.com');

  const outcomes = readClusterOutcomes(clusterDb, {});
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].cluster_key, 'k2', 'newest birth_day first');
  assert.equal(outcomes[1].cluster_key, 'k1');
  assert.equal(outcomes[1].member_count, 2);
  assert.equal(outcomes[1].listed_count, 1);
  assert.equal(outcomes[1].sold_count, 1);
});
