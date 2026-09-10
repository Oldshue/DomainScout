'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CODE_DIR = path.join(REPO_ROOT, 'scripts', 'universe');
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

// Builds a fixture work dir with tape/adds.tsv (many labels carrying a shared
// "market" theme token, each on a distinct 7+ char root, spread across zones)
// plus a minimal universe-types.json with no brand families to exclude.
function makeFixtureWorkDir() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-themes-'));
  fs.mkdirSync(path.join(work, 'tape'), { recursive: true });
  const zones = ['com', 'net', 'org', 'io', 'app'];
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const root = `zzroot${i}`;
    rows.push([`${root}market`, zones[i % zones.length]]);
    rows.push([`market${root}`, zones[(i + 1) % zones.length]]);
  }
  const lines = rows.map(([lab, tld]) => `${lab}\t${tld}\t0`);
  fs.writeFileSync(path.join(work, 'tape', 'adds.tsv'), lines.join('\n') + '\n');
  fs.writeFileSync(
    path.join(work, 'universe-types.json'),
    JSON.stringify({ rows: [], brandFamilies: [] })
  );
  return work;
}

test('theme-convergence.py + select-theme-targets.py over a fixture universe tape', async (t) => {
  if (!fs.existsSync(MINE_UNIVERSE_TYPES)) {
    t.skip(
      'scripts/universe/mine-universe-types.py is not present on this checkout; ' +
        'theme-convergence.py execs the pre-tape segment of that miner from CODE and cannot ' +
        'run without it. Skipping until the miner script is vendored alongside this one.'
    );
    return;
  }

  const work = makeFixtureWorkDir();

  await runPython([path.join(CODE_DIR, 'theme-convergence.py'), work]);

  const tcJsonPath = path.join(work, 'theme-convergence.json');
  const tcTxtPath = path.join(work, 'theme-convergence.txt');
  assert.ok(fs.existsSync(tcJsonPath), 'theme-convergence.json should be written');
  assert.ok(fs.existsSync(tcTxtPath), 'theme-convergence.txt should be written');

  const tc = JSON.parse(fs.readFileSync(tcJsonPath, 'utf8'));
  for (const key of ['rising', 'new', 'stable', 'fading']) {
    assert.ok(Array.isArray(tc[key]), `theme-convergence.json.${key} should be an array`);
  }

  await runPython([path.join(CODE_DIR, 'select-theme-targets.py'), work]);

  const targetsPath = path.join(work, 'probes', 'targets.txt');
  const targetMetaPath = path.join(work, 'probes', 'target-meta.json');
  assert.ok(fs.existsSync(targetsPath), 'probes/targets.txt should be written');
  assert.ok(fs.existsSync(targetMetaPath), 'probes/target-meta.json should be written');

  const meta = JSON.parse(fs.readFileSync(targetMetaPath, 'utf8'));
  assert.ok(meta && typeof meta === 'object', 'probes/target-meta.json should parse to an object');
});
