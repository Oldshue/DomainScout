'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { tokenizeDailyLabel } = require('../server/domainlab');
const {
  importNrdDay,
  pruneNrdRetention,
  runNrdTopUp,
  freeDiskMb,
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

test('shouldDeleteZoneDb: above former threshold preserves durable data', () => {
  assert.equal(shouldDeleteZoneDb(2500e6, 2000), false);
});

test('shouldDeleteZoneDb: exactly at former threshold keeps the db', () => {
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
  const ukNames = db.prepare("SELECT base_name FROM zone_daily_new_names WHERE tld='co.uk' AND report_date=?").all('2026-08-30');
  assert.deepEqual(ukNames.map(r => r.base_name), ['foo']);

  const allTlds = db.prepare("SELECT DISTINCT tld FROM zone_daily_new_names WHERE report_date=?").all('2026-08-30').map(r => r.tld).sort();
  assert.deepEqual(allTlds, ['co.uk', 'com', 'io', 'xyz']);

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

// -- runNrdTopUp: disk-pressure guard -----------------------------------------

test('runNrdTopUp: disk-pressure guard active skips every import but still prunes', async () => {
  const db = buildNrdFixtureDb();
  db.prepare("INSERT INTO zone_daily_new_names (tld, report_date, base_name) VALUES ('com','2020-01-01','old')").run();

  const fetchCalls = [];
  const opts = {
    days: 2,
    endDate: '2026-08-30',
    freeDiskMb: () => 100,
    fetch: async (dateStr) => { fetchCalls.push(dateStr); return ['name.com']; },
    recordTrends: () => {},
  };

  const summary = await runNrdTopUp(db, opts);

  assert.equal(summary.diskPressure, true);
  assert.equal(summary.results.length, 2);
  for (const r of summary.results) {
    assert.equal(r.imported, false);
    assert.equal(r.reason, 'disk-pressure');
  }
  assert.equal(fetchCalls.length, 0, 'fetch must not be called while under disk pressure');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_daily_new_names").get().n, 0, 'no rows written while under disk pressure');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_daily_new_names WHERE report_date='2020-01-01'").get().n, 0, 'pruning still ran and deleted the over-retention row');
});

test('runNrdTopUp: disk-pressure guard inactive when free space is above the floor', async () => {
  const db = buildNrdFixtureDb();
  const fetchCalls = [];
  const opts = {
    days: 1,
    endDate: '2026-08-30',
    freeDiskMb: () => 5000,
    fetch: async (dateStr) => { fetchCalls.push(dateStr); return ['name.com']; },
    recordTrends: () => {},
  };

  const summary = await runNrdTopUp(db, opts);

  assert.equal(summary.diskPressure, undefined);
  assert.equal(fetchCalls.length, 1);
  assert.equal(summary.results[0].imported, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zone_daily_new_names WHERE report_date='2026-08-30'").get().n, 1);
});

test('runNrdTopUp: disk-pressure guard fails open when freeDiskMb throws', async () => {
  const db = buildNrdFixtureDb();
  const fetchCalls = [];
  const opts = {
    days: 1,
    endDate: '2026-08-30',
    freeDiskMb: () => { throw new Error('statfs unsupported'); },
    fetch: async (dateStr) => { fetchCalls.push(dateStr); return ['name.com']; },
    recordTrends: () => {},
  };

  const summary = await runNrdTopUp(db, opts);

  assert.equal(summary.diskPressure, undefined);
  assert.equal(fetchCalls.length, 1);
  assert.equal(summary.results[0].imported, true);
});

test('runNrdTopUp: disk-pressure guard fails open when freeDiskMb returns null', async () => {
  const db = buildNrdFixtureDb();
  const fetchCalls = [];
  const opts = {
    days: 1,
    endDate: '2026-08-30',
    freeDiskMb: () => null,
    fetch: async (dateStr) => { fetchCalls.push(dateStr); return ['name.com']; },
    recordTrends: () => {},
  };

  const summary = await runNrdTopUp(db, opts);

  assert.equal(summary.diskPressure, undefined);
  assert.equal(fetchCalls.length, 1);
});

test('runNrdTopUp: DOMAINSCOUT_NRD_MIN_FREE_MB floor override is honored', async () => {
  const db = buildNrdFixtureDb();
  const prevEnv = process.env.DOMAINSCOUT_NRD_MIN_FREE_MB;
  process.env.DOMAINSCOUT_NRD_MIN_FREE_MB = '10000';
  try {
    const fetchCalls = [];
    const opts = {
      days: 1,
      endDate: '2026-08-30',
      // 5000 MB free is below the overridden 10000 MB floor, though above the default 400.
      freeDiskMb: () => 5000,
      fetch: async (dateStr) => { fetchCalls.push(dateStr); return ['name.com']; },
      recordTrends: () => {},
    };

    const summary = await runNrdTopUp(db, opts);

    assert.equal(summary.diskPressure, true);
    assert.equal(summary.results[0].reason, 'disk-pressure');
    assert.equal(fetchCalls.length, 0);
  } finally {
    if (prevEnv === undefined) delete process.env.DOMAINSCOUT_NRD_MIN_FREE_MB;
    else process.env.DOMAINSCOUT_NRD_MIN_FREE_MB = prevEnv;
  }
});

test('freeDiskMb: returns null for an in-memory database (no real path to statfs)', () => {
  const db = buildNrdFixtureDb();
  assert.equal(freeDiskMb(db), null);
});

test('NRD replay preserves full names and counts each normalized domain once', async () => {
  const db = buildNrdFixtureDb();
  const lines = ['MEADOW.co.uk', 'meadow.co.uk.', 'meadow.uk', 'rally-talent.com', 'bad name.com', ''];
  const result = await importNrdDay(db, '2026-09-05', { fetch: async () => lines, recordTrends: () => {} });
  assert.equal(result.names, 3);
  assert.equal(result.receipt.duplicateRows, 1);
  assert.equal(result.receipt.invalidRows, 1);
  assert.equal(result.receipt.inputRows, 5);
  assert.equal(result.receipt.globalCoverage, 'unknown');
  const names = db.prepare("SELECT base_name || '.' || tld AS name FROM zone_daily_new_names ORDER BY name").all().map(r => r.name);
  assert.deepEqual(names, ['meadow.co.uk', 'meadow.uk', 'rally-talent.com']);
  await importNrdDay(db, '2026-09-05', { fetch: async () => lines, rebuild: true, recordTrends: () => {} });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zone_daily_new_names').get().n, 3);
  assert.equal(db.prepare("SELECT reg_count FROM zone_daily_tokens WHERE token='meadow' AND tld='co.uk'").get().reg_count, 1);
  db.close();
});

test('failed rebuild leaves the accepted day and receipt unchanged', async () => {
  const db = buildNrdFixtureDb();
  await importNrdDay(db, '2026-09-05', { fetch: async () => ['meadow.com'], recordTrends: () => {} });
  const before = db.prepare('SELECT * FROM nrd_import_receipts').all();
  await assert.rejects(importNrdDay(db, '2026-09-05', { rebuild: true, fetch: async () => ['river.com'], tokenize: () => { throw Error('simulated interruption'); } }));
  assert.deepEqual(db.prepare('SELECT * FROM nrd_import_receipts').all(), before);
  assert.equal(db.prepare('SELECT base_name FROM zone_daily_new_names').get().base_name, 'meadow');
  db.close();
});

test('corpus patterns survive shuffle and duplicate batches without vocabulary seeds', () => {
  const { discoverFragments } = require('../server/daily-fragments');
  const labels = ['meadowbridge', 'meadowgarden', 'meadowclinic', 'meadowstudio', 'qavixbridge', 'qavixgarden', 'qavixclinic', 'qavixstudio'];
  const first = discoverFragments(labels);
  assert.deepEqual(discoverFragments([...labels].reverse().concat(labels)), first);
  assert.equal(first.find(r => r.token === 'qavix').count, 4);
  assert.equal(first.find(r => r.token === 'meadow').count, 4);
  assert.equal(first.find(r => r.token === 'meado').visible, false);
  assert.deepEqual(discoverFragments(Array(100).fill('sameproduct')), []);
});

test('seven-day simulation distinguishes a vocabulary-free surge from a numbered batch and missing history', async () => {
  const db = buildNrdFixtureDb();
  const { computeDailyFragments, computeDailyDomains } = require('../server/domainlab');
  const adapter = { prepare: sql => db.prepare(sql.replaceAll('zi.', '')), exec: sql => db.exec(sql.replaceAll('zi.', '')) };
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.parse('2026-09-05T00:00:00Z') - i * 86400000).toISOString().slice(0,10);
    const labels = Array.from({length:100}, (_, n) => `ordinary${n}.com`);
    if (i === 0) {
      for (const suffix of ['garden','clinic','bridge','studio','river','market','hotel','travel','harbor','design','meadow','school']) labels.push(`qavix${suffix}.com`);
      for (let n=0;n<40;n++) labels.push(`batch${n}.com`);
    }
    await importNrdDay(db, day, { fetch: async () => labels, recordTrends: () => {} });
  }
  const result = computeDailyFragments(adapter, { date: '2026-09-05', zone: 'com', q: 'qavix' });
  const signal = result.tokens.find(r => r.token === 'qavix');
  assert.equal(result.baseline.dates.length, 7);
  assert.equal(signal.strength, 'rising in feed');
  const drill = computeDailyDomains(adapter, { date: '2026-09-05', zone: 'com', token: 'qavix', mode: 'fragments' });
  assert.equal(drill.total, signal.count);
  const batch = computeDailyFragments(adapter, { date: '2026-09-05', zone: 'com', q: 'batch' }).tokens.find(r => r.token === 'batch');
  assert.equal(batch.strength, 'numbered batch pattern');
  assert.equal(batch.score, 0);
  const missing = computeDailyFragments(adapter, { date: '2026-09-06', zone: 'com' });
  assert.equal(missing.date, '2026-09-06');
  assert.equal(missing.coverage.status, 'missing');
  assert.equal(missing.tokens.length, 0);
  db.close();
});

