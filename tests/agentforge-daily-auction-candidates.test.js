'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'agentforge-daily-auction-candidates.mjs');

test('AgentForge projection remains lossless and below the transcript boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-report-fixture-'));
  const helper = path.join(dir, 'helper.mjs');
  const coverage = {
    status: 'complete', universeIdentity: 'iana-root-zone', universeVersion: 'fixture-v1',
    checkedCount: 1437, totalCount: 1437, completedAt: new Date().toISOString(),
  };
  const candidates = { com: [], ai: [], net: [], io: [] };
  for (let index = 0; index < 270; index += 1) {
    const domain = `candidate${index}.com`;
    const provider = index % 3 === 0 ? 'Namecheap' : 'GoDaddy';
    const auctionUrl = provider === 'Namecheap'
      ? `https://www.namecheap.com/market/${domain}`
      : `https://www.godaddy.com/domain-auctions/candidate${index}-com-${710000000 + index}?isc=json_biddable`;
    candidates.com.push([
      domain, provider, 100 - index / 10, 'candidate', 2, 12, 0,
      new Date(Date.now() + (index + 1) * 86_400_000).toISOString(),
      index + 1, index % 7, auctionUrl, '', coverage, ['ai', 'com'],
    ]);
  }
  const payload = {
    status: 'candidate_pool_ready', generatedAt: new Date().toISOString(), timezone: 'America/Chicago',
    inventory: [
      { provider: 'GoDaddy', stream: 'godaddy-auction', rowCount: 2, generatedAt: new Date().toISOString(), snapshotSha256: 'a'.repeat(64), current: true, serveable: true },
      { provider: 'Namecheap', stream: 'namecheap-auction', rowCount: 2, generatedAt: new Date().toISOString(), snapshotSha256: 'b'.repeat(64), current: true, serveable: true },
    ],
    extensionCoverage: coverage,
    universe: { com: 270, ai: 0, net: 0, io: 0 }, eligible: { com: 270, ai: 0, net: 0, io: 0 },
    columns: ['domain','provider','heuristicScore','lexicalEvidence','tldsTaken','ageYears','wayback','auctionEnd','currentPrice','bids','auctionUrl','warnings','extensionCoverage','takenExtensions'],
    candidates,
  };
  fs.writeFileSync(helper, `console.log(${JSON.stringify(JSON.stringify(payload))});\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, DOMAINSCOUT_CANDIDATE_HELPER: helper },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) <= 22_001);
  const output = JSON.parse(result.stdout);
  assert.ok(output.reviewPoolCount >= 250 && output.reviewPoolCount <= 265);
  assert.deepEqual(output.columns, ['domain','providerCode','heuristicScore','tldsTaken','ageYears','auctionEndEpoch','currentPrice','bids','auctionRef']);
  assert.deepEqual(output.candidates[0].slice(0, 5), ['candidate0.com', 'N', 100, 2, 12]);
  assert.equal(output.candidates[0][6], 1);
  assert.equal(output.candidates[0][7], 0);
  const goDaddy = output.candidates.find(row => row[1] === 'G');
  assert.match(goDaddy[8], /^710000\d{3}$/);
  assert.equal(output.extensionCoverage.checkedCount, 1437);
  assert.equal(output.extensionCoverage.totalCount, 1437);
});
