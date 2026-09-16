'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRefreshLeaseManager } = require('../server/refresh-lease');

test('stale refresh lease is terminated and fenced before the lane is reusable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-refresh-leases-'));
  let nowMs = Date.parse('2026-08-13T08:00:00.000Z');
  const alive = new Set([4444]);
  const signals = [];
  const manager = createRefreshLeaseManager({
    root,
    now: () => nowMs,
    isAlive: pid => alive.has(pid),
    signal: (pid, name) => signals.push([pid, name]),
  });
  const reservation = manager.reserve('warehouse-inventory', { reason: 'fixture-sync' });
  const lease = manager.activate('warehouse-inventory', reservation.token, 4444);
  assert.equal(manager.inspect('warehouse-inventory', { maxHeartbeatAgeMs: 60_000 }).stale, false);

  nowMs += 61_000;
  const reaping = manager.inspect('warehouse-inventory', { maxHeartbeatAgeMs: 60_000, terminationGraceMs: 5_000 });
  assert.equal(reaping.reaping, true);
  assert.deepEqual(signals, [[4444, 'SIGTERM']]);
  assert.equal(fs.existsSync(lease.filePath), true, 'lane stays fenced during the termination grace period');

  nowMs += 5_001;
  assert.equal(manager.inspect('warehouse-inventory', { maxHeartbeatAgeMs: 60_000, terminationGraceMs: 5_000 }), null);
  assert.deepEqual(signals, [[4444, 'SIGTERM'], [4444, 'SIGKILL']]);
  assert.equal(fs.existsSync(lease.filePath), false);
});

test('independent provider lanes never block each other', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-refresh-lanes-'));
  const manager = createRefreshLeaseManager({ root, isAlive: () => true });
  const first = manager.reserve('package-catalog', { reason: 'fixture-catalog' });
  manager.activate('package-catalog', first.token, 1001);
  const second = manager.reserve('market-prices', { reason: 'fixture-prices' });
  manager.activate('market-prices', second.token, 1002);
  assert.equal(manager.inspect('package-catalog').pid, 1001);
  assert.equal(manager.inspect('market-prices').pid, 1002);
});

test('DomainScout composes discovery and Namecheap through generic independent lanes', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(indexSource, /refreshLaneForOptions/);
  assert.match(indexSource, /options\.namecheapOnly \? 'namecheap-auction' : 'discovery'/);
  assert.doesNotMatch(indexSource, /scrape\.lock\.json/);

  const scrapeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'scrape-all.js'), 'utf8');
  const fullStart = scrapeSource.indexOf('async function scrapeAll');
  const fullEnd = scrapeSource.indexOf('// Run directly', fullStart);
  const fullScrape = scrapeSource.slice(fullStart, fullEnd);
  assert.doesNotMatch(fullScrape, /scrapeNamecheap\(/, 'hourly Namecheap publication is not coupled to the discovery lane');
  assert.match(scrapeSource, /startRefreshLeaseHeartbeat/);
});

test('lease from a replaced container never signals an unrelated recycled PID', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'foreign-lease-'));let signals=0;
  const {createRefreshLeaseManager}=require('../server/refresh-lease');
  const manager=createRefreshLeaseManager({root,isAlive:()=>true,signal:()=>signals++});
  const lease=manager.reserve('zone-universe');
  const value=JSON.parse(fs.readFileSync(lease.filePath));value.hostId='different-container';fs.writeFileSync(lease.filePath,JSON.stringify(value));
  assert.equal(manager.inspect('zone-universe'),null);assert.equal(signals,0);fs.rmSync(root,{recursive:true});
});

test('a fresh heartbeat cannot extend the absolute runtime bound after supervisor restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-lease-'));
  let now = Date.now(); const sent = [];
  const manager = createRefreshLeaseManager({root, now: () => now, isAlive: () => true, signal: (...args) => sent.push(args)});
  try {
    const lease = manager.reserve('package-catalog');
    manager.activate('package-catalog', lease.token, 1001, {processGroup: true});
    now += 120000;
    const row = JSON.parse(fs.readFileSync(lease.filePath));
    row.heartbeatAt = new Date(now).toISOString(); fs.writeFileSync(lease.filePath, JSON.stringify(row));
    assert.equal(manager.inspect('package-catalog', {maxRunAgeMs: 60000}).reaping, true);
    assert.deepEqual(sent, [[-1001, 'SIGTERM']]);
  } finally {fs.rmSync(root, {recursive:true, force:true});}
});