test('dictionary tokens preserve short words and never skip letters to invent phrases', () => {
  const dict = new Set(['ai', 'river', 'garden']);
  assert.ok(tokenizeDailyLabel('airiver', { dict }).has('ai'));
  assert.ok(tokenizeDailyLabel('airiver', { dict }).has('ai river'));
  assert.ok(!tokenizeDailyLabel('riverzzz garden'.replace(' ', ''), { dict }).has('river garden'));
});

test('fragment mining retains the whole repeated phrase beyond sixteen characters', () => {
  const { discoverFragments } = require('../server/daily-fragments');
  const token = 'generationalgroup';
  const rows = discoverFragments(['a','b','c','d'].map(x => x + token));
  assert.equal(rows.find(r => r.token === token)?.visible, true);
  assert.equal(rows.find(r => r.token === token.slice(1))?.visible, false);
});

test('overlapping imports cannot combine different snapshots behind one receipt', async () => {
  const db = buildNrdFixtureDb();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = names => ({ fetch: async () => { await gate; return names; }, recordTrends: () => {} });
  const first = importNrdDay(db, '2026-09-05', options(['meadow.com']));
  const second = importNrdDay(db, '2026-09-05', options(['river.com']));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(r => r.imported).length, 1);
  assert.deepEqual(db.prepare('SELECT base_name FROM zone_daily_new_names').all(), [{base_name:'meadow'}]);
  db.close();
});

