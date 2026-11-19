'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const wire = require('../server/dns-wire');
const { createAuthoritativeResolver, TokenBucket, TldHealth } = require('../server/authoritative-dns');

function response(name, kind) {
  if (kind === 'nxdomain') return wire.decodeMessage(wire.encodeResponse({ id: 1, name, aa: true, rcode: wire.RCODE.NXDOMAIN, authority: [{ name: name.split('.').pop(), type: wire.TYPE.SOA }] }));
  if (kind === 'referral') return wire.decodeMessage(wire.encodeResponse({ id: 1, name, aa: false, authority: [{ name, type: wire.TYPE.NS, data: 'ns1.example' }] }));
  if (kind === 'servfail') return wire.decodeMessage(wire.encodeResponse({ id: 1, name, aa: false, rcode: wire.RCODE.SERVFAIL }));
  if (kind === 'truncated') return wire.decodeMessage(wire.encodeResponse({ id: 1, name, tc: true }));
  throw new Error(kind);
}

function fakeTransport(script) {
  const calls = [];
  return {
    calls,
    async query({ server, name }) {
      calls.push({ server, name });
      const next = typeof script === 'function' ? script({ server, name, call: calls.length }) : script.shift();
      if (next === 'timeout') return { timeout: true };
      if (next instanceof Error) return { error: next };
      return { message: response(name, next) };
    },
  };
}

const servers = [{ host: 'a.nic.io', ip: '192.0.2.1', family: 4 }, { host: 'b.nic.io', ip: '192.0.2.2', family: 4 }];

test('NXDOMAIN → not_taken, referral → taken, SERVFAIL/timeout/truncation → unknown (fallback)', async () => {
  const t = fakeTransport(['nxdomain', 'referral', 'servfail', 'servfail', 'timeout', 'timeout', 'truncated']);
  const r = createAuthoritativeResolver({ transport: t, discover: async () => servers, retries: 1, sleep: async () => {} });
  assert.equal((await r.probe('free.io')).status, 'not_taken');
  assert.equal((await r.probe('taken.io')).status, 'taken');
  const sf = await r.probe('broken.io');
  assert.deepEqual([sf.status, sf.reason], ['unknown', 'servfail']);
  const to = await r.probe('slow.io');
  assert.deepEqual([to.status, to.reason], ['unknown', 'timeout']);
  const tc = await r.probe('big.io');
  assert.deepEqual([tc.status, tc.reason], ['unknown', 'truncated']);
  assert.equal(t.calls.length, 7, 'servfail and timeout retried once; truncation not retried');
  assert.equal(r.snapshot().stats.timeouts, 2);
});

test('load is spread across all of a TLD servers and NS discovery is cached in SQLite with daily refresh', async () => {
  let clock = 1_000_000;
  const db = new Database(':memory:');
  let discoveries = 0;
  const t = fakeTransport(() => 'nxdomain');
  const make = () => createAuthoritativeResolver({ database: db, transport: t, now: () => clock, discover: async () => { discoveries += 1; return servers; }, retries: 0 });
  const r = make();
  for (let i = 0; i < 6; i += 1) await r.probe(`n${i}.io`);
  const byServer = t.calls.reduce((m, c) => ({ ...m, [c.server]: (m[c.server] || 0) + 1 }), {});
  assert.deepEqual(byServer, { '192.0.2.1': 3, '192.0.2.2': 3 });
  assert.equal(discoveries, 1);
  // A fresh resolver on the same database reuses the cached servers.
  await make().probe('again.io');
  assert.equal(discoveries, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tld_authority_cache').get().n, 1);
  // After a day the cache is refreshed.
  clock += 24 * 60 * 60 * 1000 + 1;
  await make().probe('later.io');
  assert.equal(discoveries, 2);
  db.close();
});

test('a misbehaving TLD is routed to fallback and re-probed after the cool-down', async () => {
  let clock = 0;
  const t = fakeTransport(() => 'servfail');
  const r = createAuthoritativeResolver({ transport: t, discover: async () => servers, now: () => clock, retries: 0, healthWindow: 10, healthMaxUnknownRatio: 0.5, healthCooldownMs: 60_000 });
  for (let i = 0; i < 10; i += 1) await r.probe(`x${i}.io`);
  const before = t.calls.length;
  const routed = await r.probe('y.io');
  assert.deepEqual([routed.status, routed.reason], ['unknown', 'tld-degraded']);
  assert.equal(t.calls.length, before, 'degraded TLD sends no authoritative query');
  assert.equal(r.snapshot().tlds.io.healthy, false);
  clock = 60_001;
  await r.probe('z.io');
  assert.equal(t.calls.length, before + 1, 'after the cool-down the TLD is probed again');
});

test('token bucket rate-limits per server and health window tracks unknown ratio', () => {
  let clock = 0;
  const b = new TokenBucket(10, 2, () => clock);
  assert.equal(b.tryTake(), 0); assert.equal(b.tryTake(), 0);
  assert.ok(b.tryTake() > 0, 'third take within the same instant must wait');
  clock = 100; assert.equal(b.tryTake(), 0, 'one token refilled after 100ms at 10/s');
  const h = new TldHealth({ healthWindow: 4, healthMaxUnknownRatio: 0.5, healthCooldownMs: 10 }, () => clock);
  for (const s of ['taken', 'not_taken', 'taken', 'not_taken']) h.record(s);
  assert.equal(h.healthy(), true);
});

test('names that are not second-level labels, and a disabled resolver, return unknown without querying', async () => {
  const t = fakeTransport(() => 'nxdomain');
  const r = createAuthoritativeResolver({ transport: t, discover: async () => servers });
  assert.equal((await r.probe('a.b.io')).reason, 'not-a-second-level-name');
  const off = createAuthoritativeResolver({ transport: t, discover: async () => servers, enabled: false });
  assert.equal((await off.probe('a.io')).reason, 'authoritative-disabled');
  assert.equal(t.calls.length, 0);
});

test('concurrent probes never bypass a depleted server bucket', async () => {
  let clock = 0;
  const times = [];
  const r = createAuthoritativeResolver({
    now: () => clock, retries: 0, perServerQps: 10, perServerBurst: 1,
    discover: async () => servers.slice(0, 1),
    sleep: async ms => { await new Promise(resolve => setImmediate(resolve)); clock += ms; },
    transport: { async query({ name }) { times.push(clock); return { message: response(name, 'nxdomain') }; } },
  });
  await Promise.all(Array.from({length: 12}, (_, i) => r.probe(`name${i}.io`)));
  assert.equal(times.length, 12);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 100);
});

