'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createUniverseLane } = require('../server/universe-lane');
const { createUniverseThemeEngine, registerUniverseThemeRoutes } = require('../server/universe-themes');

function havePython3() {
  const r = spawnSync('python3', ['--version'], { timeout: 10000 });
  return !r.error && r.status === 0;
}

const ZONES = ['com', 'net', 'org', 'io', 'app'];

// 14 distinct EXTRA/dictionary words paired with "cloud"/"portal" so seg() (the
// vendored miner's tokenizer, greedy longest-match) recognizes BOTH halves of
// every label as real tokens (>=2 recognized tokens is required before a label
// counts toward any theme at all). "portal" (unlike "signal") has no leading-
// letter collision with any of these words' own real-word plural/inflected
// forms (e.g. "edges", "grids", "funds" are real words that would otherwise
// swallow a following "s..." token under greedy longest-match tokenization --
// a real, observed characteristic of the vendored, unmodified engine, not a
// bug in this test or in server/universe-themes.js). Each pairing is a
// distinct string, so each independently falls back to its own root
// (independence axis), giving 14 independent members per theme -- above the
// engine's n>=12 floor and above the >=12-after-kit-collapse floor.
const INDEP_WORDS = ['edge', 'mesh', 'grid', 'chain', 'fund', 'quant', 'alpha',
  'forecast', 'insight', 'intel', 'wallet', 'node', 'stack', 'flow'];

// Distinct 12-word reference-span theme (paired with "storage", never combined
// with cloud/portal) so the reference span's own theme-convergence.py load()
// produces a *non-empty* `ref` dict. The vendored script treats an empty
// reference dict exactly like "no reference at all" (Python falsy-dict
// check), which silently empties every output bucket regardless of the
// current span's signal -- so a genuinely present, unrelated reference theme
// is required for realistic coverage, not just a reference tape file that
// exists.
const REF_WORDS = ['edge', 'mesh', 'grid', 'chain', 'fund', 'quant', 'alpha',
  'forecast', 'insight', 'intel', 'wallet', 'node'];

const CURRENT_DAYS = ['2026-09-10', '2026-09-11', '2026-09-13', '2026-09-14']; // 09-12 deliberately absent
const REF_DAYS = ['2026-09-06', '2026-09-07', '2026-09-09']; // 09-08 deliberately absent

function buildCurrentRows() {
  const rows = [];
  INDEP_WORDS.forEach((word, i) => { rows.push({ label: `${word}cloud`, zone: ZONES[i % ZONES.length], day: CURRENT_DAYS[i % CURRENT_DAYS.length] }); });
  for (let i = 1; i <= 20; i += 1) {
    rows.push({ label: `vaultcloud${i}`, zone: ZONES[i % ZONES.length], day: CURRENT_DAYS[i % CURRENT_DAYS.length] });
  }
  INDEP_WORDS.forEach((word, i) => { rows.push({ label: `${word}portal`, zone: ZONES[(i + 2) % ZONES.length], day: CURRENT_DAYS[(i + 1) % CURRENT_DAYS.length] }); });
  CURRENT_DAYS.forEach(day => rows.push({ label: `filler${day.replace(/-/g, '')}zzq`, zone: 'com', day }));
  return rows;
}

function buildReferenceRows() {
  const rows = [];
  REF_WORDS.forEach((word, i) => { rows.push({ label: `${word}storage`, zone: ZONES[i % ZONES.length], day: REF_DAYS[i % REF_DAYS.length] }); });
  REF_DAYS.forEach(day => rows.push({ label: `reffiller${day.replace(/-/g, '')}zzq`, zone: 'com', day }));
  return rows;
}

async function buildFixtureUniverse(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'domainscout-universe-themes-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const allRows = [...buildCurrentRows(), ...buildReferenceRows()];
  const byDay = new Map();
  for (const row of allRows) {
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day).push(row);
  }
  for (const [day, rows] of byDay) {
    const tape = path.join(directory, day, 'tape');
    await fsp.mkdir(tape, { recursive: true });
    const lines = rows.map(({ label, zone }) => `${label}\t${zone}\t${day}T00:00:00Z`);
    await fsp.writeFile(path.join(tape, 'adds.tsv'), `${lines.join('\n')}\n`);
    await fsp.writeFile(path.join(tape, 'zones.json'), JSON.stringify({ zones: [...new Set(rows.map(r => r.zone))] }));
  }
  const lane = createUniverseLane({ directory });
  return { directory, lane };
}