test('research signal gate requires sustained growth and non-mirrored cross-suffix contexts', async () => {
  const db = buildNrdFixtureDb();
  const { computeDailySignals } = require('../server/domainlab');
  const adapter = { prepare: sql => db.prepare(sql.replaceAll('zi.', '')), exec: sql => db.exec(sql.replaceAll('zi.', '')) };
  for (let i=0; i<8; i++) {
    const day = new Date(Date.parse('2026-09-05')-i*86400000).toISOString().slice(0,10);
    const lines = [];
    for (const tld of ['com','net','org']) {
      for (let n=0;n<100;n++) lines.push(`ordinary${n}.${tld}`);
      for (let n=0;n<(i===0?20:4);n++) {
        const context = String.fromCharCode(97+n)+String.fromCharCode(97+(n*7)%26);
        lines.push(`qavix${context}${tld}.${tld}`);
        lines.push(`mirror${context}.${tld}`);
      }
    }
    await importNrdDay(db,day,{fetch:async()=>lines,recordTrends:()=>{}});
  }
  const result=computeDailySignals(adapter,{date:'2026-09-05',zone:'com'});
  assert.ok(result.tokens.some(r=>r.token==='qavix'), 'novel vocabulary with diverse persistent evidence survives');
  assert.ok(!result.tokens.some(r=>r.token==='mirror'), 'same labels mirrored across suffixes are not corroboration');
  assert.equal(result.signalReview.marketDemandVerified,false);
  db.close();
});

