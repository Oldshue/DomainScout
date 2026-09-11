'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createProbeQueue, ensureSiteEvidenceSchema, resolveQueueConcurrencyFromEnv } = require('../server/site-evidence');
const { resolveSiteProbeTimeoutMs } = require('../server/sale-watch-discovery');

const ENV_CONCURRENCY = 'DOMAINSCOUT_SITE_PROBE_CONCURRENCY';
const ENV_TIMEOUT = 'DOMAINSCOUT_SITE_PROBE_TIMEOUT_MS';

function freshDb() {
  const db = new Database(':memory:');
  ensureSiteEvidenceSchema(db);
  return db;
}

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prior;
    else delete process.env[name];
  }
}

test('createProbeQueue honours DOMAINSCOUT_SITE_PROBE_CONCURRENCY when opts.concurrency is absent', async () => {
  await withEnv(ENV_CONCURRENCY, '2', async () => {
    const db = freshDb();
    let inFlight = 0;
    let maxInFlight = 0;
    const inspect = async (domain) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { active: true, title: `Title ${domain}`, finalUrl: `https://${domain}`, finalHost: domain, status: 200 };
    };
    // No opts.concurrency passed: createProbeQueue must read the env var.
    const queue = createProbeQueue(db, { inspect });
    queue.enqueue(['a.com', 'b.com', 'c.com', 'd.com', 'e.com']);
    await queue.drain();
    assert.equal(maxInFlight, 2, `expected the env concurrency (2) to cap in-flight probes, saw ${maxInFlight}`);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM site_evidence').get();
    assert.equal(rows.n, 5);
  });
});

test('an explicit opts.concurrency still wins over the env var', async () => {
  await withEnv(ENV_CONCURRENCY, '2', async () => {
    const db = freshDb();
    let inFlight = 0;
    let maxInFlight = 0;
    const inspect = async (domain) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { active: true, title: `Title ${domain}`, finalUrl: `https://${domain}`, finalHost: domain, status: 200 };
    };
    const queue = createProbeQueue(db, { inspect, concurrency: 4 });
    queue.enqueue(['a.com', 'b.com', 'c.com', 'd.com', 'e.com']);
    await queue.drain();
    assert.equal(maxInFlight, 4);
  });
});

test('resolveQueueConcurrencyFromEnv falls back to null (default) for invalid values', () => {
  assert.equal(resolveQueueConcurrencyFromEnv(undefined), null);
  assert.equal(resolveQueueConcurrencyFromEnv(''), null);
  assert.equal(resolveQueueConcurrencyFromEnv('0'), null);
  assert.equal(resolveQueueConcurrencyFromEnv('65'), null);
  assert.equal(resolveQueueConcurrencyFromEnv('-1'), null);
  assert.equal(resolveQueueConcurrencyFromEnv('3.5'), null);
  assert.equal(resolveQueueConcurrencyFromEnv('abc'), null);
  assert.equal(resolveQueueConcurrencyFromEnv('1'), 1);
  assert.equal(resolveQueueConcurrencyFromEnv('64'), 64);
  assert.equal(resolveQueueConcurrencyFromEnv('16'), 16);
});

test('createProbeQueue falls back to the built-in default concurrency when the env value is invalid', () => {
  withEnv(ENV_CONCURRENCY, 'not-a-number', () => {
    const db = freshDb();
    // No opts.concurrency and an invalid env var: must not throw, and must
    // behave exactly as if no env var were set at all (default of 8).
    assert.doesNotThrow(() => createProbeQueue(db, { inspect: async () => ({ active: true, title: 'T', finalUrl: 'https://x', finalHost: 'x', status: 200 }) }));
  });
});

test('resolveSiteProbeTimeoutMs clamps DOMAINSCOUT_SITE_PROBE_TIMEOUT_MS to [1000, 30000] with a 10000ms default', () => {
  withEnv(ENV_TIMEOUT, undefined, () => {
    assert.equal(resolveSiteProbeTimeoutMs(), 10000);
  });
  assert.equal(resolveSiteProbeTimeoutMs(undefined), 10000);
  assert.equal(resolveSiteProbeTimeoutMs(''), 10000);
  assert.equal(resolveSiteProbeTimeoutMs('abc'), 10000);
  assert.equal(resolveSiteProbeTimeoutMs('3.5'), 10000);
  assert.equal(resolveSiteProbeTimeoutMs('500'), 10000, 'below min falls back to default');
  assert.equal(resolveSiteProbeTimeoutMs('30001'), 10000, 'above max falls back to default');
  assert.equal(resolveSiteProbeTimeoutMs('1000'), 1000, 'min bound is honoured');
  assert.equal(resolveSiteProbeTimeoutMs('30000'), 30000, 'max bound is honoured');
  assert.equal(resolveSiteProbeTimeoutMs('15000'), 15000);

  withEnv(ENV_TIMEOUT, '5000', () => {
    assert.equal(resolveSiteProbeTimeoutMs(), 5000);
  });
  withEnv(ENV_TIMEOUT, '99999', () => {
    assert.equal(resolveSiteProbeTimeoutMs(), 10000);
  });
});