test('registries that never answer NXDOMAIN: parent-zone NODATA and a proven wildcard CNAME are negatives; a different CNAME stays unknown', async () => {
  const msg = spec => wire.decodeMessage(wire.encodeResponse({ id: 1, aa: true, ...spec }));
  const wildcardTransport = target => ({
    async query({ name }) {
      const tld = name.split('.').pop();
      if (name === `sold.${tld}`) return { message: msg({ name, aa: false, authority: [{ name, type: wire.TYPE.NS, data: 'ns1.example' }] }) };
      if (tld === 'ws') return { message: msg({ name, authority: [{ name: 'ws', type: wire.TYPE.SOA }] }) };
      const data = name === `odd.${tld}` ? 'elsewhere.example' : target;
      return { message: msg({ name, answers: [{ name, type: wire.TYPE.CNAME, data }] }) };
    },
  });
  const r = createAuthoritativeResolver({ transport: wildcardTransport('wildcard.registry.example'), discover: async () => servers, retries: 0, sleep: async () => {} });
  assert.deepEqual([(await r.probe('free.ws')).status, (await r.probe('free.ws')).reason], ['not_taken', 'authoritative-nodata']);
  assert.equal((await r.probe('sold.ws')).status, 'taken');
  const free = await r.probe('free.xn--fiqs8s');
  assert.deepEqual([free.status, free.reason], ['not_taken', 'wildcard-cname']);
  assert.equal((await r.probe('sold.xn--fiqs8s')).status, 'taken');
  const odd = await r.probe('odd.xn--fiqs8s');
  assert.deepEqual([odd.status, odd.reason], ['taken', 'registry-hosted-cname']);
});

test('a CNAME the registry published for one name is a registration; an alias TLD answers with the other TLD', async () => {
  const msg = spec => wire.decodeMessage(wire.encodeResponse({ id: 1, aa: true, ...spec }));
  const transport = {
    async query({ name }) {
      const [label, tld] = name.split('.');
      if (tld === 'la') {
        if (label === 'festival') return { message: msg({ name, answers: [{ name, type: wire.TYPE.CNAME, data: 'forwarding.registry.example' }] }) };
        return { message: msg({ name, rcode: wire.RCODE.NXDOMAIN, authority: [{ name: 'la', type: wire.TYPE.SOA }] }) };
      }
      if (tld === 'aliasone') return { message: msg({ name, answers: [{ name, type: wire.TYPE.CNAME, data: `${label}.aliastwo` }] }) };
      if (tld === 'aliastwo') {
        if (label === 'oyster') return { message: msg({ name, aa: false, authority: [{ name, type: wire.TYPE.NS, data: 'ns1.example' }] }) };
        return { message: msg({ name, rcode: wire.RCODE.NXDOMAIN, authority: [{ name: 'aliastwo', type: wire.TYPE.SOA }] }) };
      }
      throw new Error(name);
    },
  };
  const r = createAuthoritativeResolver({ transport, discover: async () => servers, retries: 0, sleep: async () => {} });
  const hosted = await r.probe('festival.la');
  assert.deepEqual([hosted.status, hosted.reason], ['taken', 'registry-hosted-cname']);
  assert.equal((await r.probe('nobody.la')).status, 'not_taken');
  const viaTaken = await r.probe('oyster.aliasone');
  assert.deepEqual([viaTaken.status, viaTaken.reason], ['taken', 'alias-tld:exact-referral']);
  const viaFree = await r.probe('nobody.aliasone');
  assert.deepEqual([viaFree.status, viaFree.reason], ['not_taken', 'alias-tld:nxdomain']);
});