test('daily insights retain sustained vocabulary and first-day patterns with exact evidence', async () => {
  const db=buildNrdFixtureDb();
  const {computeDailyInsights,computeDailyDomains}=require('../server/domainlab');
  const adapter={prepare:sql=>db.prepare(sql.replaceAll('zi.','')),exec:sql=>db.exec(sql.replaceAll('zi.',''))};
  for(let i=0;i<8;i++){
    const day=new Date(Date.parse('2026-09-05')-i*86400000).toISOString().slice(0,10);
    const lines=['meadowbridge.com','gardenmeadow.com','brightmeadow.com','truemeadowstudio.com','meadowclinic.com','calmmeadow.com'];
    if(i===0)lines.push('qavixgarden.com','qavixclinic.com','qavixhotel.com','qavixstudio.com');
    await importNrdDay(db,day,{fetch:async()=>lines,recordTrends:()=>{}});
  }
  const sustained=computeDailyInsights(adapter,{date:'2026-09-05',zone:'com',q:'meadow'}).tokens.find(x=>x.token==='meadow');
  assert.ok(sustained,'sustained and internally placed vocabulary is retained');
  assert.equal(sustained.count,6);assert.equal(sustained.baselineExactCount,42);
  assert.equal(sustained.history.length,7);assert.ok(sustained.examples.length>0 && sustained.examples.every(x=>x.includes('meadow')));
  assert.equal(computeDailyDomains(adapter,{date:'2026-09-05',zone:'com',token:'meadow',mode:'insights'}).total,6);
  const fresh=computeDailyInsights(adapter,{date:'2026-09-05',zone:'com',q:'qavix'}).tokens.find(x=>x.token==='qavix');
  assert.ok(fresh);assert.equal(fresh.baselineExactCount,0);assert.equal(fresh.direction,'New in this sample');
  const missing=computeDailyInsights(adapter,{date:'2026-09-06',zone:'com'});assert.equal(missing.tokens.length,0);
  db.close();
});

test('construction explanation identifies repeated suffixes without inventing registrants',()=>{
  const {describeConstruction}=require('../server/daily-insights');
  const labels=['northmeadowpro','southmeadowpro','westmeadowpro','eastmeadowpro','truemeadow','meadowgarden'];
  assert.deepEqual(describeConstruction(labels,'meadow'),{kind:'suffix',text:'meadowpro',count:4});
});

