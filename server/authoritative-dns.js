'use strict';

// Authoritative-direct registration probes.
//
// For `label.tld` we ask the TLD's OWN nameservers (no recursion, raw UDP on
// dgram) and read the wire response with server/dns-wire.js. A TLD server
// answers one of three ways for a second-level label:
//   NXDOMAIN (AA=1)                   → not registered      (not_taken)
//   NOERROR + NS for the label        → delegated/registered (taken)
//   anything else (SERVFAIL, REFUSED, timeout, TC, wildcard/synthesized answers,
//   no NS for the exact name)         → unknown → caller falls back to the
//                                       recursive/DoH path. Never a guess.
//
// Nameserver IPs per TLD are discovered through the platform resolver once,
// cached in SQLite, and refreshed daily. Load is spread round-robin across all
// of a TLD's servers, each gated by its own token bucket. A per-TLD health
// record (rolling ambiguous ratio) routes a misbehaving TLD to fallback
// automatically and re-probes it after a cool-down.

const dgram = require('dgram');
const crypto = require('crypto');
const dnsPromises = require('dns').promises;
const wire = require('./dns-wire');

const DAY_MS = 24 * 60 * 60 * 1000;

function envInt(name, fallback, min = 0) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) ? Math.max(min, raw) : fallback;
}

function envFloat(name, fallback, min = 0) {
  const raw = parseFloat(process.env[name] || '');
  return Number.isFinite(raw) ? Math.max(min, raw) : fallback;
}

const DEFAULTS = {
  enabled: process.env.DOMAINSCOUT_AUTHORITATIVE_DNS !== '0',
  timeoutMs: envInt('DOMAINSCOUT_AUTHORITATIVE_DNS_TIMEOUT_MS', 1500, 200),
  retries: envInt('DOMAINSCOUT_AUTHORITATIVE_DNS_RETRIES', 1, 0),
  sockets: envInt('DOMAINSCOUT_AUTHORITATIVE_DNS_SOCKETS', 4, 1),
  maxInFlight: envInt('DOMAINSCOUT_AUTHORITATIVE_DNS_MAX_INFLIGHT', 2000, 10),
  perServerQps: envFloat('DOMAINSCOUT_AUTHORITATIVE_DNS_PER_SERVER_QPS', 40, 0.1),
  perServerBurst: envInt('DOMAINSCOUT_AUTHORITATIVE_DNS_PER_SERVER_BURST', 40, 1),
  nsRefreshMs: envInt('DOMAINSCOUT_AUTHORITATIVE_DNS_NS_REFRESH_MS', DAY_MS, 60000),
  healthWindow: envInt('DOMAINSCOUT_AUTHORITATIVE_DNS_HEALTH_WINDOW', 50, 5),
  healthMaxUnknownRatio: envFloat('DOMAINSCOUT_AUTHORITATIVE_DNS_HEALTH_MAX_UNKNOWN_RATIO', 0.5, 0.01),
  healthCooldownMs: envInt('DOMAINSCOUT_AUTHORITATIVE_DNS_HEALTH_COOLDOWN_MS', 15 * 60000, 1000),
  ipv6: process.env.DOMAINSCOUT_AUTHORITATIVE_DNS_IPV6 === '1',
};

