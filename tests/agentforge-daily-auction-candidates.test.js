'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'agentforge-daily-auction-candidates.mjs');
const completeHelper = path.join(__dirname, '..', 'scripts', 'daily-auction-candidates.mjs');

test('complete provider scan reserves review breadth without imposing final TLD quotas', () => {
  const source = fs.readFileSync(completeHelper, 'utf8');
  assert.match(source, /process\.env\.DOMAINSCOUT_BASE \|\| 'http:\/\/127\.0\.0\.1:51551'/);
  assert.doesNotMatch(source, /100\.90\.156\.10/);
  assert.match(source, /const REVIEW_BASE_RESERVES = \{ ai: 60, net: 10, io: 10 \}/);
  assert.match(source, /const MIN_AI_REVIEW = 40/);
  assert.match(source, /readyAiReview === requiredAiReviewBases\.size/);
  assert.match(source, /const capCompliantCapacity = candidates\.com\.length \+ candidates\.ai\.length/);
  assert.match(source, /projectAgentForgeCandidatePool\(completeReceipt\)/);
  assert.match(source, /DOMAINSCOUT_FULL_CANDIDATE_RECEIPT === '1'/);
  assert.doesNotMatch(source, /finalAi|outputAi|aiQuota|minimumAiOutput/i);
});

test('AgentForge projection remains lossless and below the transcript boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-report-fixture-'));
  const helper = path.join(dir, 'helper.mjs');
  const coverage = {
    status: 'complete', universeIdentity: 'iana-root-zone', universeVersion: 'fixture-v1',
    checkedCount: 1437, totalCount: 1437, completedAt: new Date().toISOString(),
  };
  const candidates = { com: [], ai: [], net: [], io: [] };
  const fixtureNow = Math.floor(Date.now() / 1000) * 1000;
  for (let index = 0; index < 270; index += 1) {
    const domain = `candidate${index}.com`;
    const provider = index % 3 === 0 ? 'Namecheap' : 'GoDaddy';
    const auctionUrl = provider === 'Namecheap'
      ? `https://www.namecheap.com/market/${domain}`
      : `https://www.godaddy.com/domain-auctions/candidate${index}-com-${710000000 + index}?isc=json_biddable`;
    candidates.com.push([
      domain, provider, 100 - index / 10, 'candidate', 2, 12, 0,
      new Date(fixtureNow + (index + 1) * 86_400_000).toISOString(),
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
  assert.ok(Buffer.byteLength(result.stdout) <= 18_501);
  const output = JSON.parse(result.stdout);
  assert.ok(output.reviewPoolCount >= 250 && output.reviewPoolCount <= 345);
  assert.deepEqual(output.columns, ['domain','providerCode','tldsTaken','ageYears','auctionEnd','currentPrice','bids','auctionRef']);
  assert.deepEqual(output.candidates[0].slice(0, 4), ['candidate0.com', 'N', 2, 12]);
  assert.match(output.candidates[0][4], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  assert.equal(output.candidates[0][5], 1);
  assert.equal(output.candidates[0][6], 0);
  const goDaddy = output.candidates.find(row => row[1] === 'G');
  assert.match(goDaddy[7], /^710000\d{3}$/);
  assert.equal(output.extensionCoverage.checkedCount, 1437);
  assert.equal(output.extensionCoverage.totalCount, 1437);
});

test('bounded review sees strong .ai candidates without imposing an output quota', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-report-ai-fixture-'));
  const helper = path.join(dir, 'helper.mjs');
  const coverage = {
    status: 'complete', universeIdentity: 'iana-root-zone', universeVersion: 'fixture-v1',
    checkedCount: 1437, totalCount: 1437, completedAt: new Date().toISOString(),
  };
  const candidates = { com: [], ai: [], net: [], io: [] };
  const fixtureNow = Math.floor(Date.now() / 1000) * 1000;
  const add = (tld, index, provider = index % 2 ? 'GoDaddy' : 'Namecheap') => {
    const domain = `review${tld}${index}.${tld}`;
    const auctionUrl = provider === 'Namecheap'
      ? `https://www.namecheap.com/market/${domain}`
      : `https://www.godaddy.com/domain-auctions/${domain.replace('.', '-')}-${720000000 + index}?isc=json_biddable`;
    candidates[tld].push([
      domain, provider, 120 - index / 10, 'review', 1, 4, 0,
      new Date(fixtureNow + (index + 1) * 86_400_000).toISOString(),
      index + 1, index % 4, auctionUrl, '', coverage, ['com'],
    ]);
  };
  for (let index = 0; index < 360; index += 1) add('com', index);
  for (let index = 0; index < 55; index += 1) add('ai', index);
  for (let index = 0; index < 8; index += 1) { add('net', index); add('io', index); }
  const payload = {
    status: 'candidate_pool_ready', generatedAt: new Date().toISOString(), timezone: 'America/Chicago',
    inventory: [
      { provider: 'GoDaddy', stream: 'godaddy-auction', rowCount: 2, generatedAt: new Date().toISOString(), snapshotSha256: 'a'.repeat(64), current: true, serveable: true },
      { provider: 'Namecheap', stream: 'namecheap-auction', rowCount: 2, generatedAt: new Date().toISOString(), snapshotSha256: 'b'.repeat(64), current: true, serveable: true },
    ],
    extensionCoverage: coverage,
    universe: { com: 360, ai: 55, net: 8, io: 8 }, eligible: { com: 360, ai: 55, net: 8, io: 8 },
    columns: ['domain','provider','heuristicScore','lexicalEvidence','tldsTaken','ageYears','wayback','auctionEnd','currentPrice','bids','auctionUrl','warnings','extensionCoverage','takenExtensions'],
    candidates,
  };
  fs.writeFileSync(helper, `console.log(${JSON.stringify(JSON.stringify(payload))});\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, DOMAINSCOUT_CANDIDATE_HELPER: helper },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) <= 18_501);
  const output = JSON.parse(result.stdout);
  const tlds = output.candidates.map(row => row[0].split('.').at(-1));
  assert.ok(output.reviewPoolCount >= 250 && output.reviewPoolCount <= 345);
  assert.ok(tlds.filter(tld => tld === 'ai').length >= 40);
  assert.ok(tlds.filter(tld => tld === 'net').length <= 5);
  assert.ok(tlds.filter(tld => tld === 'io').length <= 5);
  assert.deepEqual(new Set(output.candidates.map(row => row[1])), new Set(['G', 'N']));
  assert.equal(output.eligible.ai, 55, 'the adapter reports evidence, not a final .ai quota');
});