test('family search covers every suffix and low-frequency exact variations',async()=>{
  const db=buildNrdFixtureDb();const {computeDailyInsights,computeDailyDomains}=require('../server/domainlab');
  const adapter={prepare:sql=>db.prepare(sql.replaceAll('zi.','')),exec:sql=>db.exec(sql.replaceAll('zi.',''))};
  await importNrdDay(db,'2026-09-05',{fetch:async()=>['meadowgraph.com','meadowgraph.ai','mymeadowgraph.com','meadowgraphcloud.dev','othername.com'],recordTrends:()=>{}});
  const all=computeDailyInsights(adapter,{date:'2026-09-05',q:'meadowgraph'}).tokens.find(x=>x.token==='meadowgraph');
  assert.equal(all.count,4);assert.equal(all.uniqueLabels,3);assert.equal(all.extensions.length,3);
  const drill=computeDailyDomains(adapter,{date:'2026-09-05',token:'meadowgraph',mode:'insights'});
  assert.equal(drill.total,4);assert.ok(drill.names.includes('meadowgraph.ai'));
  const narrow=computeDailyInsights(adapter,{date:'2026-09-05',zone:'com',q:'mymeadowgraph'}).tokens[0];
  assert.equal(narrow.count,1);assert.deepEqual(narrow.examples,['mymeadowgraph.com']);
  db.close();
});

test('family comparisons exclude unverified intervening days and exact hyphenated searches remain visible',async()=>{
  const db=buildNrdFixtureDb();const {computeDailyInsights}=require('../server/domainlab');
  const adapter={prepare:sql=>db.prepare(sql.replaceAll('zi.','')),exec:sql=>db.exec(sql.replaceAll('zi.',''))};
  const lines=['meadow-core.com','meadowclub.com','meadowhotel.com','meadowsky.com'];
  for(const day of ['2026-08-29','2026-09-01','2026-09-05'])await importNrdDay(db,day,{fetch:async()=>lines,recordTrends:()=>{}});
  db.prepare("DELETE FROM nrd_import_receipts WHERE report_date='2026-09-01'").run();
  const family=computeDailyInsights(adapter,{date:'2026-09-05',zone:'com',q:'meadow'}).tokens[0];
  assert.equal(family.baselineExactCount,4);assert.equal(family.history.length,1);assert.equal(family.shareRatio,1);
  const exact=computeDailyInsights(adapter,{date:'2026-09-05',zone:'com',q:'meadow-core'}).tokens[0];
  assert.equal(exact.count,1);assert.equal(exact.baselineExactCount,1);
  db.close();
});

test('editorial keyword quality rejects fragments without hiding words or readable compounds',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const dictionary=new Set(fs.readFileSync(path.join(__dirname,'../server/assets/english-words.txt'),'utf8').split(/\s+/).map(x=>x.toLowerCase()));
  const {readableKeyword,keywordUse,readableExtension}=require('../server/keyword-language');
  for(const token of ['tion','tions','ation','ations','agenti','oagent','ment','ness'])assert.equal(readableKeyword(token,dictionary),false,token);
  for(const token of ['studio','market','solutions','agent','agentic','runtime','meadowgraph'])assert.equal(readableKeyword(token,dictionary),true,token);
  assert.equal(keywordUse('browsescrape','browsescrape',dictionary),true);
  assert.equal(keywordUse('agentserviceprocurement','agents',dictionary),false);
  assert.equal(keywordUse('agenticshoppingagent','agentics',dictionary),false);
  assert.equal(keywordUse('agenticshoppingagent','shopping',dictionary),true);
  assert.equal(keywordUse('moneyagent','agent',dictionary),true);
  assert.equal(keywordUse('corporation','oration',dictionary),false);
  assert.equal(keywordUse('thebrand','theb',dictionary),false);
  assert.equal(keywordUse('education','cation',dictionary),false);
  assert.equal(keywordUse('cationexchange','cation',dictionary),true);
  for(const word of ['ingstudio','onstudio','studiol','amarket','omarket']) assert.equal(readableExtension(word,word.includes('studio')?'studio':'market',dictionary),false,word);
  assert.equal(readableExtension('oagent','agent',dictionary),false);
  assert.equal(readableExtension('agentic','agent',dictionary),true);
  assert.equal(readableExtension('agentgraph','agent',dictionary),true);
});

