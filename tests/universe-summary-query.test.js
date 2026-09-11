'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const zlib = require('node:zlib');

const { buildUniverseSummaryTape, importUniverseSummaryTape, openUniverseSummary } = require('../server/universe-summary');
const { parseResearchQuery } = require('../server/research-query');

// dotDB-parity query-model coverage against a tiny fixture universe-summary
// db built the same way production tapes are built (buildUniverseSummaryTape
// + importUniverseSummaryTape), then queried through the model-aware SQL path
// (server/universe-summary.js runModelQuery/countModelQuery, reached via
// opts.model) using models produced by the real parseResearchQuery parser.

async function makeGz(dir, tld, lines) {
  await fs.writeFile(path.join(dir, `${tld}.names.gz`), zlib.gzipSync(`${lines.join('\n')}\n`));
}

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Fixture layout (5 zones: com, net, ai, io, biz). Every label needs >=2
// zones to survive the default minZones=2 tape build.
const ZONE_LABELS = {
  com: ['newyorkcitytours', 'newyorkbustours', 'toursnewyork', 'buzzfizz', 'shop123', 'shopnow',
        'newyork', 'new-york', 'xn--test1', 'aaaa', 'aaaaaaaaaa', 'samea', 'sameb', 'samec',
        'extcomnet', 'exttld5'],
  net: ['newyorkcitytours', 'newyorkbustours', 'toursnewyork', 'buzzfizz', 'shop123', 'shopnow',
        'newyork', 'new-york', 'xn--test1', 'aaaa', 'aaaaaaaaaa', 'samea', 'sameb', 'samec',
        'extcomnet', 'exttld5'],
  ai: ['newyorkcitytours', 'samea', 'samec', 'exttld5'],
  io: ['exttld5'],
  biz: ['exttld5'],
};

let dirs = [];
let summary;

before(async () => {
  const namesDir = await tmpDir('domainscout-usq-names-');
  const outDir = await tmpDir('domainscout-usq-out-');
  const dataDir = await tmpDir('domainscout-usq-data-');
  dirs = [namesDir, outDir, dataDir];
  for (const [tld, labels] of Object.entries(ZONE_LABELS)) {
    await makeGz(namesDir, tld, labels);
  }
  const built = await buildUniverseSummaryTape({ namesDir, day: '2026-09-05', outDir });
  await importUniverseSummaryTape({ tapePath: built.tapePath, dataDir });
  summary = openUniverseSummary(dataDir);
  assert.ok(summary, 'fixture summary db failed to open');
});

after(async () => {
  if (summary) summary.close();
  await Promise.all(dirs.map(d => fs.rm(d, { recursive: true, force: true })));
});

function namesOf(model, opts = {}) {
  return summary.query(null, null, { model, includeTldList: false, ...opts }).map(r => r.base_name);
}

// ── multi-in-order ("New York Tours" also matches newyorkcitytours,
// newyorkbustours — parts in order with anything between) ──────────────────

test('multi-in-order matches parts anywhere in order (dotDB "New York Tours" example)', () => {
  const model = parseResearchQuery({ q: 'new york tours', position: 'any' });
  assert.equal(model.multi, true);
  const names = namesOf(model).sort();
  assert.deepEqual(names, ['newyorkbustours', 'newyorkcitytours']);
});

// ── shuffle vs anchored order ────────────────────────────────────────────────

test('shuffle matches any permutation of the parts; "any" position enforces the given order', () => {
  const anyModel = parseResearchQuery({ q: 'fizz buzz', position: 'any' });
  assert.deepEqual(namesOf(anyModel), []);

  const shuffleModel = parseResearchQuery({ q: 'fizz buzz', position: 'shuffle' });
  assert.equal(shuffleModel.position, 'shuffle');
  assert.deepEqual(namesOf(shuffleModel), ['buzzfizz']);
});

// ── exclude ──────────────────────────────────────────────────────────────────

test('exclude removes labels containing the excluded term', () => {
  const model = parseResearchQuery({ q: 'shop', position: 'any', exclude: '123' });
  assert.deepEqual(namesOf(model), ['shopnow']);
});

