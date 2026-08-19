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
