'use strict';
// Verifies the engine-parameter scaling work: theme-convergence.py's minimums
// (theme/member count, family-root count, rising/new independentRoots, minimum
// token count, alwaysRank) are now CLI-configurable via --options, default to
// the exact pre-existing registration-scale hardcoded constants, and are scaled
// down by server/universe-themes.js's SALES_ENGINE_OPTIONS for source=sales so a
// week's few-hundred-to-few-thousand-label Sale Watch tape can actually produce
// themes (three to five independent buyers of one construction is the signal,
// and one-word names must contribute their token).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  createUniverseThemeEngine,
  rangeKey,
  safeRangeSlug,
  DEFAULT_ENGINE_OPTIONS,
  SALES_ENGINE_OPTIONS,
  engineOptionsDigest,
} = require('../server/universe-themes');

const REPO_ROOT = path.join(__dirname, '..');
const CODE_DIR = path.join(REPO_ROOT, 'scripts', 'universe');
const THEME_CONVERGENCE = path.join(CODE_DIR, 'theme-convergence.py');
const MINE_UNIVERSE_TYPES = path.join(CODE_DIR, 'mine-universe-types.py');

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`python3 ${args.join(' ')} timed out after 30s`));
    }, 30000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`python3 ${args.join(' ')} exited ${code}\n${stderr}`));
    });
  });
}

function makeWorkDir(rows) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-themes-scaling-'));
  fs.mkdirSync(path.join(work, 'tape'), { recursive: true });
  const lines = rows.map(([lab, tld]) => `${lab}\t${tld}\t2026-09-10`);
  fs.writeFileSync(path.join(work, 'tape', 'adds.tsv'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(work, 'universe-types.json'), JSON.stringify({ rows: [], brandFamilies: [] }));
  return work;
}

function writeOptions(options) {
  const optionsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'universe-themes-opts-')), 'options.json');
  fs.writeFileSync(optionsPath, JSON.stringify(options));
  return optionsPath;
}

// A sale-scale "orbit" construction: 3 multi-token labels plus one one-word
// label, all carrying the dictionary token "orbit" (a non-generic dictionary
// token recognised by the segmenter; unlike "market" it is not in the engine's
// GENERIC stop-list, so it can actually surface as a theme). At
// registration-scale minimums (themeMin=12) this is dropped entirely
// (v["n"] < 12); at sales-scale minimums (themeMin=3, memberMin=3,
// independentRootsMin=3, minTokens=1, including single-token labels) it
// clears every gate.
const SALES_SCALE_ROWS = [
  ['orbit', 'com'],
  ['primeorbit', 'com'],
  ['harbororbit', 'net'],
  ['trailorbit', 'io'],
];

test('registration-scale defaults drop a sales-scale (4-label) construction entirely', async (t) => {
  if (!fs.existsSync(MINE_UNIVERSE_TYPES)) { t.skip('mine-universe-types.py not present'); return; }
  const work = makeWorkDir(SALES_SCALE_ROWS);
  await runPython([THEME_CONVERGENCE, work]);
  const tc = JSON.parse(fs.readFileSync(path.join(work, 'theme-convergence.json'), 'utf8'));
  for (const bucket of ['rising', 'new', 'stable', 'fading', 'unranked']) {
    assert.ok(!(tc[bucket] || []).some(r => r.theme === 'orbit'),
      `bucket ${bucket} must not contain "orbit" under registration-scale (unparameterized) defaults: this is the live 2026-09-24 zero-themes bug`);
  }
});

test('sales-scaled minimums (SALES_ENGINE_OPTIONS) surface the same 4-label construction, including its one-word member, with rise:null (thin/absent reference span)', async (t) => {
  if (!fs.existsSync(MINE_UNIVERSE_TYPES)) { t.skip('mine-universe-types.py not present'); return; }
  const work = makeWorkDir(SALES_SCALE_ROWS);
  const optionsPath = writeOptions(SALES_ENGINE_OPTIONS);
  await runPython([THEME_CONVERGENCE, work, '--options', optionsPath]);
  const tc = JSON.parse(fs.readFileSync(path.join(work, 'theme-convergence.json'), 'utf8'));
  assert.ok(Array.isArray(tc.unranked), 'theme-convergence.json must carry an "unranked" bucket when alwaysRank is set');
  const row = ['rising', 'new', 'stable', 'fading', 'unranked'].map(b => (tc[b] || []).find(r => r.theme === 'orbit')).find(Boolean);
  assert.ok(row, 'the 4-label "orbit" construction must be present somewhere once minimums are scaled to sales input');
  assert.equal(row.rise, null, 'with no admitted reference-span entries, rise must be null rather than causing the theme to be dropped');
  assert.ok(row.independentRoots >= 3, 'independentRoots must clear the scaled sales minimum of 3');
  assert.ok(row.members.includes('orbit'), 'the single-token (one-word) label must contribute to the theme membership, not be skipped for having fewer than two tokens');
});

