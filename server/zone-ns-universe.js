'use strict';

/**
 * Sale reconstruction stage 3: zone-level seller/parking nameserver universe.
 *
 * The CZDS .com zone file carries the NS records of every delegated .com
 * name every day. This module streams that zone (never writing the raw file
 * to disk) and flags every name delegated to a known seller-listing or
 * parking/monetization nameserver, so the daily reconstruction universe is
 * zone-wide rather than limited to the GoDaddy listing scan.
 *
 * Single source of truth: the seller/parking nameserver tables live in
 * server/nameserver-classes.js (SELLER_NAMESERVERS / PARKING_NAMESERVERS).
 * This module carries no table of its own -- SELLER_PARKING_NAMESERVERS and
 * PARKING_ONLY_NAMESERVERS below are re-exports (for zone-ns-movement.js and
 * server/sale-watch.js) derived from that single table.
 *
 * Bounded-memory note: `buildZoneUniverseDayToStore` streams matched hits
 * straight into SQLite in small batches so the web process never holds the
 * full day's domain set in memory. `buildZoneUniverseDay` below is kept only
 * as the OLDER, UNBOUNDED, in-memory form (a Set/Map of the whole day) for
 * existing callers/tests; new callers should prefer the store variant.
 */

const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');

const { SELLER_NAMESERVERS, PARKING_NAMESERVERS } = require('./nameserver-classes');

// Re-exported names kept for backward compatibility with existing callers
// (server/zone-ns-movement.js, server/sale-watch.js): both are now derived
// entirely from server/nameserver-classes.js's canonical tables, never a
// local copy.
const PARKING_ONLY_NAMESERVERS = PARKING_NAMESERVERS;
const SELLER_PARKING_NAMESERVERS = Object.freeze([...SELLER_NAMESERVERS, ...PARKING_NAMESERVERS]);

function buildLookup(nameservers) {
  const exact = new Map();
  const suffix = [];
  for (const entry of nameservers) {
    const host = String(entry?.nameserver || '').toLowerCase().replace(/\.$/, '');
    if (!host) continue;
    exact.set(host, entry.provider);
    if (host.split('.').length <= 2 && !suffix.some((s) => s.domain === host)) {
      suffix.push({ domain: host, provider: entry.provider });
    }
  }
  return { exact, suffix };
}

function matchProvider(host, lookup) {
  if (lookup.exact.has(host)) return lookup.exact.get(host);
  for (const { domain, provider } of lookup.suffix) {
    if (host === domain || host.endsWith(`.${domain}`)) return provider;
  }
  return null;
}