function normalizeTld(tld) {
  const clean = String(tld || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  return /^[a-z0-9-]+$/.test(clean) ? clean : null;
}

function ensureAuthoritySchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tld_authority_cache (
      tld           TEXT PRIMARY KEY,
      servers_json  TEXT NOT NULL,
      refreshed_at  INTEGER NOT NULL,
      error         TEXT
    );
  `);
}

// ── Token bucket ─────────────────────────────────────────────────────────────
class TokenBucket {
  constructor(rate, burst, now) {
    this.rate = rate; this.burst = burst; this.tokens = burst; this.updatedAt = now();
    this.now = now;
  }
  refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.updatedAt) / 1000) * this.rate);
    this.updatedAt = t;
  }
  tryTake() {
    this.refill();
    if (this.tokens >= 1) { this.tokens -= 1; return 0; }
    return Math.ceil(((1 - this.tokens) / this.rate) * 1000); // ms until a token exists
  }
}

// ── Per-TLD health ───────────────────────────────────────────────────────────
class TldHealth {
  constructor(opts, now) {
    this.window = opts.healthWindow; this.maxRatio = opts.healthMaxUnknownRatio;
    this.cooldownMs = opts.healthCooldownMs; this.now = now;
    this.samples = []; this.unknown = 0; this.degradedUntil = 0; this.degradedCount = 0;
  }
  record(status) {
    const bad = status === 'unknown' ? 1 : 0;
    this.samples.push(bad); this.unknown += bad;
    if (this.samples.length > this.window) this.unknown -= this.samples.shift();
    if (this.samples.length >= Math.min(this.window, 10) && this.unknown / this.samples.length > this.maxRatio) {
      this.degradedUntil = this.now() + this.cooldownMs; this.degradedCount += 1;
      this.samples = []; this.unknown = 0;
    }
  }
  healthy() { return this.now() >= this.degradedUntil; }
  snapshot() {
    return { healthy: this.healthy(), degradedUntil: this.degradedUntil || null, degradedCount: this.degradedCount,
      windowSize: this.samples.length, unknownInWindow: this.unknown };
  }
}

// ── Default UDP transport (dgram socket pool, ID+question matching) ──────────
function createUdpTransport({ sockets = 4, maxInFlight = 2000, now = Date.now } = {}) {
  const pool = { v4: [], v6: [] };
  const inflight = new Map(); // key `${socketIdx}:${id}` → { resolve, timer, question }
  let inflightCount = 0;
  let rr = 0;

  function make(family, idx) {
    const sock = dgram.createSocket({ type: family === 6 ? 'udp6' : 'udp4', reuseAddr: true });
    sock.on('message', (msg, remote) => {
      if (msg.length < 12) return;
      const key = `${family}:${idx}:${msg.readUInt16BE(0)}`;
      const entry = inflight.get(key);
      if (!entry || remote.port !== 53 || remote.address !== entry.server) return; // wrong endpoint or ID
      let decoded;
      try { decoded = wire.decodeMessage(msg); } catch (err) { entry.resolve({ error: err }); return; }
      const q = decoded.questions[0];
      if (!q || wire.normalizeName(q.name) !== entry.question || q.type !== wire.TYPE.NS || q.class !== wire.CLASS_IN || !decoded.flags.qr) return; // question mismatch: ignore
      entry.resolve({ message: decoded });
    });
    sock.on('error', () => {});
    sock.unref();
    try { sock.bind(); } catch (_) {}
    return sock;
  }
  for (let i = 0; i < sockets; i += 1) pool.v4.push(make(4, i));
  for (let i = 0; i < sockets; i += 1) { try { pool.v6.push(make(6, i)); } catch (_) {} }

  return {
    inflight: () => inflightCount,
    // Returns a promise of { message } | { timeout:true } | { error }.
    async query({ server, name, timeoutMs }) {
      if (inflightCount >= maxInFlight) return { error: new Error('inflight-limit') };
      const family = server.includes(':') ? 6 : 4;
      const list = family === 6 ? pool.v6 : pool.v4;
      if (!list.length) return { error: new Error(`no-udp${family}-socket`) };
      const idx = (rr += 1) % list.length;
      const sock = list[idx];
      const question = wire.normalizeName(name);
      let id;
      let key;
      for (let tries = 0; tries < 8; tries += 1) {
        id = crypto.randomInt(0x10000);
        key = `${family}:${idx}:${id}`;
        if (!inflight.has(key)) break;
        key = null;
      }
      if (!key) return { error: new Error('id-space-exhausted') };
      const buf = wire.encodeQuery({ id, name: question });
      inflightCount += 1;
      return new Promise((resolve) => {
        const done = (result) => {
          if (!inflight.has(key)) return;
          clearTimeout(entry.timer); inflight.delete(key); inflightCount -= 1; resolve(result);
        };
        const entry = { question, server, resolve: done, timer: setTimeout(() => done({ timeout: true }), timeoutMs) };
        inflight.set(key, entry);
        sock.send(buf, 0, buf.length, 53, server, (err) => { if (err) done({ error: err }); });
      });
    },
    close() { for (const s of [...pool.v4, ...pool.v6]) { try { s.close(); } catch (_) {} } },
  };
}

// ── Default NS discovery through the platform resolver ───────────────────────
async function discoverTldServersDefault(tld, { ipv6 = true } = {}) {
  const hosts = await dnsPromises.resolveNs(tld);
  const servers = [];
  await Promise.all(hosts.map(async (host) => {
    const v4 = await dnsPromises.resolve4(host).catch(() => []);
    for (const ip of v4) servers.push({ host, ip, family: 4 });
    if (ipv6) {
      const v6 = await dnsPromises.resolve6(host).catch(() => []);
      for (const ip of v6) servers.push({ host, ip, family: 6 });
    }
  }));
  if (!servers.length) throw new Error(`no-authoritative-addresses:${tld}`);
  return servers;
}

function createAuthoritativeResolver(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const database = opts.database || null;
  if (database) ensureAuthoritySchema(database);
  const transport = opts.transport || createUdpTransport({ sockets: opts.sockets, maxInFlight: opts.maxInFlight, now });
  const discover = opts.discover || ((tld) => discoverTldServersDefault(tld, { ipv6: opts.ipv6 }));
  const sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));

  const serversByTld = new Map();   // tld → { servers, refreshedAt, error }
  const discovering = new Map();     // tld → promise
  const buckets = new Map();         // ip → TokenBucket
  const health = new Map();          // tld → TldHealth
  const rrByTld = new Map();
  const stats = { queries: 0, taken: 0, not_taken: 0, unknown: 0, timeouts: 0, fallbackRouted: 0, discoveryErrors: 0 };

  const getCached = database ? database.prepare('SELECT servers_json, refreshed_at, error FROM tld_authority_cache WHERE tld = ?') : null;
  const putCached = database ? database.prepare(`
    INSERT INTO tld_authority_cache (tld, servers_json, refreshed_at, error) VALUES (@tld, @serversJson, @refreshedAt, @error)
    ON CONFLICT(tld) DO UPDATE SET servers_json = excluded.servers_json, refreshed_at = excluded.refreshed_at, error = excluded.error
  `) : null;

  function bucketFor(ip) {
    let b = buckets.get(ip);
    if (!b) { b = new TokenBucket(opts.perServerQps, opts.perServerBurst, now); buckets.set(ip, b); }
    return b;
  }
  function healthFor(tld) {
    let h = health.get(tld);
    if (!h) { h = new TldHealth(opts, now); health.set(tld, h); }
    return h;
  }

  async function serversFor(tld) {
    const cached = serversByTld.get(tld);
    if (cached && now() - cached.refreshedAt < opts.nsRefreshMs) return cached;
    if (!cached && getCached) {
      const row = getCached.get(tld);
      if (row && now() - Number(row.refreshed_at) < opts.nsRefreshMs) {
        let servers = [];
        try { servers = JSON.parse(row.servers_json); } catch (_) { servers = []; }
        const entry = { servers, refreshedAt: Number(row.refreshed_at), error: row.error || null };
        serversByTld.set(tld, entry);
        return entry;
      }
    }
    if (discovering.has(tld)) return discovering.get(tld);
    const p = (async () => {
      let entry;
      try {
        const servers = await discover(tld);
        entry = { servers: servers.filter(s => s && s.ip && (opts.ipv6 || !String(s.ip).includes(':'))), refreshedAt: now(), error: null };
      } catch (err) {
        stats.discoveryErrors += 1;
        // Keep stale servers when a refresh fails; record the error and retry later.
        entry = { servers: cached ? cached.servers : [], refreshedAt: now() - opts.nsRefreshMs + Math.min(opts.nsRefreshMs, 10 * 60000), error: String(err?.code || err?.message || err) };
      }
      serversByTld.set(tld, entry);
      if (putCached) { try { putCached.run({ tld, serversJson: JSON.stringify(entry.servers), refreshedAt: entry.refreshedAt, error: entry.error }); } catch (_) {} }
      return entry;
    })();
    discovering.set(tld, p);
    try { return await p; } finally { discovering.delete(tld); }
  }

  function pickServer(tld, servers) {
    if (!servers.length) return null;
    const start = (rrByTld.get(tld) || 0);
    for (let i = 0; i < servers.length; i += 1) {
      const idx = (start + i) % servers.length;
      const s = servers[idx];
      if (bucketFor(s.ip).tryTake() === 0) { rrByTld.set(tld, idx + 1); return s; }
    }
    // All buckets empty: wait for the soonest one.
    let best = null;
    for (const s of servers) {
      const wait = bucketFor(s.ip).tryTake();
      if (wait === 0) return s;
      if (!best || wait < best.wait) best = { server: s, wait };
    }
    return { wait: best.wait, server: best.server };
  }

  // Resolve `label.tld` → { status: 'taken'|'not_taken'|'unknown', reason, server }
  async function probe(domain) {
    const name = wire.normalizeName(domain);
    const dot = name.indexOf('.');
    const tld = dot > 0 ? normalizeTld(name.slice(dot + 1)) : null;
    if (!tld || name.slice(dot + 1).includes('.')) return { status: 'unknown', reason: 'not-a-second-level-name' };
    if (!opts.enabled) return { status: 'unknown', reason: 'authoritative-disabled' };
    const h = healthFor(tld);
    if (!h.healthy()) { stats.fallbackRouted += 1; return { status: 'unknown', reason: 'tld-degraded' }; }
    const entry = await serversFor(tld);
    if (!entry.servers.length) return { status: 'unknown', reason: `no-authoritative-servers:${entry.error || 'empty'}` };

    let last = { status: 'unknown', reason: 'unattempted' };
    for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
      let pick = pickServer(tld, entry.servers);
      while (pick && pick.wait) {
        await sleep(Math.min(pick.wait, 5000));
        pick = pickServer(tld, entry.servers);
      }
      const server = pick && pick.ip ? pick : (pick && pick.server) || entry.servers[0];
      stats.queries += 1;
      const result = await transport.query({ server: server.ip, name, timeoutMs: opts.timeoutMs });
      if (result.timeout) { stats.timeouts += 1; last = { status: 'unknown', reason: 'timeout', server: server.ip }; continue; }
      if (result.error) { last = { status: 'unknown', reason: `transport:${result.error.code || result.error.message}`, server: server.ip }; continue; }
      let classified = wire.classifyAuthoritativeNsResponse(result.message, { name });
      if (classified.status === 'mismatch') classified = { status: 'unknown', reason: classified.reason };
      last = { ...classified, server: server.ip };
      if (classified.status !== 'unknown') break;
      if (classified.reason === 'truncated' || classified.reason === 'refused' || classified.reason === 'nodata' ||
          classified.reason === 'wildcard' || classified.reason === 'cname-at-name') break; // retry will not change these
    }
    h.record(last.status);
    stats[last.status] += 1;
    return last;
  }

  function snapshot() {
    const tlds = {};
    for (const [tld, h] of health) tlds[tld] = { ...h.snapshot(), servers: (serversByTld.get(tld)?.servers || []).length, discoveryError: serversByTld.get(tld)?.error || null };
    return { enabled: opts.enabled, stats: { ...stats }, inflight: typeof transport.inflight === 'function' ? transport.inflight() : null, tlds };
  }

  return {
    probe,
    serversFor,
    snapshot,
    close() { if (typeof transport.close === 'function') transport.close(); },
    _internals: { TokenBucket, TldHealth, buckets, health },
  };
}

module.exports = {
  DEFAULTS,
  TokenBucket,
  TldHealth,
  createAuthoritativeResolver,
  createUdpTransport,
  discoverTldServersDefault,
  ensureAuthoritySchema,
  normalizeTld,
};