test('DEFAULT_ENGINE_OPTIONS reproduces byte-identical theme-convergence.json to omitting --options entirely (registrations output unchanged)', async (t) => {
  if (!fs.existsSync(MINE_UNIVERSE_TYPES)) { t.skip('mine-universe-types.py not present'); return; }
  const zones = ['com', 'net', 'org', 'io', 'app'];
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const root = `zzroot${i}`;
    rows.push([`${root}market`, zones[i % zones.length]]);
    rows.push([`market${root}`, zones[(i + 1) % zones.length]]);
  }
  const workA = makeWorkDir(rows);
  const workB = makeWorkDir(rows);
  await runPython([THEME_CONVERGENCE, workA]);
  const optionsPath = writeOptions(DEFAULT_ENGINE_OPTIONS);
  await runPython([THEME_CONVERGENCE, workB, '--options', optionsPath]);
  const outA = fs.readFileSync(path.join(workA, 'theme-convergence.json'), 'utf8');
  const outB = fs.readFileSync(path.join(workB, 'theme-convergence.json'), 'utf8');
  assert.equal(outA, outB, 'passing --options with DEFAULT_ENGINE_OPTIONS must produce byte-identical output to omitting --options entirely');
});

test('rangeKey/safeRangeSlug change when the engine-options digest changes (sales cache invalidation), and DEFAULT/SALES option digests differ', () => {
  const range = { from: '2026-09-08', to: '2026-09-14', refFrom: '2026-09-01', refTo: '2026-09-07' };
  const keyA = rangeKey({ source: 'sales', ...range, optionsDigest: 'digest-aaa' });
  const keyB = rangeKey({ source: 'sales', ...range, optionsDigest: 'digest-bbb' });
  assert.notEqual(keyA, keyB, 'rangeKey must change when the engine-options digest changes for the same range/source');

  const slugA = safeRangeSlug({ source: 'sales', ...range, optionsDigest: 'digest-aaa' });
  const slugB = safeRangeSlug({ source: 'sales', ...range, optionsDigest: 'digest-bbb' });
  assert.notEqual(slugA, slugB, 'safeRangeSlug (and therefore the persisted-result file path) must change when the engine-options digest changes');

  assert.notEqual(engineOptionsDigest(DEFAULT_ENGINE_OPTIONS), engineOptionsDigest(SALES_ENGINE_OPTIONS),
    'DEFAULT_ENGINE_OPTIONS and SALES_ENGINE_OPTIONS must carry distinct digests, since a real minimums change must invalidate stored sales results');

  // registrations format must stay the exact pre-existing bare string even when an optionsDigest is supplied
  assert.equal(rangeKey({ source: 'registrations', ...range, optionsDigest: 'digest-aaa' }), '2026-09-08:2026-09-14:2026-09-01:2026-09-07');
});

test('end-to-end: source=sales computeRange surfaces a theme carried by 4 independent built buyers of one construction, including a one-word member, with rise:null', async (t) => {
  if (!fs.existsSync(MINE_UNIVERSE_TYPES)) { t.skip('mine-universe-types.py not present'); return; }
  const universeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-themes-sales-e2e-'));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-themes-sales-e2e-scratch-'));
  t.after(async () => {
    await fsp.rm(universeDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  });

  function builtEntry(domain, buyerId) {
    return {
      domain,
      tier: 'probable',
      classification: 'likely-sale',
      reportDate: '2026-09-10',
      buyerNameservers: [`ns1.${buyerId}.example`, `ns2.${buyerId}.example`],
      buyerTitle: `${buyerId} Holdings`,
      assessment: { buyerUse: true, transfer: { fromRegistrar: 'GoDaddy', toRegistrar: `Registrar-${buyerId}` } },
    };
  }
  const entries = [
    builtEntry('orbit.com', 'buyerA'),
    builtEntry('primeorbit.com', 'buyerB'),
    builtEntry('harbororbit.net', 'buyerC'),
    builtEntry('trailorbit.io', 'buyerD'),
  ];

  const engine = createUniverseThemeEngine({
    lane: { directory: universeDir, listDays: async () => [] },
    log: { warn() {}, log() {}, error() {} },
    scratchDir,
    classifierVersion: 'sales-scaling-test-v1',
    saleWatchLedgerLoader: () => ({ entries, classifierVersion: 'sales-scaling-test-v1' }),
  });

  const range = { from: '2026-09-08', to: '2026-09-14', refFrom: '2026-09-01', refTo: '2026-09-07' };
  const result = await engine.computeRange(range, 'sales');
  assert.equal(result.source, 'sales');

  const theme = result.themes.find(t => t.theme === 'orbit');
  assert.ok(theme, 'the "orbit" construction carried by 4 independent built buyers (including the one-word "orbit" label itself) must be returned for source=sales');
  assert.equal(theme.rise, null, 'with no reference-span entries, the theme must still be returned with rise:null rather than dropped');
  assert.equal(theme.buyers, 4, 'all 4 distinct buyer-nameserver destinations must be counted independently');
  assert.equal(theme.builtCount, 4, 'all 4 members are built (assessment.buyerUse:true) and must all count toward builtCount');
  assert.ok(theme.buyerIndependence > 0.5, `4 equally-weighted independent buyers must yield high buyerIndependence, got ${theme.buyerIndependence}`);

  // Persisted result path must be keyed distinctly from a registrations result
  // for the identical range (per-source caching), and confirms requirement 4
  // (engine-options digest folded into the sales cache key) round-trips through
  // a real computeRange call, not just the rangeKey/safeRangeSlug unit test above.
  const salesPath = engine.resultPathFor(range, 'sales');
  const registrationsPath = engine.resultPathFor(range, 'registrations');
  assert.notEqual(salesPath, registrationsPath);
  assert.ok(fs.existsSync(salesPath), 'the sales result must be persisted at its per-source, options-digest-qualified path');
});
