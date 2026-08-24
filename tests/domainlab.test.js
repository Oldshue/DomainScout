'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  semanticGroupForTld,
  segmentBaseName,
  classifyTermSignal,
  elideZones,
  computeTrending,
  ZONE_SEMANTIC_GROUPS,
  isActionableZone,
  zoneRelevanceRank,
} = require('../server/domainlab');

test('semanticGroupForTld classifies technical, geo and other zones', () => {
  assert.equal(semanticGroupForTld('app'), 'technical');
  assert.equal(semanticGroupForTld('.dev'), 'technical');
  assert.equal(semanticGroupForTld('shop'), 'commerce');
  assert.equal(semanticGroupForTld('de'), 'geo');
  assert.equal(semanticGroupForTld('museum'), 'other');
});

test('ZONE_SEMANTIC_GROUPS covers the required seed extensions', () => {
  assert.deepEqual(ZONE_SEMANTIC_GROUPS.technical.sort(), ['ai', 'app', 'cloud', 'codes', 'dev', 'io', 'sh', 'tech'].sort());
  assert.ok(ZONE_SEMANTIC_GROUPS.commerce.includes('shop'));
  assert.ok(ZONE_SEMANTIC_GROUPS.finance.includes('capital'));
});

test('market-relevant zones lead DomainLab while restricted locality zones remain opt-in', () => {
  assert.equal(isActionableZone('.dev'), true);
  assert.equal(isActionableZone('.app'), true);
  assert.equal(isActionableZone('.abudhabi'), false);
  assert.ok(zoneRelevanceRank('.dev') < zoneRelevanceRank('.abudhabi'));
  assert.ok(zoneRelevanceRank('.app') < zoneRelevanceRank('.abudhabi'));
});

test('segmentBaseName splits hyphens first, then longest-match dictionary words', () => {
  const words = segmentBaseName('rally-talent');
  assert.deepEqual(words, ['rally', 'talent']);
});

test('segmentBaseName degrades gracefully on names with no clean dictionary split', () => {
  const words = segmentBaseName('xz9-qq');
  assert.ok(Array.isArray(words));
});

// ── classifyTermSignal ──────────────────────────────────────────────────────

test('classifyTermSignal flags jljl88 as noise via bulk-blast across junk zones', () => {
  // Mirrors the live observation: same-day spread across 18 junk TLDs,
  // majority outside the curated semantic groups.
  const zones = ['autos', 'beauty', 'beer', 'boats', 'casa', 'courses', 'cyou', 'guru', 'hair', 'homes', 'mom', 'pics', 'qpon', 'skin', 'space', 'study', 'wtf', 'yachts'];
  const result = classifyTermSignal('jljl88', zones);
  assert.equal(result.signal, 'noise');
  assert.equal(result.bulkBlast, true);
  assert.ok(result.reasons.some(r => r.includes('bulk-blast')), 'expected a bulk-blast reason');
  assert.equal(result.gibberish, true);
});

test('classifyTermSignal treats actionmenu in .app/.dev as quality (the good signal)', () => {
  const result = classifyTermSignal('actionmenu', ['app', 'dev']);
  assert.equal(result.signal, 'quality');
  assert.equal(result.bulkBlast, false);
  assert.equal(result.reasons.length, 0);
});

test('classifyTermSignal flags rm666 as noise (high digit ratio + gibberish)', () => {
  const result = classifyTermSignal('rm666', ['com']);
  assert.equal(result.signal, 'noise');
  assert.ok(result.digitsRatio >= 0.5);
  assert.equal(result.gibberish, true);
});

test('classifyTermSignal downweights adult/gambling lexicon terms to noise', () => {
  const result = classifyTermSignal('pornobolt', ['com', 'net']);
  assert.equal(result.signal, 'noise');
  assert.ok(result.lexiconHit);
});

// ── elideZones ───────────────────────────────────────────────────────────────

test('elideZones returns the full list at or under the cap', () => {
  assert.equal(elideZones(['app', 'dev', 'io']), '.app, .dev, .io');
});

test('elideZones truncates beyond 6 zones with a "+N more" suffix', () => {
  const zones = ['academy', 'actor', 'africa', 'agency', 'airforce', 'apartments', 'app', 'archi', 'army', 'art'];
  const result = elideZones(zones);
  assert.equal(result, '.academy, .actor, .africa, .agency, .airforce, .apartments + 4 more');
});

