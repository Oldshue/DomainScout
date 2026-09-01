'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { tokenizeDailyLabel } = require('../server/domainlab');
const {
  importNrdDay,
  pruneNrdRetention,
} = require('../server/nrd-importer');
const { shouldDeleteZoneDb } = require('../scripts/railway-boot-cleanup');

// ── tokenizeDailyLabel: python-parity vectors (scripts/nrd-backfill.py segment()) ──

test('tokenizeDailyLabel: hyphen-split label with full dictionary coverage', () => {
  const dict = new Set(['rally', 'talent', 'action', 'menu']);
  const toks = tokenizeDailyLabel('rally-talent', { dict });
  assert.equal(toks.get('rally'), 1);
  assert.equal(toks.get('talent'), 1);
  assert.equal(toks.get('rally talent'), 2);
  assert.equal(toks.get('rallytalent'), 2);
});

test('tokenizeDailyLabel: single alphabetic chunk longest-match against dictionary', () => {
  const dict = new Set(['rally', 'talent', 'action', 'menu']);
  const toks = tokenizeDailyLabel('actionmenu', { dict });
  assert.equal(toks.get('action'), 1);
  assert.equal(toks.get('menu'), 1);
  assert.equal(toks.get('action menu'), 2);
  assert.equal(toks.get('actionmenu'), 2);
});

test('tokenizeDailyLabel: a digits part is skipped for segmentation but the whole label remains as a token', () => {
  const dict = new Set(['shop']);
  const toks = tokenizeDailyLabel('shop24', { dict });
  // 'shop24' is not purely alphabetic -> skipped as a hyphen part (there is
  // only one part here, the whole label). out stays empty, so only the
  // whole-label fallback token is produced, word_count = max(1, 0) = 1.
  assert.equal(toks.size, 1);
  assert.equal(toks.get('shop24'), 1);
});

test('tokenizeDailyLabel: empty dictionary produces only the whole-label token', () => {
  const dict = new Set();
  const toks = tokenizeDailyLabel('rally-talent', { dict });
  assert.equal(toks.size, 1);
  assert.equal(toks.get('rallytalent'), 1);
});

test('tokenizeDailyLabel: three-word phrase produces a trigram token', () => {
  const dict = new Set(['ai', 'agent', 'workflow', 'tool']);
  const toks = tokenizeDailyLabel('agentworkflowtool', { dict });
  // longest-match left to right: 'agent' (5) then 'workflow' (8) then 'tool' (4)
  assert.ok(toks.has('agent'));
  assert.ok(toks.has('workflow'));
  assert.ok(toks.has('tool'));
  assert.equal(toks.get('agent workflow'), 2);
  assert.equal(toks.get('workflow tool'), 2);
  assert.equal(toks.get('agent workflow tool'), 3);
});

// ── shouldDeleteZoneDb ───────────────────────────────────────────────────────

test('shouldDeleteZoneDb: below threshold keeps the db', () => {
  assert.equal(shouldDeleteZoneDb(500e6, 2000), false);
});

test('shouldDeleteZoneDb: above threshold deletes the db', () => {
  assert.equal(shouldDeleteZoneDb(2500e6, 2000), true);
});

test('shouldDeleteZoneDb: exactly at threshold keeps the db (strictly greater-than triggers deletion)', () => {
  const maxMb = 2000;
  assert.equal(shouldDeleteZoneDb(maxMb * 1e6, maxMb), false);
});

test('shouldDeleteZoneDb: zero bytes never deletes', () => {
  assert.equal(shouldDeleteZoneDb(0, 2000), false);
});


// -- importNrdDay ------------------------------------------------------------

function buildNrdFixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE zone_daily_new_names (
      tld TEXT NOT NULL, report_date TEXT NOT NULL, base_name TEXT NOT NULL,
      PRIMARY KEY (tld, report_date, base_name)
    ) WITHOUT ROWID;
    CREATE TABLE zone_daily_tokens (
      tld TEXT NOT NULL, report_date TEXT NOT NULL, token TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 1, reg_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tld, report_date, token)
    ) WITHOUT ROWID;
    CREATE TABLE zone_daily_stats (
      tld TEXT NOT NULL, stat_date TEXT NOT NULL,
      total_count INTEGER, new_count INTEGER, dropped_count INTEGER,
      had_previous INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tld, stat_date)
    );
    CREATE TABLE zone_keyword_trends (
      keyword TEXT NOT NULL, trend_date TEXT NOT NULL, tld_count INTEGER,
      PRIMARY KEY (keyword, trend_date)
    );
    CREATE TABLE zone_keyword_tld_history (
      keyword TEXT NOT NULL, trend_date TEXT NOT NULL, tld_count INTEGER NOT NULL,
      tlds_json TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'daily-diff',
      PRIMARY KEY (keyword, trend_date)
    );
  `);
  return db;
}

test('importNrdDay: parses fixture lines into new_names/tokens/stats and calls recordTrends with >=2-TLD map', async () => {
  const db = buildNrdFixtureDb();
  const fixtureLines = [
    'rally-talent.com',
    'rally-talent.io',
    'soloname.xyz',
    'foo.co.uk',
    'not-a-domain-line',
    'digit123.99',
  ];
  const dict = new Set(['rally', 'talent']);
  const recordedTrends = [];
  const opts = {
    fetch: async () => fixtureLines,
    tokenize: (label) => tokenizeDailyLabel(label, { dict }),
    recordTrends: (map, date, options) => { recordedTrends.push({ map, date, options }); },
  };

  const result = await importNrdDay(db, '2026-08-30', opts);
  assert.equal(result.imported, true);
  assert.equal(result.names, 4);

  const comNames = db.prepare("SELECT base_name FROM zone_daily_new_names WHERE tld='com' AND report_date=?").all('2026-08-30');
  assert.deepEqual(comNames.map(r => r.base_name), ['rally-talent']);
  const ioNames = db.prepare("SELECT base_name FROM zone_daily_new_names WHERE tld='io' AND report_date=?").all('2026-08-30');
  assert.deepEqual(ioNames.map(r => r.base_name), ['rally-talent']);
  const xyzNames = db.prepare("SELECT base_name FROM zone_daily_new_names WHERE tld='xyz' AND report_date=?").all('2026-08-30');
  assert.deepEqual(xyzNames.map(r => r.base_name), ['soloname']);
  const ukNames = db.prepare("SELECT base_name FROM zone_daily_new_names WHERE tld='uk' AND report_date=?").all('2026-08-30');
  assert.deepEqual(ukNames.map(r => r.base_name), ['foo']);

  const allTlds = db.prepare("SELECT DISTINCT tld FROM zone_daily_new_names WHERE report_date=?").all('2026-08-30').map(r => r.tld).sort();
  assert.deepEqual(allTlds, ['com', 'io', 'uk', 'xyz']);

  const rallyToken = db.prepare("SELECT reg_count, word_count FROM zone_daily_tokens WHERE tld='com' AND report_date=? AND token=?").get('2026-08-30', 'rally');
  assert.equal(rallyToken.reg_count, 1);
  assert.equal(rallyToken.word_count, 1);

  const comStats = db.prepare("SELECT * FROM zone_daily_stats WHERE tld='com' AND stat_date=?").get('2026-08-30');
  assert.equal(comStats.new_count, 1);
  assert.equal(comStats.total_count, null);
  assert.equal(comStats.dropped_count, null);

  assert.equal(recordedTrends.length, 1);
  assert.equal(recordedTrends[0].date, '2026-08-30');
  assert.equal(recordedTrends[0].options.source, 'nrd-feed');
  const trendMap = recordedTrends[0].map;
  assert.ok(trendMap.has('rally-talent'));
  assert.deepEqual([...trendMap.get('rally-talent')].sort(), ['com', 'io']);
  assert.ok(!trendMap.has('soloname'));
  assert.ok(!trendMap.has('foo'));
});

test('importNrdDay: second call for the same date is a no-op (skip-if-imported)', async () => {
  const db = buildNrdFixtureDb();
  const opts = { fetch: async () => ['name.com'], recordTrends: () => {} };
  const first = await importNrdDay(db, '2026-08-30', opts);
  assert.equal(first.imported, true);
  const second = await importNrdDay(db, '2026-08-30', opts);
  assert.equal(second.imported, false);
  assert.equal(second.reason, 'already-imported');
});

test('importNrdDay: feed-unavailable when fetch returns null', async () => {
  const db = buildNrdFixtureDb();
  const result = await importNrdDay(db, '2026-08-30', { fetch: async () => null });
  assert.equal(result.imported, false);
  assert.equal(result.reason, 'feed-unavailable');
});

// -- pruneNrdRetention --------------------------------------------------------

test('pruneNrdRetention: deletes only rows older than the retention cutoffs', () => {
  const db = buildNrdFixtureDb();
  db.prepare("INSERT INTO zone_daily_new_names (tld, report_date, base_name) VALUES ('com','2020-01-01','old')").run();
  db.prepare("INSERT INTO zone_daily_new_names (tld, report_date, base_name) VALUES ('com','2026-08-30','fresh')").run();
  db.prepare("INSERT INTO zone_daily_tokens (tld, report_date, token, word_count, reg_count) VALUES ('com','2020-01-01','old',1,1)").run();
  db.prepare("INSERT INTO zone_daily_tokens (tld, report_date, token, word_count, reg_count) VALUES ('com','2026-08-30','fresh',1,1)").run();
  db.prepare("INSERT INTO zone_daily_stats (tld, stat_date, total_count, new_count, dropped_count, had_previous) VALUES ('com','2020-01-01',NULL,1,NULL,0)").run();
  db.prepare("INSERT INTO zone_daily_stats (tld, stat_date, total_count, new_count, dropped_count, had_previous) VALUES ('com','2026-08-30',NULL,1,NULL,0)").run();
  db.prepare("INSERT INTO zone_keyword_trends (keyword, trend_date, tld_count) VALUES ('old','2020-01-01',2)").run();
  db.prepare("INSERT INTO zone_keyword_trends (keyword, trend_date, tld_count) VALUES ('fresh','2026-08-30',2)").run();
  db.prepare("INSERT INTO zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json, source) VALUES ('old','2020-01-01',2,'[]','nrd-feed')").run();
  db.prepare("INSERT INTO zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json, source) VALUES ('fresh','2026-08-30',2,'[]','nrd-feed')").run();

  pruneNrdRetention(db, { dailyDays: 60, trendDays: 270 });

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_daily_new_names WHERE report_date='2020-01-01'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_daily_new_names WHERE report_date='2026-08-30'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_daily_tokens WHERE report_date='2020-01-01'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_daily_stats WHERE stat_date='2020-01-01'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_keyword_trends WHERE trend_date='2020-01-01'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_keyword_tld_history WHERE trend_date='2020-01-01'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_keyword_trends WHERE trend_date='2026-08-30'").get().n, 1);
});

test('pruneNrdRetention: dailyDays and trendDays knobs are honored independently', () => {
  const db = buildNrdFixtureDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare("INSERT INTO zone_daily_new_names (tld, report_date, base_name) VALUES ('com','2026-06-01','mid')").run();
  db.prepare("INSERT INTO zone_daily_new_names (tld, report_date, base_name) VALUES ('com', ?, 'today-row')").run(today);
  db.prepare("INSERT INTO zone_keyword_trends (keyword, trend_date, tld_count) VALUES ('mid','2026-06-01',2)").run();

  pruneNrdRetention(db, { dailyDays: 0, trendDays: 100000 });

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_daily_new_names WHERE base_name='mid'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_daily_new_names WHERE base_name='today-row'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_keyword_trends WHERE keyword='mid'").get().n, 1, 'trendDays knob kept the keyword trend row independently of dailyDays');
});
