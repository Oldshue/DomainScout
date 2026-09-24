'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  isLikelySaleEntry,
  likelySalesInSpan,
  computeThemeBuyerStats,
} = require('../server/sale-watch-theme-source');
const {
  transformSalesEngineRows,
  transformEngineRows,
  rangeKey,
  safeRangeSlug,
  createUniverseThemeEngine,
  DEFAULT_SOURCE,
} = require('../server/universe-themes');
const {
  SALES_ENGINE_OPTIONS,
  engineOptionsDigest,
} = require('../server/universe-themes');

// ---------------------------------------------------------------------------
// 1) Buyer independence must outrank raw convergence/label-count: five
//    independent built buyers of one construction must rank above a 40-name
//    single-destination batch, even when the batch's raw engine convergence
//    is set far higher than the independent construction's.
// ---------------------------------------------------------------------------
test('transformSalesEngineRows ranks 5 independent built buyers above a 40-name single-destination batch', () => {
  const indepLabels = [];
  const metaByLabel = new Map();
  for (let i = 0; i < 5; i += 1) {
    const label = `indepbuyer${i}market`;
    indepLabels.push(label);
    metaByLabel.set(label, {
      domain: `${label}.com`,
      tier: 'probable',
      classification: 'likely-sale',
      reportDate: '2026-09-10',
      buyerNameservers: [`ns1.buyer${i}.example`, `ns2.buyer${i}.example`],
      buyerTitle: `Buyer ${i} Inc`,
      assessment: { buyerUse: true, transfer: { fromRegistrar: 'GoDaddy', toRegistrar: `Registrar${i}` } },
    });
  }
  const batchLabels = [];
  for (let i = 0; i < 40; i += 1) {
    const label = `batch${i}market`;
    batchLabels.push(label);
    metaByLabel.set(label, {
      domain: `${label}.com`,
      tier: 'probable',
      classification: 'likely-sale',
      reportDate: '2026-09-10',
      buyerNameservers: ['ns1.oneplatform.example', 'ns2.oneplatform.example'],
      buyerTitle: 'One Platform',
      assessment: { buyerUse: false, transfer: { fromRegistrar: 'GoDaddy', toRegistrar: 'SamePlatformRegistrar' } },
    });
  }
  const labelIndex = new Map();
  for (const label of [...indepLabels, ...batchLabels]) labelIndex.set(label, { zones: new Set(['com']), day: '2026-09-10' });

  const engineOutput = {
    rising: [
      {
        theme: 'independentconstruction', convergence: 1, rise: 1, labels: indepLabels.length,
        independentRoots: indepLabels.length, constructions: indepLabels.length, zones: 1, topZones: [], kitShareRemoved: 0,
        members: indepLabels,
      },
      {
        theme: 'singledestinationbatch', convergence: 100, rise: 8, labels: batchLabels.length,
        independentRoots: batchLabels.length, constructions: batchLabels.length, zones: 1, topZones: [], kitShareRemoved: 0,
        members: batchLabels,
      },
    ],
    new: [], stable: [], fading: [],
  };

  const themes = transformSalesEngineRows(engineOutput, labelIndex, metaByLabel);
  const indep = themes.find(t => t.theme === 'independentconstruction');
  const batch = themes.find(t => t.theme === 'singledestinationbatch');
  assert.ok(indep && batch, 'both themes must be present');

  assert.equal(indep.buyers, 5, 'the independent construction must report 5 distinct buyers');
  assert.equal(indep.builtCount, 5, 'all 5 independent-buyer names must be counted as built');
  assert.equal(batch.buyers, 1, 'the batch must report exactly 1 buyer (single destination set)');
  assert.equal(batch.topBuyerShare, 1, 'the batch\'s single destination must carry 100% share');
  assert.equal(batch.buyerIndependence, 0, 'a single-destination batch must have buyerIndependence 0 regardless of member count');
  assert.ok(indep.buyerIndependence > batch.buyerIndependence,
    `independent construction (${indep.buyerIndependence}) must exceed the single-destination batch (${batch.buyerIndependence})`);

  const indepRank = themes.findIndex(t => t.theme === 'independentconstruction');
  const batchRank = themes.findIndex(t => t.theme === 'singledestinationbatch');
  assert.ok(indepRank < batchRank,
    'the theme carried by 5 independent built buyers must rank above the 40-name single-destination batch, despite the batch\'s far higher raw convergence/label count');
});