test('inline "-term" tokens inside q exclude the same way as the exclude param', () => {
  const model = parseResearchQuery({ q: 'shop -123', position: 'any' });
  assert.deepEqual(model.exclude, ['123']);
  assert.deepEqual(namesOf(model), ['shopnow']);
});

// ── digits filter ─────────────────────────────────────────────────────────────

test('digits filter: none excludes digit labels, only keeps digit labels', () => {
  const noneModel = parseResearchQuery({ q: 'shop', position: 'any', digits: 'none' });
  assert.deepEqual(namesOf(noneModel), ['shopnow']);

  const onlyModel = parseResearchQuery({ q: 'shop', position: 'any', digits: 'only' });
  assert.deepEqual(namesOf(onlyModel), ['shop123']);
});

// ── hyphens filter ────────────────────────────────────────────────────────────

test('hyphens filter: none excludes hyphenated labels', () => {
  const model = parseResearchQuery({ q: 'york', position: 'any', hyphens: 'none' });
  const names = namesOf(model).sort();
  assert.deepEqual(names, ['newyork', 'newyorkbustours', 'newyorkcitytours', 'toursnewyork']);
  assert.ok(!names.includes('new-york'));
});

// ── idn filter ────────────────────────────────────────────────────────────────

test('idn filter: none excludes xn-- labels; default (any) keeps them', () => {
  const noneModel = parseResearchQuery({ q: 'test1', position: 'any', idn: 'none' });
  assert.deepEqual(namesOf(noneModel), []);

  const anyModel = parseResearchQuery({ q: 'test1', position: 'any' });
  assert.deepEqual(namesOf(anyModel), ['xn--test1']);
});

// ── length filter ─────────────────────────────────────────────────────────────

test('length filter: minLength/maxLength bound the label length', () => {
  const minModel = parseResearchQuery({ q: 'aa', position: 'any', minLength: '5' });
  assert.deepEqual(namesOf(minModel), ['aaaaaaaaaa']);

  const maxModel = parseResearchQuery({ q: 'aa', position: 'any', maxLength: '5' });
  assert.deepEqual(namesOf(maxModel), ['aaaa']);
});

// ── extensions filter (exact zone-truth membership, not an estimate) ─────────

test('extensions filter: keeps only labels registered in every requested tld', () => {
  const model = parseResearchQuery({ q: 'ext', position: 'any', tlds: '.io' });
  assert.deepEqual(model.filters.extensions, ['.io']);
  assert.deepEqual(namesOf(model), ['exttld5']);
});

// ── deterministic ordering + exact whole-root count() ────────────────────────

test('ordering is deterministic: extension count desc, then label asc; count() matches the row count', () => {
  const model = parseResearchQuery({ q: 'same', position: 'beginning' });
  const rows = summary.query(null, null, { model, includeTldList: false });
  assert.deepEqual(rows.map(r => r.base_name), ['samea', 'samec', 'sameb']);
  assert.deepEqual(rows.map(r => r.tld_count), [3, 3, 2]);
  assert.equal(summary.count(null, null, { model }), 3);
});

// ── paging: offset/limit honoured exactly, same as the legacy term/mode path ─

test('offset/limit page the model query exactly, and includeTldList returns the exact zone list', () => {
  const model = parseResearchQuery({ q: 'same', position: 'beginning' });
  const page1 = summary.query(null, null, { model, limit: 2, offset: 0, includeTldList: true });
  const page2 = summary.query(null, null, { model, limit: 2, offset: 2, includeTldList: true });
  assert.deepEqual(page1.map(r => r.base_name), ['samea', 'samec']);
  assert.deepEqual(page2.map(r => r.base_name), ['sameb']);
  assert.equal(page1[0].tld_list, '.ai,.com,.net');
});

// ── old params keep working unchanged (superset, not a replacement) ──────────

test('legacy prefix/term params still work unchanged through parseResearchQuery + runQuery', () => {
  const model = parseResearchQuery({ prefix: 'shop' });
  assert.equal(model.multi, false);
  assert.equal(model.position, 'beginning');
  const rows = summary.query(null, null, { model, includeTldList: false });
  assert.deepEqual(rows.map(r => r.base_name).sort(), ['shop123', 'shopnow']);
});