test('kit-collapsed theme is reported and ranked below the independent theme; missing days are reported for both spans', async t => {
  if (!havePython3()) { t.skip('python3 is not available in this sandbox'); return; }

  const { lane } = await buildFixtureUniverse(t);
  const engine = createUniverseThemeEngine({ lane, log: { warn() {}, log() {}, error() {} } });

  const range = { from: '2026-09-10', to: '2026-09-14', refFrom: '2026-09-06', refTo: '2026-09-09' };
  const result = await engine.computeRange(range);

  assert.deepEqual(result.coverage.daysMissing, ['2026-09-12'], 'the one absent day in the current span must be reported, not silently skipped');
  assert.deepEqual(result.coverage.daysPresent, CURRENT_DAYS);
  assert.equal(result.coverage.comPresent, true);
  assert.deepEqual(result.referenceCoverage.daysMissing, ['2026-09-08'], 'the one absent day in the reference span must be reported, not silently skipped');
  assert.deepEqual(result.referenceCoverage.daysPresent, REF_DAYS);

  const cloud = result.themes.find(theme => theme.theme === 'cloud');
  const portal = result.themes.find(theme => theme.theme === 'portal');
  assert.ok(cloud, 'expected the "cloud" theme (independent members + a collapsed single-actor kit) to be reported');
  assert.ok(portal, 'expected the fully independent "portal" theme to be reported');

  assert.equal(cloud.kitCollapsed, true, 'the vaultcloud1..20 single-actor kit must be flagged as collapsed');
  assert.equal(portal.kitCollapsed, false, 'portal has no single-actor kit and must not be flagged');
  assert.ok(cloud.labels >= 12, 'cloud must still have >=12 kept labels after collapse to remain reportable');
  assert.ok(cloud.convergence < portal.convergence,
    `kit-collapsed cloud (${cloud.convergence}) must score below fully-independent portal (${portal.convergence})`);
  const cloudRank = result.themes.findIndex(theme => theme.theme === 'cloud');
  const portalRank = result.themes.findIndex(theme => theme.theme === 'portal');
  assert.ok(portalRank < cloudRank, 'the independent theme must rank above the kit-collapsed theme');

  assert.ok(cloud.examples.length <= 12);
  assert.ok(cloud.examples.every(ex => !ex.label.startsWith('vaultcloud')), 'collapsed kit members must not appear as examples of the surviving theme');
});

test('concurrent getOrCompute calls for one range start exactly one background job', async t => {
  if (!havePython3()) { t.skip('python3 is not available in this sandbox'); return; }
  const { lane } = await buildFixtureUniverse(t);
  const engine = createUniverseThemeEngine({ lane, log: { warn() {}, log() {}, error() {} } });
  const range = { from: '2026-09-10', to: '2026-09-14', refFrom: '2026-09-06', refTo: '2026-09-09' };

  const [first, second] = await Promise.all([engine.getOrCompute(range), engine.getOrCompute(range)]);
  assert.equal(first.status, 'pending');
  assert.equal(second.status, 'pending');
  assert.equal(first.job, second.job, 'both concurrent requests must observe the same single deduplicated job');
  assert.equal(engine._jobs.size, 1);
  await first.job.promise;
  const third = await engine.getOrCompute(range);
  assert.equal(third.status, 'ready');
});

// Mounts the route on a minimal fake Express app that only records the
// GET handler, then invokes it directly against mock req/res. This sandbox
// refuses real TCP listen() calls (EPERM on both 0.0.0.0 and 127.0.0.1), so
// exercising the actual registered handler function is the reliable way to
// test the route's request/response contract here without weakening what's
// under test: the same registerUniverseThemeRoutes()-installed handler runs,
// unmodified, against a real Express-shaped req.query and a res double.
function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.set = (key, value) => { res.headers[key] = value; return res; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.statusCode = res.statusCode || 200; return res; };
  return res;
}

test('GET /api/universe/themes: validates limit, filters by q, and answers 202 then 200', async t => {
  if (!havePython3()) { t.skip('python3 is not available in this sandbox'); return; }
  const { lane } = await buildFixtureUniverse(t);
  const engine = createUniverseThemeEngine({ lane, log: { warn() {}, log() {}, error() {} } });
  let handler = null;
  const fakeApp = { get(routePath, h) { if (routePath === '/api/universe/themes') handler = h; } };
  registerUniverseThemeRoutes(fakeApp, engine);
  assert.ok(handler, 'registerUniverseThemeRoutes must register a GET /api/universe/themes handler');

  const rangeQuery = { from: '2026-09-10', to: '2026-09-14', refFrom: '2026-09-06', refTo: '2026-09-09' };

  const badLimitRes = mockRes();
  await handler({ query: { ...rangeQuery, limit: '0' } }, badLimitRes);
  assert.equal(badLimitRes.statusCode, 400);

  const pendingRes = mockRes();
  await handler({ query: { ...rangeQuery, limit: '250' } }, pendingRes);
  assert.equal(pendingRes.statusCode, 202);
  assert.equal(pendingRes.body.status, 'pending');

  const key = '2026-09-10:2026-09-14:2026-09-06:2026-09-09';
  const job = engine._jobs.get(key);
  assert.ok(job, 'the handler invocation must have started a tracked background job');
  await job.promise;

  const readyRes = mockRes();
  await handler({ query: { ...rangeQuery, limit: '250', q: 'por' } }, readyRes);
  assert.equal(readyRes.statusCode, 200);
  assert.ok(readyRes.body.themes.length >= 1);
  assert.ok(readyRes.body.themes.every(theme => theme.theme.includes('por')), 'q must filter themes by substring');
  assert.ok(!readyRes.body.themes.some(theme => theme.theme === 'cloud'), 'q=por must exclude the cloud theme');
  assert.deepEqual(readyRes.body.referenceCoverage.daysMissing, ['2026-09-08'], 'referenceCoverage.daysMissing must report the missing reference day on every 200');
  assert.deepEqual(readyRes.body.referenceCoverage.daysPresent, REF_DAYS, 'referenceCoverage.daysPresent must list the present reference days');
  assert.equal(readyRes.body.riseBasis, 'partial-reference', 'a partial reference span must set riseBasis to partial-reference');
});
