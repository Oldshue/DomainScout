'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const MINER = path.join(REPO_ROOT, 'scripts', 'universe', 'mine-universe-types.py');

function havePython3() {
  const r = spawnSync('python3', ['--version'], { timeout: 10000 });
  return !r.error && r.status === 0;
}

function buildWorkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-miners-test-'));
  fs.mkdirSync(path.join(dir, 'tape'), { recursive: true });

  const zones = ['com', 'net', 'io'];
  const rows = []; // [label, tld, windowStart]
  const windowStart = '2026-08-01';

  // 15-label brand-root family sharing the 9-char substring "zorbliztx"
  const brandLetters = 'abcdefghijklmno'.split('');
  brandLetters.forEach((ch, i) => {
    rows.push([`${ch}zorbliztx`, zones[i % zones.length], windowStart]);
  });

  // City-grid theme: 8 distinct cities + "pizza" -> same grid:{city}+pizza type
  const cities = ['newyork', 'chicago', 'seattle', 'boston', 'denver', 'austin', 'miami', 'dallas'];
  cities.forEach((c, i) => {
    rows.push([`${c}pizza`, zones[i % zones.length], windowStart]);
  });

  // Filler labels to round the tape out to ~60 distinct labels across the 3 zones
  const fillerWords = ['garden', 'river', 'bridge', 'castle', 'forest', 'meadow', 'harbor', 'island',
    'canyon', 'valley', 'desert', 'glacier', 'prairie', 'tundra', 'volcano', 'plateau', 'lagoon',
    'delta', 'summit', 'ridge', 'orchard', 'vineyard', 'quarry', 'reef', 'cove', 'bayou', 'marsh',
    'grove', 'plain', 'dune', 'cliff', 'cavern', 'geyser', 'fjord', 'steppe', 'savanna', 'wetland'];
  fillerWords.forEach((w, i) => {
    rows.push([`${w}${w}zz`, zones[i % zones.length], windowStart]);
  });

  const tsv = rows.map(([lab, tld, ws]) => `${lab}\t${tld}\t${ws}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'tape', 'adds.tsv'), tsv);

  const zonesJson = {};
  zones.forEach((z) => {
    zonesJson[z] = {
      status: 'ok',
      adds: rows.filter((r) => r[1] === z).length,
      drops: 0,
      window_start: windowStart,
    };
  });
  fs.writeFileSync(path.join(dir, 'tape', 'zones.json'), JSON.stringify(zonesJson, null, 1));

  return { dir, rowCount: rows.length };
}

test('mine-universe-types.py mines rows and brand families from a tiny universe tape', (t) => {
  if (!havePython3()) {
    t.skip('python3 is not available in this sandbox; skipping universe-miner integration test');
    return;
  }

  const { dir } = buildWorkDir();
  try {
    const result = spawnSync('python3', [MINER], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { UNIVERSE_WORK: dir }),
      timeout: 30000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.signal) {
      assert.fail(`mine-universe-types.py timed out or was killed by signal ${result.signal}`);
    }
    assert.equal(
      result.status,
      0,
      `mine-universe-types.py exited nonzero: ${(result.stderr || '').toString().slice(0, 2000)}`
    );

    const jsonPath = path.join(dir, 'universe-types.json');
    const txtPath = path.join(dir, 'universe-types.txt');
    const summaryPath = path.join(dir, 'tape', 'summary.json');

    assert.ok(fs.existsSync(jsonPath), 'universe-types.json should be written to UNIVERSE_WORK');
    assert.ok(fs.existsSync(txtPath), 'universe-types.txt should be written to UNIVERSE_WORK');
    assert.ok(fs.existsSync(summaryPath), 'tape/summary.json should be written to UNIVERSE_WORK');

    const universe = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.ok(Array.isArray(universe.rows), 'universe-types.json rows should be an array');
    assert.ok(universe.rows.length > 0, 'expected at least one mined type row from the city-grid theme');
    assert.ok(Array.isArray(universe.brandFamilies), 'universe-types.json brandFamilies should be an array');
    assert.ok(universe.brandFamilies.length > 0, 'expected the 15-label brand-root family to be detected');

    const family = universe.brandFamilies.find((f) => f.count >= 15);
    assert.ok(family, 'expected a brand family with at least the 15 seeded members');

    const gridRow = universe.rows.find((r) => r.type === 'grid:{city}+pizza');
    assert.ok(gridRow, 'expected the city+pizza grid type to be mined');
    assert.ok(gridRow.count >= 8, 'expected all 8 seeded city+pizza labels to be counted');

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    assert.ok(summary.totalAdds > 0, 'summary.totalAdds should reflect the seeded tape');
    assert.ok(summary.distinctLabels > 0, 'summary.distinctLabels should reflect the seeded tape');

    const txt = fs.readFileSync(txtPath, 'utf8');
    assert.ok(txt.length > 0, 'universe-types.txt should contain evidence lines');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