// ── quality-score ordering (via computeTrending, in-memory zi fixture) ──────

function buildFixtureDb() {
  const db = new Database(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS zi");
  db.exec(`
    CREATE TABLE zi.zone_keyword_tld_history (
      keyword    TEXT NOT NULL,
      trend_date TEXT NOT NULL,
      tld_count  INTEGER NOT NULL,
      tlds_json  TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'daily-diff',
      PRIMARY KEY (keyword, trend_date)
    );
  `);
  return db;
}

test('computeTrending: exact-name mode remains secondary batch evidence and includes noise only on request', () => {
  const db = buildFixtureDb();
  const anchor = '2026-08-19';
  const curatedZones = ['dev', 'app', 'io', 'sh', 'tech', 'cloud'];
  const junkZones = ['autos', 'beauty', 'beer', 'boats', 'casa', 'courses', 'cyou', 'guru', 'hair', 'homes', 'mom', 'pics', 'qpon', 'skin', 'space', 'study'];

  const insert = db.prepare('INSERT INTO zi.zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json) VALUES (?, ?, ?, ?)');
  insert.run('action', anchor, curatedZones.length, JSON.stringify(curatedZones));
  insert.run('jljl88', anchor, junkZones.length, JSON.stringify(junkZones));

  // Default: noise hidden, sorted by qualityScore.
  const defaultResult = computeTrending(db, {});
  assert.equal(defaultResult.sort, 'qualityScore');
  assert.equal(defaultResult.includeNoise, false);
  assert.ok(defaultResult.rows.some(r => r.term === 'action'), 'quality term present by default');
  assert.ok(!defaultResult.rows.some(r => r.term === 'jljl88'), 'bulk-blast noise term hidden by default');

  // includeNoise=1: both present, quality term still ranks first.
  const withNoise = computeTrending(db, { includeNoise: '1' });
  assert.equal(withNoise.includeNoise, true);
  const actionIdx = withNoise.rows.findIndex(r => r.term === 'action');
  const noiseIdx = withNoise.rows.findIndex(r => r.term === 'jljl88');
  assert.ok(actionIdx >= 0 && noiseIdx >= 0, 'both terms present with includeNoise=1');
  assert.ok(actionIdx < noiseIdx, 'quality term ranks above noise term under default qualityScore sort');
  const actionRow = withNoise.rows[actionIdx];
  const noiseRow = withNoise.rows[noiseIdx];
  assert.ok(actionRow.qualityScore > noiseRow.qualityScore, 'quality score numerically higher for the curated-zone real word');
  assert.equal(noiseRow.signal, 'noise');
  assert.equal(actionRow.signal, 'mixed');
  assert.equal(actionRow.worthWatching, false);
  assert.equal(actionRow.momentum, null, 'an absent baseline cannot manufacture momentum');
  assert.ok(actionRow.signalReasons.some(reason => reason.includes('exact-name cross-TLD batch evidence')));

  // sort=spread restores the original raw ordering behavior (still respects includeNoise).
  const rawSort = computeTrending(db, { includeNoise: '1', sort: 'spread' });
  assert.equal(rawSort.sort, 'spread');
  assert.ok(rawSort.rows.some(r => r.term === 'jljl88'), 'raw sort still includes the noise row when includeNoise=1');
});

test('computeTrending defaults to market-relevant zones but preserves the full accessible corpus on request', () => {
  const db = buildFixtureDb();
  db.prepare('INSERT INTO zi.zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json) VALUES (?, ?, ?, ?)')
    .run('agentic', '2026-08-19', 3, JSON.stringify(['app', 'dev', 'abudhabi']));
  assert.deepEqual(computeTrending(db, {}).rows[0].zones, ['app', 'dev']);
  assert.deepEqual(computeTrending(db, { includeAllZones: '1' }).rows[0].zones, ['abudhabi', 'app', 'dev']);
});

function buildFragmentFixtureDb() {
  const db = new Database(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS zi");
  db.exec(`
    CREATE TABLE zi.zone_daily_stats (tld TEXT, stat_date TEXT);
    CREATE TABLE zi.zone_word_trends (
      word TEXT NOT NULL, trend_date TEXT NOT NULL, domain_count INTEGER NOT NULL,
      tld_count INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'word-within-name-daily-diff',
      registration_count INTEGER NOT NULL DEFAULT 0, mirrored_name_count INTEGER NOT NULL DEFAULT 0,
      mirror_rate REAL NOT NULL DEFAULT 0, context_count INTEGER NOT NULL DEFAULT 0,
      position_count INTEGER NOT NULL DEFAULT 0, quality_score REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (word, trend_date)
    );
    CREATE TABLE zi.zone_word_trend_names (
      word TEXT NOT NULL, trend_date TEXT NOT NULL, base_name TEXT NOT NULL, tld TEXT NOT NULL,
      PRIMARY KEY (word, trend_date, base_name, tld)
    ) WITHOUT ROWID;
  `);
  return db;
}

test('computeTrending defaults to vocabulary-free fragment evidence and ranks independent contexts above a mirrored batch', () => {
  const db = buildFragmentFixtureDb();
  const insertTrend = db.prepare(`INSERT INTO zi.zone_word_trends
    (word, trend_date, domain_count, tld_count, registration_count, mirrored_name_count, mirror_rate, context_count, position_count, quality_score)
    VALUES (?, '2026-08-22', ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertTrend.run('lattice', 6, 3, 6, 0, 0, 6, 2, 20);
  insertTrend.run('burstlabel', 1, 8, 8, 1, 1, 1, 1, 100);
  insertTrend.run('orchid', 4, 2, 4, 0, 0, 4, 2, 10);
  db.prepare(`INSERT INTO zi.zone_word_trends
    (word, trend_date, domain_count, tld_count, registration_count, mirrored_name_count, mirror_rate, context_count, position_count, quality_score)
    VALUES ('partial', '2026-08-23', 2, 1, 2, 0, 0, 2, 1, 10)`).run();
  const insertName = db.prepare('INSERT INTO zi.zone_word_trend_names (word, trend_date, base_name, tld) VALUES (?, ?, ?, ?)');
  for (const [name, tld] of [['latticeport', 'dev'], ['latticeflow', 'app'], ['brightlattice', 'com'], ['latticegrid', 'io'], ['latticecore', 'net'], ['mylattice', 'org']]) {
    insertName.run('lattice', '2026-08-22', name, tld);
  }
  for (const tld of ['com', 'net', 'org', 'app', 'dev', 'io', 'co', 'xyz']) insertName.run('burstlabel', '2026-08-22', 'burstlabel', tld);
  for (const [name, tld] of [['orchidpath', 'dev'], ['orchidbeam', 'app'], ['orchidport', 'com'], ['orchidgrid', 'net']]) insertName.run('orchid', '2026-08-22', name, tld);
  insertName.run('partial', '2026-08-23', 'partialone', 'app');
  insertName.run('partial', '2026-08-23', 'partialtwo', 'app');

  const result = computeTrending(db, { window: 21 });
  assert.equal(result.anchor, '2026-08-22');
  assert.deepEqual(result.anchorReceipt.skippedNewerDates.map(row => row.date), ['2026-08-23']);
  assert.equal(result.mode, 'fragments');
  assert.equal(result.rows[0].term, 'lattice');
  assert.equal(result.rows[0].independentNames, 6);
  assert.equal(result.rows[0].contextCount, 6);
  assert.equal(result.rows[0].signal, 'mixed', 'one observed day cannot be called a quality trend');
  assert.equal(result.rows[0].worthWatching, false, 'incomplete date coverage cannot produce a watch badge');
  assert.equal(result.rows.some(row => row.term === 'burstlabel'), false, 'same-label TLD fanout is hidden as noise');
  assert.ok(result.rows.some(row => row.term === 'orchid'), 'unrelated fragment fixture remains discoverable');
  assert.equal(result.coverageComplete, false);
  assert.match(result.coverageNote, /Lower bound: 1 of 21 requested fragment dates/);
  assert.match(result.qualityScoreFormula, /no dictionary or curated keyword\/TLD boost/);
});

test('DomainLab UI defaults to a 21-day repeated-fragment horizon and leaves daily reports secondary', () => {
  const html = fsMod.readFileSync(path2.join(__dirname, '../public/index.html'), 'utf8');
  const analytics = fsMod.readFileSync(path2.join(__dirname, '../public/js/domainlab.js'), 'utf8');
  const daily = fsMod.readFileSync(path2.join(__dirname, '../public/js/domainlab-daily.js'), 'utf8');
  assert.match(html, /21-day horizon · recent 7 days vs prior 14/);
  assert.match(html, /id="dl-window"[^>]+value="7"/);
  assert.match(html, /id="dl-baseline"[^>]+value="14"/);
  assert.match(html, /option value="fragments" selected/);
  assert.match(html, /Daily zone report/);
  assert.doesNotMatch(daily, /appObj\.domainlabLoadAll\s*=\s*function dailyFirst/);
  assert.match(daily, /appObj\.dlShowDaily\s*=\s*function showDaily/);
  assert.match(daily, /domainlabCancelAnalytics/);
  assert.match(analytics, /generation !== state\.loadGeneration \|\| !el\('dl-body'\)/);
});

// ── DomainLab v3a: daily token capture (server/zone-indexer.js) ────────────
const path2 = require('node:path');
const fsMod = require('node:fs');
const os = require('node:os');

test('DomainLab Daily does not render the persistent cross-zone insights banner', () => {
  const source = fsMod.readFileSync(path2.join(__dirname, '../public/js/domainlab-daily.js'), 'utf8');
  assert.doesNotMatch(source, /fetch\('\/api\/domainlab\/insights/);
  assert.doesNotMatch(source, /class="dl-insight"/);
  assert.match(source, /<div class="dl-count-line">\$\{fmt\(state\.tokens\.length\)\} tokens<\/div>/);
});

test('DomainLab routes share a bounded trend cache instead of recomputing the same population for insights', () => {
  const source = fsMod.readFileSync(path2.join(__dirname, '../server/domainlab.js'), 'utf8');
  assert.match(source, /function cachedComputeTrending/);
  assert.match(source, /const trend = cachedComputeTrending\(db, req\.query\)/);
  assert.doesNotMatch(source, /computeTrending\(db, \{ \.\.\.req\.query, limit: 500/);
});

function withTempZoneIndexDb(fn) {
  const dir = fsMod.mkdtempSync(path2.join(os.tmpdir(), 'domainlab-zi-'));
  const prevEnv = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;
  delete require.cache[require.resolve('../server/zone-indexer')];
  const zi = require('../server/zone-indexer');
  try {
    return fn(zi, dir);
  } finally {
    if (prevEnv === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    else process.env.RAILWAY_VOLUME_MOUNT_PATH = prevEnv;
    delete require.cache[require.resolve('../server/zone-indexer')];
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
}

test('recordZoneDailyTokens writes zone_daily_tokens and zone_daily_new_names, aggregating reg_count', () => {
  withTempZoneIndexDb((zi, dir) => {
    zi.recordZoneDailyTokens('xyz', ['rally-talent', 'rallycar'], '2026-08-19', {
      expectedAddedCount: 3, capturedAddedCount: 2, hadPrevious: true, status: 'indexed',
    });
    const raw = new Database(path2.join(dir, 'zone_index.db'));
    const names = raw.prepare('SELECT base_name FROM zone_daily_new_names WHERE tld = ? AND report_date = ? ORDER BY base_name').all('xyz', '2026-08-19');
    assert.deepEqual(names.map(r => r.base_name), ['rally-talent', 'rallycar']);
    const rallyToken = raw.prepare("SELECT reg_count FROM zone_daily_tokens WHERE tld=? AND report_date=? AND token='rally'").get('xyz', '2026-08-19');
    assert.ok(rallyToken, 'rally token recorded');
    assert.equal(rallyToken.reg_count, 2);
    const receipt = raw.prepare("SELECT * FROM zone_daily_capture_receipts WHERE tld='xyz' AND report_date='2026-08-19'").get();
    assert.equal(receipt.expected_added_count, 3);
    assert.equal(receipt.captured_added_count, 2);
    assert.equal(receipt.was_capped, 1);
    raw.close();
  });
});

test('recordZoneDailyTokens prunes rows older than 60 days on each write', () => {
  withTempZoneIndexDb((zi, dir) => {
    zi.recordZoneDailyTokens('xyz', ['oldname'], '2026-01-01');
    zi.recordZoneDailyTokens('xyz', ['newname'], '2026-08-19');
    const raw = new Database(path2.join(dir, 'zone_index.db'));
    const oldRows = raw.prepare("SELECT * FROM zone_daily_new_names WHERE report_date='2026-01-01'").all();
    assert.equal(oldRows.length, 0, 'old rows pruned past 60-day window');
    const newRows = raw.prepare("SELECT * FROM zone_daily_new_names WHERE report_date='2026-08-19'").all();
    assert.equal(newRows.length, 1);
    raw.close();
  });
});

test('recordZoneDailyTokens never throws even with a bad tld/date', () => {
  withTempZoneIndexDb((zi) => {
    assert.doesNotThrow(() => zi.recordZoneDailyTokens('', ['x'], 'not-a-date'));
    assert.doesNotThrow(() => zi.recordZoneDailyTokens('xyz', null, '2026-08-19'));
  });
});

// ── DomainLab v3a: /daily and /daily/domains (server/domainlab.js) ─────────
function buildDailyFixtureDb() {
  const db = new Database(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS zi");
  db.exec(`
    CREATE TABLE zi.zone_daily_tokens (
      tld TEXT NOT NULL, report_date TEXT NOT NULL, token TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 1, reg_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tld, report_date, token)
    ) WITHOUT ROWID;
    CREATE TABLE zi.zone_daily_new_names (
      tld TEXT NOT NULL, report_date TEXT NOT NULL, base_name TEXT NOT NULL,
      PRIMARY KEY (tld, report_date, base_name)
    ) WITHOUT ROWID;
  `);
  return db;
}

test('computeDailyTokens filters by word count and ranks by count desc', () => {
  const db = buildDailyFixtureDb();
  const insert = db.prepare('INSERT INTO zi.zone_daily_tokens (tld, report_date, token, word_count, reg_count) VALUES (?,?,?,?,?)');
  insert.run('xyz', '2026-08-19', 'rally', 1, 5);
  insert.run('xyz', '2026-08-19', 'talent', 1, 3);
  insert.run('xyz', '2026-08-19', 'rally-talent', 2, 2);
  const { computeDailyTokens } = require('../server/domainlab');
  const all = computeDailyTokens(db, { date: '2026-08-19' });
  assert.equal(all.tokens[0].token, 'rally');
  assert.equal(all.totalTokens, 3);
  const oneWord = computeDailyTokens(db, { date: '2026-08-19', words: '1' });
  assert.equal(oneWord.tokens.length, 2);
  assert.ok(oneWord.tokens.every(t => t.wordCount === 1));
  assert.deepEqual(all.dates, ['2026-08-19']);
  assert.equal(all.dataThrough, '2026-08-19');
});

test('computeDailyTokens keeps restricted locality zones behind the all-zones control', () => {
  const db = buildDailyFixtureDb();
  const insert = db.prepare('INSERT INTO zi.zone_daily_tokens (tld, report_date, token, word_count, reg_count) VALUES (?,?,?,?,?)');
  insert.run('dev', '2026-08-19', 'agent', 1, 4);
  insert.run('app', '2026-08-19', 'agent', 1, 3);
  insert.run('abudhabi', '2026-08-19', 'agent', 1, 9);
  const { computeDailyTokens } = require('../server/domainlab');
  assert.deepEqual(computeDailyTokens(db, { date: '2026-08-19' }).zones.map(z => z.tld), ['.dev', '.app']);
  assert.ok(computeDailyTokens(db, { date: '2026-08-19', includeAllZones: '1' }).zones.some(z => z.tld === '.abudhabi'));
});

test('computeDailyDomains matches token against base_name containment and segmentation', () => {
  const db = buildDailyFixtureDb();
  db.prepare('INSERT INTO zi.zone_daily_new_names (tld, report_date, base_name) VALUES (?,?,?)').run('xyz', '2026-08-19', 'rally-talent');
  const { computeDailyDomains } = require('../server/domainlab');
  const result = computeDailyDomains(db, { date: '2026-08-19', zone: 'xyz', token: 'talent' });
  assert.deepEqual(result.names, ['rally-talent.xyz']);
  assert.equal(result.total, 1);
});
