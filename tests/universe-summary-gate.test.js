'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const zlib = require('zlib');

const {
  buildUniverseSummaryTape,
  importUniverseSummaryTape,
} = require('../server/universe-summary');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeNamesGz(namesDir, tld, labels) {
  const gz = zlib.gzipSync(labels.map(l => `${l}\n`).join(''));
  fs.writeFileSync(path.join(namesDir, `${tld}.names.gz`), gz);
}

test('importUniverseSummaryTape: accepts a tape meeting expectZones and requireZones', async () => {
  const namesDir = mkTmp('universe-summary-gate-names-');
  writeNamesGz(namesDir, 'com', ['alpha', 'beta']);
  writeNamesGz(namesDir, 'net', ['alpha', 'gamma']);
  writeNamesGz(namesDir, 'xyz', ['alpha']);

  const tapeOutDir = mkTmp('universe-summary-gate-tape-');
  const built = await buildUniverseSummaryTape({
    namesDir, day: '2026-09-10', outDir: tapeOutDir, minZones: 1, log: null,
  });
  assert.equal(built.zones, 3);

  const dataDir = mkTmp('universe-summary-gate-data-');
  const result = await importUniverseSummaryTape({
    tapePath: built.tapePath,
    dataDir,
    expectZones: 3,
    requireZones: ['com', 'net'],
    log: null,
  });

  assert.equal(result.zones, 3);
  assert.equal(fs.existsSync(path.join(dataDir, 'universe_summary.db')), true);
});

test('importUniverseSummaryTape: refuses a tape below expectZones and leaves previous summary untouched', async () => {
  const namesDir = mkTmp('universe-summary-gate-names-');
  writeNamesGz(namesDir, 'com', ['alpha']);
  writeNamesGz(namesDir, 'net', ['alpha']);
  writeNamesGz(namesDir, 'xyz', ['alpha']);

  const tapeOutDir = mkTmp('universe-summary-gate-tape-');
  const day1 = '2026-09-08';
  const built1 = await buildUniverseSummaryTape({
    namesDir, day: day1, outDir: tapeOutDir, minZones: 1, log: null,
  });

  const dataDir = mkTmp('universe-summary-gate-data-');
  const accepted = await importUniverseSummaryTape({
    tapePath: built1.tapePath,
    dataDir,
    expectZones: 3,
    requireZones: ['com'],
    log: null,
  });
  assert.equal(accepted.day, day1);

  const dbPath = path.join(dataDir, 'universe_summary.db');
  const before = fs.readFileSync(dbPath);

  const day2 = '2026-09-09';
  const built2 = await buildUniverseSummaryTape({
    namesDir, day: day2, outDir: tapeOutDir, minZones: 1, log: null,
  });

  await assert.rejects(
    importUniverseSummaryTape({
      tapePath: built2.tapePath,
      dataDir,
      expectZones: 4,
      requireZones: ['com'],
      log: null,
    }),
    err => {
      assert.equal(err.code, 'incomplete_tape');
      assert.match(err.message, /3 zones found/);
      assert.match(err.message, /expected at least 4/);
      return true;
    },
  );

  const after = fs.readFileSync(dbPath);
  assert.deepEqual(after, before);

  const buildingPath = `${dbPath}.building`;
  assert.equal(fs.existsSync(buildingPath), false);
});

test('importUniverseSummaryTape: refuses a tape missing a required anchor zone', async () => {
  const namesDir = mkTmp('universe-summary-gate-names-');
  writeNamesGz(namesDir, 'com', ['alpha']);
  writeNamesGz(namesDir, 'net', ['alpha']);
  writeNamesGz(namesDir, 'xyz', ['alpha']);

  const tapeOutDir = mkTmp('universe-summary-gate-tape-');
  const built = await buildUniverseSummaryTape({
    namesDir, day: '2026-09-10', outDir: tapeOutDir, minZones: 1, log: null,
  });

  const dataDir = mkTmp('universe-summary-gate-data-');
  await assert.rejects(
    importUniverseSummaryTape({
      tapePath: built.tapePath,
      dataDir,
      expectZones: 3,
      requireZones: ['com', 'shop'],
      log: null,
    }),
    err => {
      assert.equal(err.code, 'incomplete_tape');
      assert.match(err.message, /missing required zones: shop/);
      return true;
    },
  );

  assert.equal(fs.existsSync(path.join(dataDir, 'universe_summary.db')), false);
});