async function fetchZoneDownloadLink({ user, pass, fetchImpl = fetch } = {}) {
  const authResp = await fetchImpl('https://account-api.icann.org/api/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!authResp.ok) throw new Error(`CZDS authenticate failed: ${authResp.status}`);
  const authBody = await authResp.json();
  const czdsAccess = authBody?.accessToken;
  if (!czdsAccess) throw new Error('CZDS authenticate returned no accessToken');

  const linksResp = await fetchImpl('https://czds-api.icann.org/czds/downloads/links', {
    headers: { Authorization: `Bearer ${czdsAccess}` },
  });
  if (!linksResp.ok) throw new Error(`CZDS download-links failed: ${linksResp.status}`);
  const links = await linksResp.json();
  const comLink = (Array.isArray(links) ? links : []).find((link) => String(link).endsWith('/com.zone'));
  if (!comLink) throw new Error('CZDS download-links response did not include a com.zone link');
  return { link: comLink, czdsAccess };
}

async function streamSellerDelegations(readable, { nameservers = SELLER_PARKING_NAMESERVERS, onHit = () => false } = {}) {
  const lookup = buildLookup(nameservers);
  const rl = readline.createInterface({ input: readable.pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let lines = 0;
  let nsRecords = 0;
  let hits = 0;
  for await (const line of rl) {
    lines += 1;
    if (!line) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const [rawName, , , rawType, rawRdata] = fields;
    if (String(rawType).toLowerCase() !== 'ns') continue;
    nsRecords += 1;
    let name = String(rawName).toLowerCase();
    if (name.endsWith('.')) name = name.slice(0, -1);
    if (!name || name === 'com') continue;
    let host = String(rawRdata).toLowerCase();
    if (host.endsWith('.')) host = host.slice(0, -1);
    const provider = matchProvider(host, lookup);
    if (provider) {
      if (onHit(name, provider) === true) hits += 1;
    }
  }
  return { lines, nsRecords, hits };
}

function ensureZoneNsUniverseSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS zone_ns_universe_hits (
      day TEXT NOT NULL,
      domain TEXT NOT NULL,
      provider TEXT NOT NULL,
      PRIMARY KEY (day, domain)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_zone_ns_universe_hits_day_domain
      ON zone_ns_universe_hits(day, domain);
    CREATE TABLE IF NOT EXISTS zone_ns_universe_runs (
      day TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      lines INTEGER,
      ns_records INTEGER,
      hits INTEGER,
      started_at TEXT,
      finished_at TEXT,
      error TEXT
    );
  `);
}

async function buildZoneUniverseDay({
  user = process.env.CZDS_USER,
  pass = process.env.CZDS_PASS,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  try {
    if (!user || !pass) return { ran: false, reason: 'no-czds-credentials' };

    const { link, czdsAccess } = await fetchZoneDownloadLink({ user, pass, fetchImpl });
    const response = await fetchImpl(link, { headers: { Authorization: `Bearer ${czdsAccess}` } });
    if (!response.ok || !response.body) {
      return { ran: false, reason: 'zone-download-failed', status: response.status };
    }

    const downloadStream = Readable.fromWeb(response.body);
    const domains = new Set();
    const providers = new Map();
    const { lines, nsRecords, hits } = await streamSellerDelegations(downloadStream, {
      onHit: (name, provider) => {
        if (domains.has(name)) return false;
        domains.add(name);
        providers.set(name, provider);
        return true;
      },
    });

    log(`[ZoneNsUniverse] com zone: ${nsRecords} ns records scanned, ${hits} seller/parking delegations`);
    return { ran: true, domains, providers, stats: { lines, nsRecords, hits } };
  } catch (err) {
    return { ran: false, reason: 'error', error: err.message };
  }
}

async function buildZoneUniverseDayToStore({
  database,
  day,
  user = process.env.CZDS_USER,
  pass = process.env.CZDS_PASS,
  fetchImpl = fetch,
  log = console.log,
  batchSize = 5000,
} = {}) {
  ensureZoneNsUniverseSchema(database);
  const startedAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO zone_ns_universe_runs (day, status, started_at)
    VALUES (@day, 'running', @startedAt)
    ON CONFLICT(day) DO UPDATE SET
      status = excluded.status,
      started_at = excluded.started_at,
      finished_at = NULL,
      error = NULL
  `).run({ day, startedAt });

  const fail = (reason, error) => {
    try {
      database.prepare(`
        UPDATE zone_ns_universe_runs
        SET status = 'failed', finished_at = @finishedAt, error = @error
        WHERE day = @day
      `).run({ day, finishedAt: new Date().toISOString(), error: error || reason });
    } catch (_) {}
    return { ran: false, day, reason, error };
  };

  try {
    if (!user || !pass) return fail('no-czds-credentials');

    const { link, czdsAccess } = await fetchZoneDownloadLink({ user, pass, fetchImpl });
    const response = await fetchImpl(link, { headers: { Authorization: `Bearer ${czdsAccess}` } });
    if (!response.ok || !response.body) {
      return fail('zone-download-failed', `status:${response.status}`);
    }

    const downloadStream = Readable.fromWeb(response.body);

    const insertStmt = database.prepare(`
      INSERT OR IGNORE INTO zone_ns_universe_hits (day, domain, provider) VALUES (?, ?, ?)
    `);
    const insertMany = database.transaction((rows) => {
      let changes = 0;
      for (const row of rows) {
        changes += insertStmt.run(row[0], row[1], row[2]).changes;
      }
      return changes;
    });

    let buffer = [];
    let totalHits = 0;
    const flush = () => {
      if (!buffer.length) return;
      totalHits += insertMany(buffer);
      buffer = [];
    };

    const { lines, nsRecords } = await streamSellerDelegations(downloadStream, {
      onHit: (name, provider) => {
        buffer.push([day, name, provider]);
        if (buffer.length >= batchSize) flush();
        return false;
      },
    });
    flush();

    const finishedAt = new Date().toISOString();
    database.prepare(`
      UPDATE zone_ns_universe_runs
      SET status = 'complete', lines = @lines, ns_records = @nsRecords, hits = @hits,
          finished_at = @finishedAt, error = NULL
      WHERE day = @day
    `).run({ day, lines, nsRecords, hits: totalHits, finishedAt });

    log(`[ZoneNsUniverse] com zone day ${day}: ${nsRecords} ns records scanned, ${totalHits} seller/parking hits stored`);
    return { ran: true, day, hits: totalHits, lines, nsRecords };
  } catch (err) {
    return fail('error', err.message);
  }
}

module.exports = {
  SELLER_PARKING_NAMESERVERS,
  PARKING_ONLY_NAMESERVERS,
  fetchZoneDownloadLink,
  streamSellerDelegations,
  ensureZoneNsUniverseSchema,
  buildZoneUniverseDay,
  buildZoneUniverseDayToStore,
};
