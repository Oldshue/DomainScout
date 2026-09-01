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
  assert.equal(semanticGroupForTld('.bot'), 'technical');
  assert.equal(semanticGroupForTld('shop'), 'commerce');
  assert.equal(semanticGroupForTld('de'), 'geo');
  assert.equal(semanticGroupForTld('museum'), 'other');
});

test('ZONE_SEMANTIC_GROUPS covers the required seed extensions', () => {
  assert.deepEqual(ZONE_SEMANTIC_GROUPS.technical.sort(), ['ai', 'app', 'bot', 'cloud', 'codes', 'dev', 'io', 'sh', 'tech'].sort());
  assert.ok(ZONE_SEMANTIC_GROUPS.commerce.includes('shop'));
  assert.ok(ZONE_SEMANTIC_GROUPS.finance.includes('capital'));
});

test('market-relevant zones lead DomainLab while restricted locality zones remain opt-in', () => {
  assert.equal(isActionableZone('.dev'), true);
  assert.equal(isActionableZone('.app'), true);
  assert.equal(isActionableZone('.bot'), true);
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

test('computeTrending: default sort ranks a curated-zone quality term above a bulk-blast noise term, and includeNoise/sort=spread restore raw rows', () => {
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
  assert.equal(actionRow.signal, 'quality');

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

test('word trends retain the actual source names and extensions for drill-down', () => {
  const db = buildFixtureDb();
  const insert = db.prepare('INSERT INTO zi.zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json) VALUES (?, ?, ?, ?)');
  insert.run('agentwallet', '2026-08-19', 2, JSON.stringify(['app', 'money']));
  insert.run('agentworkflow', '2026-08-19', 2, JSON.stringify(['dev', 'codes']));

  const row = computeTrending(db, { mode: 'words', q: 'agent' }).rows.find(result => result.term === 'agent');
  assert.ok(row, 'agent word row is present');
  assert.deepEqual(row.sourceTerms, ['agentwallet', 'agentworkflow']);
  assert.deepEqual(row.sourceDomains, [
    'agentwallet.app',
    'agentwallet.money',
    'agentworkflow.codes',
    'agentworkflow.dev',
  ]);
  assert.equal(row.sourceDomainCount, 4);
});

// ── computeTrending: sortBy/sortDir column sort (additive) ──────────────────
// Anchor for all fixtures below is 2026-08-19 (the latest trend_date inserted),
// with default window=7 (2026-08-13..2026-08-19) and baseline=28
// (2026-07-16..2026-08-12), matching computeTrending's own date math.

test('computeTrending sortBy=momentum sortDir=desc orders non-null momentum rows descending (momentum is never null under the current guarded-baseline formula, so no null rows are reachable to place last)', () => {
  const db = buildFixtureDb();
  const insert = db.prepare('INSERT INTO zi.zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json) VALUES (?, ?, ?, ?)');
  const zones = ['dev', 'app'];
  // quickfox: 5 window occurrences, 1 baseline occurrence -> high momentum (~10.0)
  for (const d of ['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17']) {
    insert.run('quickfox', d, zones.length, JSON.stringify(zones));
  }
  insert.run('quickfox', '2026-08-01', zones.length, JSON.stringify(zones));
  // midterm: 2 window occurrences, 2 baseline occurrences -> medium momentum (~2.67)
  insert.run('midterm', '2026-08-18', zones.length, JSON.stringify(zones));
  insert.run('midterm', '2026-08-19', zones.length, JSON.stringify(zones));
  insert.run('midterm', '2026-07-20', zones.length, JSON.stringify(zones));
  insert.run('midterm', '2026-07-21', zones.length, JSON.stringify(zones));
  // slowbear: 1 window occurrence, 5 baseline occurrences -> low momentum (~0.8)
  insert.run('slowbear', '2026-08-19', zones.length, JSON.stringify(zones));
  for (const d of ['2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19', '2026-07-20']) {
    insert.run('slowbear', d, zones.length, JSON.stringify(zones));
  }

  const result = computeTrending(db, { sortBy: 'momentum', sortDir: 'desc' });
  assert.equal(result.sortBy, 'momentum');
  assert.equal(result.sortDir, 'desc');
  const terms = result.rows.map(r => r.term);
  const quickfoxIdx = terms.indexOf('quickfox');
  const midtermIdx = terms.indexOf('midterm');
  const slowbearIdx = terms.indexOf('slowbear');
  assert.ok(quickfoxIdx >= 0 && midtermIdx >= 0 && slowbearIdx >= 0, 'all three terms present');
  assert.ok(quickfoxIdx < midtermIdx, 'higher momentum ranks first');
  assert.ok(midtermIdx < slowbearIdx, 'lower momentum ranks later');
  assert.ok(result.rows.every(r => r.momentum != null), 'no null-momentum rows appear; compareTrendingColumn still sorts null momentum last if ever produced');
});

test('computeTrending sortBy=term (default asc) orders rows alphabetically', () => {
  const db = buildFixtureDb();
  const insert = db.prepare('INSERT INTO zi.zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json) VALUES (?, ?, ?, ?)');
  const zones = ['dev', 'app'];
  insert.run('zeta', '2026-08-19', zones.length, JSON.stringify(zones));
  insert.run('alpha', '2026-08-19', zones.length, JSON.stringify(zones));
  insert.run('delta', '2026-08-19', zones.length, JSON.stringify(zones));

  const result = computeTrending(db, { sortBy: 'term' });
  assert.equal(result.sortBy, 'term');
  assert.equal(result.sortDir, 'asc');
  assert.deepEqual(result.rows.map(r => r.term), ['alpha', 'delta', 'zeta']);
});

test('computeTrending sortBy=windowRegistrations sortDir=desc orders descending window counts', () => {
  const db = buildFixtureDb();
  const insert = db.prepare('INSERT INTO zi.zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json) VALUES (?, ?, ?, ?)');
  const zones = ['dev', 'app'];
  for (const d of ['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17']) {
    insert.run('quickfox', d, zones.length, JSON.stringify(zones));
  }
  insert.run('midterm', '2026-08-18', zones.length, JSON.stringify(zones));
  insert.run('midterm', '2026-08-19', zones.length, JSON.stringify(zones));
  insert.run('slowbear', '2026-08-19', zones.length, JSON.stringify(zones));

  const result = computeTrending(db, { sortBy: 'windowRegistrations', sortDir: 'desc' });
  assert.deepEqual(result.rows.map(r => r.term), ['quickfox', 'midterm', 'slowbear']);
  assert.deepEqual(result.rows.map(r => r.windowRegistrations), [5, 2, 1]);
});

test('computeTrending explicit sortDir=asc inverts a numeric column sort (nulls, when present, still sort last)', () => {
  const db = buildFixtureDb();
  const insert = db.prepare('INSERT INTO zi.zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json) VALUES (?, ?, ?, ?)');
  const zones = ['dev', 'app'];
  for (const d of ['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17']) {
    insert.run('quickfox', d, zones.length, JSON.stringify(zones));
  }
  insert.run('midterm', '2026-08-18', zones.length, JSON.stringify(zones));
  insert.run('midterm', '2026-08-19', zones.length, JSON.stringify(zones));
  insert.run('slowbear', '2026-08-19', zones.length, JSON.stringify(zones));

  const result = computeTrending(db, { sortBy: 'windowRegistrations', sortDir: 'asc' });
  assert.equal(result.sortDir, 'asc');
  assert.deepEqual(result.rows.map(r => r.term), ['slowbear', 'midterm', 'quickfox']);
});

test("computeTrending omitting sortBy yields exactly the same row order as today's default", () => {
  const db = buildFixtureDb();
  const insert = db.prepare('INSERT INTO zi.zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json) VALUES (?, ?, ?, ?)');
  insert.run('action', '2026-08-19', 6, JSON.stringify(['dev', 'app', 'io', 'sh', 'tech', 'cloud']));
  insert.run('midterm', '2026-08-18', 2, JSON.stringify(['dev', 'app']));
  insert.run('midterm', '2026-08-19', 2, JSON.stringify(['dev', 'app']));

  const first = computeTrending(db, {});
  const second = computeTrending(db, {});
  assert.equal(first.sortBy, null);
  assert.equal(first.sortDir, null);
  assert.deepEqual(first.rows.map(r => r.term), second.rows.map(r => r.term));
});

test('computeTrending signal ordering (includeNoise=1) puts quality above mixed above noise', () => {
  const db = buildFixtureDb();
  const insert = db.prepare('INSERT INTO zi.zone_keyword_tld_history (keyword, trend_date, tld_count, tlds_json) VALUES (?, ?, ?, ?)');
  const zones = ['dev', 'app'];
  insert.run('brightstar', '2026-08-19', zones.length, JSON.stringify(zones)); // quality: real words, no digits
  insert.run('ab12cd', '2026-08-19', zones.length, JSON.stringify(zones)); // mixed: digitsRatio 0.33
  insert.run('a1b2c3', '2026-08-19', zones.length, JSON.stringify(zones)); // noise: digitsRatio 0.5

  const result = computeTrending(db, { includeNoise: '1', sortBy: 'signal' });
  assert.equal(result.sortBy, 'signal');
  assert.equal(result.sortDir, 'desc');
  const terms = result.rows.map(r => r.term);
  const qualityIdx = terms.indexOf('brightstar');
  const mixedIdx = terms.indexOf('ab12cd');
  const noiseIdx = terms.indexOf('a1b2c3');
  assert.ok(qualityIdx >= 0 && mixedIdx >= 0 && noiseIdx >= 0, 'all three terms present with includeNoise=1');
  assert.equal(result.rows[qualityIdx].signal, 'quality');
  assert.equal(result.rows[mixedIdx].signal, 'mixed');
  assert.equal(result.rows[noiseIdx].signal, 'noise');
  assert.ok(qualityIdx < mixedIdx, 'quality ranks above mixed');
  assert.ok(mixedIdx < noiseIdx, 'mixed ranks above noise');
});

// ── DomainLab v3a: daily token capture (server/zone-indexer.js) ────────────
const path2 = require('node:path');
const fsMod = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('DomainLab Daily does not render the persistent cross-zone insights banner', () => {
  const source = fsMod.readFileSync(path2.join(__dirname, '../public/js/domainlab-daily.js'), 'utf8');
  assert.doesNotMatch(source, /fetch\('\/api\/domainlab\/insights/);
  assert.doesNotMatch(source, /class="dl-insight"/);
  assert.match(source, /<div class="dl-count-line">\$\{fmt\(state\.tokens\.length\)\} tokens<\/div>/);
});

test('DomainLab browser modules are syntax-valid independently', () => {
  for (const file of ['domainlab.js', 'domainlab-daily.js']) {
    const result = spawnSync(process.execPath, ['--check', path2.join(__dirname, '../public/js', file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('DomainLab analytics cannot recreate the persistent insights banner', () => {
  const source = fsMod.readFileSync(path2.join(__dirname, '../public/js/domainlab.js'), 'utf8');
  const markup = fsMod.readFileSync(path2.join(__dirname, '../public/index.html'), 'utf8');
  const server = fsMod.readFileSync(path2.join(__dirname, '../server/domainlab.js'), 'utf8');
  assert.doesNotMatch(source, /fetch\(`?\/api\/domainlab\/insights/);
  assert.doesNotMatch(source, /renderInsights/);
  assert.doesNotMatch(markup, /id="dl-insights"/);
  assert.match(server, /app\.get\('\/api\/domainlab\/insights'/,
    'the underlying evidence API remains available to non-banner consumers');
});

test('DomainLab word drill renders the names behind the phrase before exact-base reference data', () => {
  const source = fsMod.readFileSync(path2.join(__dirname, '../public/js/domainlab.js'), 'utf8');
  assert.match(source, /Names observed in this window/);
  assert.match(source, /trendRow\?\.sourceDomains/);
  assert.match(source, /Current zones for the exact base/);
});

test('DomainLab Analytics refresh stays in Analytics after the Daily shell is restored', () => {
  const source = fsMod.readFileSync(path2.join(__dirname, '../public/js/domainlab-daily.js'), 'utf8');
  assert.match(source, /const refresh = el\('dl-refresh'\)/);
  assert.match(source, /refresh\.onclick = \(event\) =>/);
  assert.match(source, /appObj\.domainlabRenderAnalyticsShell\(\)/);
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
    zi.recordZoneDailyTokens('xyz', ['rally-talent', 'rallycar'], '2026-08-19');
    const raw = new Database(path2.join(dir, 'zone_index.db'));
    const names = raw.prepare('SELECT base_name FROM zone_daily_new_names WHERE tld = ? AND report_date = ? ORDER BY base_name').all('xyz', '2026-08-19');
    assert.deepEqual(names.map(r => r.base_name), ['rally-talent', 'rallycar']);
    const rallyToken = raw.prepare("SELECT reg_count FROM zone_daily_tokens WHERE tld=? AND report_date=? AND token='rally'").get('xyz', '2026-08-19');
    assert.ok(rallyToken, 'rally token recorded');
    assert.equal(rallyToken.reg_count, 2);
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
  insert.run('bot', '2026-08-19', 'agent', 1, 2);
  insert.run('abudhabi', '2026-08-19', 'agent', 1, 9);
  const { computeDailyTokens } = require('../server/domainlab');
  assert.deepEqual(computeDailyTokens(db, { date: '2026-08-19' }).zones.map(z => z.tld), ['.dev', '.app', '.bot']);
  assert.ok(computeDailyTokens(db, { date: '2026-08-19', includeAllZones: '1' }).zones.some(z => z.tld === '.abudhabi'));
});

test('daily UI keeps .bot in the preferred zone dropdown', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/domainlab-daily.js'), 'utf8');
  assert.match(source, /const lead = \['com', 'app', 'dev', 'bot', 'net', 'org'\]/);
});

test('computeDailyDomains matches token against base_name containment and segmentation', () => {
  const db = buildDailyFixtureDb();
  db.prepare('INSERT INTO zi.zone_daily_new_names (tld, report_date, base_name) VALUES (?,?,?)').run('xyz', '2026-08-19', 'rally-talent');
  const { computeDailyDomains } = require('../server/domainlab');
  const result = computeDailyDomains(db, { date: '2026-08-19', zone: 'xyz', token: 'talent' });
  assert.deepEqual(result.names, ['rally-talent.xyz']);
  assert.equal(result.total, 1);
});