// ---------------------------------------------------------------------------
// 2) Excluded / owner-migration / transfer-only / portfolio-kit ("platform")
//    rows must never be admitted into the sales engine input.
// ---------------------------------------------------------------------------
test('excluded, owner-migration, transfer-only and portfolio-kit (platform) rows never enter the sales source', () => {
  const admitted = { domain: 'alpha.com', tier: 'probable', classification: 'likely-sale', reportDate: '2026-09-10' };
  const admittedVerified = { domain: 'beta.com', tier: 'verified', classification: 'reported-sale', reportDate: '2026-09-10' };
  const admittedSuspected = { domain: 'gamma.com', tier: 'suspected', classification: 'transferred-and-built', reportDate: '2026-09-10' };
  const excludedRow = { domain: 'excluded.com', tier: 'excluded', classification: 'lander-migration', reportDate: '2026-09-10' };
  const ownerMigrationRow = { domain: 'ownermig.com', tier: 'excluded', classification: 'owner-migration', reportDate: '2026-09-10' };
  const ownerMigrationOtherTier = { domain: 'ownermig2.com', tier: 'suspected', classification: 'owner-migration', reportDate: '2026-09-10' };
  const transferOnlyRow = { domain: 'transferonly.com', tier: 'transfer', classification: 'transfer-in-progress', reportDate: '2026-09-10' };
  const platformRow = { domain: 'platform.com', tier: 'suspected', classification: 'portfolio-kit', reportDate: '2026-09-10' };

  assert.equal(isLikelySaleEntry(admitted), true);
  assert.equal(isLikelySaleEntry(admittedVerified), true);
  assert.equal(isLikelySaleEntry(admittedSuspected), true);
  assert.equal(isLikelySaleEntry(excludedRow), false, 'excluded rows must never be admitted');
  assert.equal(isLikelySaleEntry(ownerMigrationRow), false, 'owner-migration rows must never be admitted');
  assert.equal(isLikelySaleEntry(ownerMigrationOtherTier), false, 'owner-migration must be excluded regardless of tier');
  assert.equal(isLikelySaleEntry(transferOnlyRow), false, 'transfer-only rows must never be admitted');
  assert.equal(isLikelySaleEntry(platformRow), false, 'portfolio-kit ("platform") rows must never be admitted');

  const all = [admitted, admittedVerified, admittedSuspected, excludedRow, ownerMigrationRow, ownerMigrationOtherTier, transferOnlyRow, platformRow];
  const inSpan = likelySalesInSpan(all, '2026-09-01', '2026-09-30');
  const domains = inSpan.map(e => e.domain).sort();
  assert.deepEqual(domains, ['alpha.com', 'beta.com', 'gamma.com'], 'only the three admissible rows may enter the span selection');

  const outOfSpan = likelySalesInSpan(all, '2026-10-01', '2026-10-31');
  assert.deepEqual(outOfSpan, [], 'reportDate outside the requested span must also exclude admissible rows (same rule governs the reference span)');
});

// ---------------------------------------------------------------------------
// 3) source=registrations output/keys must be byte-identical to the
//    pre-existing (pre-sales) format.
// ---------------------------------------------------------------------------
test('registrations rangeKey/safeRangeSlug and transformEngineRows output are unchanged', () => {
  const range = { from: '2026-09-10', to: '2026-09-14', refFrom: '2026-09-06', refTo: '2026-09-09' };
  assert.equal(rangeKey(range), '2026-09-10:2026-09-14:2026-09-06:2026-09-09',
    'omitting source must produce the exact pre-existing bare rangeKey format');
  assert.equal(rangeKey({ source: 'registrations', ...range }), '2026-09-10:2026-09-14:2026-09-06:2026-09-09',
    'explicit source=registrations must produce the exact pre-existing bare rangeKey format');
  const salesDigest = engineOptionsDigest(SALES_ENGINE_OPTIONS);
  assert.equal(rangeKey({ source: 'sales', ...range }), `sales:${salesDigest}:2026-09-10:2026-09-14:2026-09-06:2026-09-09`,
    'source=sales must be distinguishable from registrations and must carry the engine-options digest (branch correctly folds SALES_ENGINE_OPTIONS into the sales cache key)');

  assert.equal(safeRangeSlug(range), '2026-09-10_2026-09-14__ref_2026-09-06_2026-09-09');
  assert.equal(safeRangeSlug({ source: 'registrations', ...range }), '2026-09-10_2026-09-14__ref_2026-09-06_2026-09-09');
  assert.notEqual(safeRangeSlug({ source: 'sales', ...range }), safeRangeSlug(range));

  const labelIndex = new Map([
    ['cloudalpha', { zones: new Set(['com']), day: '2026-09-10' }],
    ['cloudbeta', { zones: new Set(['net']), day: '2026-09-11' }],
  ]);
  const engineOutput = {
    rising: [{
      theme: 'cloud', convergence: 2.5, rise: 1.4, labels: 2, independentRoots: 2, constructions: 2, zones: 2,
      topZones: [['com', 1], ['net', 1]], kitShareRemoved: 0, examples: ['cloudalpha', 'cloudbeta'],
    }],
    new: [], stable: [], fading: [],
  };
  const themes = transformEngineRows(engineOutput, labelIndex);
  assert.deepEqual(themes, [{
    theme: 'cloud', convergence: 2.5, rise: 1.4, labels: 2, distinctRoots: 2, distinctConstructions: 2,
    distinctZones: 2, topZones: [{ zone: 'com', count: 1 }, { zone: 'net', count: 1 }], kitCollapsed: false,
    examples: [
      { label: 'cloudalpha', zones: ['com'], day: '2026-09-10' },
      { label: 'cloudbeta', zones: ['net'], day: '2026-09-11' },
    ],
  }], 'transformEngineRows output shape/values for source=registrations must be unchanged');
  assert.equal(DEFAULT_SOURCE, 'registrations');
});

