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

test('computeDailyDomains matches token against base_name containment and segmentation', () => {
  const db = buildDailyFixtureDb();
  db.prepare('INSERT INTO zi.zone_daily_new_names (tld, report_date, base_name) VALUES (?,?,?)').run('xyz', '2026-08-19', 'rally-talent');
  const { computeDailyDomains } = require('../server/domainlab');
  const result = computeDailyDomains(db, { date: '2026-08-19', zone: 'xyz', token: 'talent' });
  assert.deepEqual(result.names, ['rally-talent.xyz']);
  assert.equal(result.total, 1);
});