test('xyz cannot seed insights, contribute counts or enter matching-name evidence',async()=>{
 const db=buildNrdFixtureDb(); const {computeDailyInsights,computeDailyDomains,computeDailyFragments}=require('../server/domainlab');
 const adapter={prepare:sql=>db.prepare(sql.replaceAll('zi.','')),exec:sql=>db.exec(sql.replaceAll('zi.',''))};
 for(const day of ['2026-09-04','2026-09-05']) await importNrdDay(db,day,{fetch:async()=>['browserpeak.xyz','browserpath.xyz','browsertab.xyz','browsercloud.xyz','browsercookie.com'],recordTrends:()=>{}});
 assert.equal(computeDailyInsights(adapter,{date:'2026-09-05',q:'browserpeak'}).tokens.length,0);
 const browser=computeDailyInsights(adapter,{date:'2026-09-05',q:'browser'}); assert.equal(browser.tokens[0].count,1);assert.equal(browser.tokens[0].baselineExactCount,1);assert.deepEqual(browser.tokens[0].extensions,[{tld:'com',count:1}]);assert.equal(browser.coverage.names,1);
 const names=computeDailyDomains(adapter,{mode:'insights',date:'2026-09-05',token:'browser'});assert.deepEqual(names.names,['browsercookie.com']);
 assert.equal(computeDailyInsights(adapter,{date:'2026-09-05',zone:'xyz',q:'browser'}).tokens.length,0);
 assert.ok(computeDailyFragments(adapter,{date:'2026-09-05',q:'browser'}).tokens.length>0);
 db.close();
});

test('small extension feeds expose repeated readable vocabulary below import cutoff', async () => {
 const db=buildNrdFixtureDb();const {computeDailyInsights}=require('../server/domainlab');
 const adapter={prepare:sql=>db.prepare(sql.replaceAll('zi.','')),exec:sql=>db.exec(sql.replaceAll('zi.',''))};
 for(const date of ['2026-09-04','2026-09-05']) await importNrdDay(db,date,{fetch:async()=>['cloudstitch.dev','cloudgarden.dev','databrakes.dev','exiledata.dev','polstudio.dev','kaostudio.dev','curatedstudios.dev','education.dev','action.dev','inspection.dev','cloudonly.xyz'],recordTrends:()=>{}});
 const r=computeDailyInsights(adapter,{date:'2026-09-05',zone:'dev'});
 assert.equal(r.coverage.names,10);
 for(const token of ['cloud','data','studio']) {
  const card=r.tokens.find(x=>x.token===token);assert.ok(card,token);
  assert.equal(card.count,token==='studio'?3:2);assert.equal(card.baselineExactCount,card.count);
  assert.equal(card.sampleStrength,'small sample');assert.ok(card.examples.every(x=>x.endsWith('.dev')));
 }
 assert.ok(!r.tokens.some(x=>x.token==='tion'));
 assert.equal(computeDailyInsights(adapter,{date:'2026-09-05',zone:'xyz'}).tokens.length,0);
 db.close();
});

