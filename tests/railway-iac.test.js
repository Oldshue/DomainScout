const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, '.railway', 'railway.ts');

test('Railway IaC preserves the production service and durable volume contract', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'railway.json')), false,
    'the deprecated deployment config must not return');

  const source = fs.readFileSync(CONFIG, 'utf8');
  assert.match(source, /export const partial = "domainscout"/);
  assert.match(source, /variables:\s*\{ managed: false \}/);
  assert.match(source, /builder:\s*"NIXPACKS"/);
  assert.match(source, /start:\s*"node scripts\/railway-boot-cleanup\.js && node server\/index\.js"/);
  assert.match(source, /healthcheck:\s*"\/api\/stats"/);
  assert.match(source, /healthcheckTimeout:\s*600/);
  assert.match(source, /restartPolicyType:\s*"ON_FAILURE"/);
  assert.match(source, /restartPolicyMaxRetries:\s*5/);
  assert.match(source, /memoryBytes:\s*12000000000/);
  assert.match(source, /cpu:\s*8/);
  assert.match(source, /volume\("domainscout-volume"/);
  assert.match(source, /sizeMB:\s*160000/);
  assert.match(source, /volumeMounts:\s*\{ "\/data": domainscoutVolume \}/);
});