// ---------------------------------------------------------------------------
// 4) Results are cached (and invalidated) per source.
// ---------------------------------------------------------------------------
test('universe theme engine caches results per source, and invalidates sales results on classifier-version change', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'domainscout-universe-themes-sales-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const lane = { directory, listDays: async () => [] };
  const engine = createUniverseThemeEngine({
    lane,
    log: { warn() {}, log() {}, error() {} },
    classifierVersion: 'sale-evidence-test-v1',
    saleWatchLedgerLoader: () => ({ entries: [], classifierVersion: 'sale-evidence-test-v1' }),
  });

  const range = { from: '2026-09-10', to: '2026-09-14', refFrom: '2026-09-06', refTo: '2026-09-09' };

  const registrationsPath = engine.resultPathFor(range, 'registrations');
  const salesPath = engine.resultPathFor(range, 'sales');
  assert.notEqual(registrationsPath, salesPath, 'registrations and sales must persist to distinct paths for the same range');

  const registrationsResult = {
    range: { from: range.from, to: range.to }, referenceRange: { from: range.refFrom, to: range.refTo },
    coverage: { daysPresent: [], daysMissing: [], zonesPerDay: {}, comPresent: false },
    referenceCoverage: { daysPresent: [], daysMissing: [], zonesPerDay: {}, comPresent: false },
    riseBasis: 'complete-reference', computedAt: new Date().toISOString(), engineVersion: 'theme-convergence-v1', themes: [],
  };
  await fsp.mkdir(path.dirname(registrationsPath), { recursive: true });
  await fsp.writeFile(registrationsPath, JSON.stringify(registrationsResult));

  const loadedRegistrations = await engine.loadStoredResult(range, 'registrations');
  assert.ok(loadedRegistrations, 'a stored registrations result must load');
  const loadedSalesBeforeWrite = await engine.loadStoredResult(range, 'sales');
  assert.equal(loadedSalesBeforeWrite, null, 'the sales cache must be empty even though a registrations result exists for the same range: caching is per source');

  const salesResult = {
    source: 'sales', range: { from: range.from, to: range.to }, referenceRange: { from: range.refFrom, to: range.refTo },
    coverage: { daysPresent: [], daysMissing: [], zonesPerDay: {}, comPresent: false },
    referenceCoverage: { daysPresent: [], daysMissing: [], zonesPerDay: {}, comPresent: false },
    riseBasis: 'complete-reference', computedAt: new Date().toISOString(), engineVersion: 'theme-convergence-v1',
    classifierVersion: 'sale-evidence-test-v1', themes: [],
  };
  await fsp.mkdir(path.dirname(salesPath), { recursive: true });
  await fsp.writeFile(salesPath, JSON.stringify(salesResult));

  const loadedSales = await engine.loadStoredResult(range, 'sales');
  assert.ok(loadedSales, 'a stored sales result matching the current classifier version must load');
  assert.equal(loadedSales.classifierVersion, 'sale-evidence-test-v1');

  const staleResult = { ...salesResult, classifierVersion: 'sale-evidence-test-v0-old' };
  await fsp.writeFile(salesPath, JSON.stringify(staleResult));
  const loadedStaleSales = await engine.loadStoredResult(range, 'sales');
  assert.equal(loadedStaleSales, null,
    'a stored sales result whose classifierVersion no longer matches the ledger classifier must be treated as stale and recomputed, never served stale');

  const stillValidRegistrations = await engine.loadStoredResult(range, 'registrations');
  assert.ok(stillValidRegistrations, 'invalidating a stale sales result must not affect the independently cached registrations result');
});