test('week and month aggregate names, preserve sparse daily vocabulary and expose missing coverage', async () => {
 const db=buildNrdFixtureDb();const {computeDailyInsights,computeDailyDomains}=require('../server/domainlab');
 const adapter={prepare:s=>db.prepare(s.replaceAll('zi.','')),exec:s=>db.exec(s.replaceAll('zi.',''))};
 for(let i=0;i<35;i++) {const date=new Date(Date.parse('2026-09-05')-i*86400000).toISOString().slice(0,10);await importNrdDay(db,date,{fetch:async()=>[`cloud${i}.dev`,`cloud${i}.xyz`,'cloudrepeat.dev'],recordTrends:()=>{}});}
 for(const [period,days] of [['week',7],['month',30]]){
  const r=computeDailyInsights(adapter,{date:'2026-09-05',zone:'dev',period,q:'cloud'});
  assert.equal(r.period.days,days);assert.equal(r.period.observedDates.length,days);assert.equal(r.coverage.names,days+1);
  assert.equal(r.tokens[0].count,days+1);assert.equal(r.tokens[0].currentHistory.reduce((n,x)=>n+x.count,0),days+1);
  const names=computeDailyDomains(adapter,{date:'2026-09-05',zone:'dev',period,mode:'insights',token:'cloud',limit:100});assert.equal(names.total,r.tokens[0].count);assert.equal(new Set(names.names).size,names.total);
  assert.equal(r.baseline.dates.length,period==='week'?7:5);assert.equal(r.baseline.complete,period==='week');
 }
 const absent=computeDailyInsights(adapter,{date:'2026-09-06',zone:'dev',period:'week',q:'cloud'});
 assert.deepEqual(absent.period.missingDates,['2026-09-06']);assert.equal(absent.coverage.status,'partial feed');assert.ok(absent.tokens.length);
 db.close();
});

test('period insights execute through the read-only worker alongside ordinary SQL', async () => {
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Worker}=require('node:worker_threads');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'domainlab-period-'));const db=buildNrdFixtureDb();
 let worker;
 try {
  await importNrdDay(db,'2026-09-05',{fetch:async()=>['cloudgarden.dev','cloudstitch.dev'],recordTrends:()=>{}});
  await db.backup(path.join(dir,'zone_index.db'));
  const catalog=new Database(path.join(dir,'domains.db'));catalog.exec('CREATE TABLE ordinary (value TEXT); INSERT INTO ordinary VALUES (\'catalog-ok\')');catalog.close();
  worker=new Worker(path.resolve(__dirname,'../server/db-read-worker.js'),{workerData:{dbPath:path.join(dir,'domains.db'),attachZoneIndex:true}});
  let id=0;const ask=message=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.postMessage({id:++id,...message});});
  const r=await ask({operation:'domainlab.insights',params:{date:'2026-09-05',zone:'dev',period:'month',q:'cloud'}});assert.equal(r.ok,true,r.error);assert.equal(r.rows.tokens[0].count,2);assert.equal(r.rows.period.days,30);
  const sql=await ask({sql:'SELECT value FROM ordinary'});assert.deepEqual(sql.rows,[{value:'catalog-ok'}]);
  const bad=await ask({operation:'unregistered'});assert.equal(bad.ok,false);
 } finally {if(worker)await worker.terminate();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('boot maintenance retains registration receipts even above the configured legacy ceiling',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'domainlab-boot-'));const file=path.join(dir,'zone_index.db');
 const beforeDir=process.env.RAILWAY_VOLUME_MOUNT_PATH,beforeMax=process.env.DOMAINSCOUT_ZONE_DB_MAX_MB;
 try {const db=new Database(file);db.exec("CREATE TABLE durable_receipts (day TEXT); INSERT INTO durable_receipts VALUES ('2026-09-05')");db.close();
  process.env.RAILWAY_VOLUME_MOUNT_PATH=dir;process.env.DOMAINSCOUT_ZONE_DB_MAX_MB='0.001';
  require('../scripts/railway-boot-cleanup').runBootCleanup();
  const check=new Database(file,{readonly:true});assert.equal(check.prepare('SELECT day FROM durable_receipts').get().day,'2026-09-05');check.close();
 }finally{if(beforeDir===undefined)delete process.env.RAILWAY_VOLUME_MOUNT_PATH;else process.env.RAILWAY_VOLUME_MOUNT_PATH=beforeDir;if(beforeMax===undefined)delete process.env.DOMAINSCOUT_ZONE_DB_MAX_MB;else process.env.DOMAINSCOUT_ZONE_DB_MAX_MB=beforeMax;fs.rmSync(dir,{recursive:true,force:true});}
});
