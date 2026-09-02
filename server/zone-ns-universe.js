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
 * Bounded-memory note: `buildZoneUniverseDayToStore` streams matched hits
 * straight into SQLite in small batches so the web process never holds the
 * full day's domain set in memory. `buildZoneUniverseDay` below is kept only
 * as the OLDER, UNBOUNDED, in-memory form (a Set/Map of the whole day) for
 * existing callers/tests; new callers should prefer the store variant.
 */

const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');

// Reuse the exact seller-listing nameserver list sale-watch-discovery.js
// already maintains (single source of truth). Fall back to a local copy of
// the same list only if that module ever stops exporting it.
let baseSellerNameservers;
try {
  const discovery = require('./sale-watch-discovery');
  baseSellerNameservers = Array.isArray(discovery.SELLER_NAMESERVERS) ? discovery.SELLER_NAMESERVERS : null;
} catch (_) {
  baseSellerNameservers = null;
}
if (!baseSellerNameservers) {
  baseSellerNameservers = Object.freeze([
    { provider: 'Afternic', nameserver: 'ns1.afternic.com' },
    { provider: 'Afternic', nameserver: 'ns2.afternic.com' },
    { provider: 'Afternic', nameserver: 'ns3.afternic.com' },
    { provider: 'Afternic', nameserver: 'ns4.afternic.com' },
    { provider: 'Afternic', nameserver: 'ns5.afternic.com' },
    { provider: 'Afternic', nameserver: 'ns6.afternic.com' },
    { provider: 'Dan', nameserver: 'ns1.dan.com' },
    { provider: 'Dan', nameserver: 'ns2.dan.com' },
    { provider: 'Sedo', nameserver: 'ns1.sedoparking.com' },
    { provider: 'Sedo', nameserver: 'ns2.sedoparking.com' },
    { provider: 'Sedo', nameserver: 'sl1.sedo.com' },
    { provider: 'Sedo', nameserver: 'sl2.sedo.com' },
    { provider: 'Atom', nameserver: 'ns1.atom.com' },
    { provider: 'Atom', nameserver: 'ns2.atom.com' },
    { provider: 'Atom / Squadhelp', nameserver: 'ns1.squadhelp.com' },
    { provider: 'Atom / Squadhelp', nameserver: 'ns2.squadhelp.com' },
    { provider: 'BrandBucket', nameserver: 'ns1.brandbucket.com' },
    { provider: 'BrandBucket', nameserver: 'ns2.brandbucket.com' },
    { provider: 'Nameshift', nameserver: 'ns1.nameshift.com' },
    { provider: 'Nameshift', nameserver: 'ns2.nameshift.com' },
    { provider: 'Bodis', nameserver: 'ns1.bodis.com' },
    { provider: 'Bodis', nameserver: 'ns2.bodis.com' },
    { provider: 'ParkingCrew', nameserver: 'ns1.parkingcrew.net' },
    { provider: 'ParkingCrew', nameserver: 'ns2.parkingcrew.net' },
    { provider: 'Efty', nameserver: 'ns1.eftydns.com' },
    { provider: 'Efty', nameserver: 'ns2.eftydns.com' },
    { provider: 'HugeDomains / NameBright', nameserver: 'nsg1.namebrightdns.com' },
    { provider: 'HugeDomains / NameBright', nameserver: 'nsg2.namebrightdns.com' },
    { provider: 'BuyDomains', nameserver: 'ns.buydomains.com' },
    { provider: 'BuyDomains', nameserver: 'this-domain-for-sale.com' },
  ]);
}

// Parking/marketplace landers not already covered above. ns1/ns2.domaincontrol.com
// (GoDaddy's registrar-default DNS) is intentionally EXCLUDED here — it is
// assigned to every GoDaddy-registered domain regardless of sale/parking
// status, so including it would flood the universe with false positives.
const PARKING_ONLY_NAMESERVERS = Object.freeze([
  { provider: 'Above.com', nameserver: 'above.com' },
  { provider: 'Uniregistry Market', nameserver: 'uniregistrymarket.link' },
  { provider: 'ParkLogic', nameserver: 'parklogic.com' },
  { provider: 'SmartName', nameserver: 'smartname.com' },
  { provider: 'Dynadot Parking', nameserver: 'park1.dynadot.com' },
  { provider: 'Dynadot Parking', nameserver: 'park2.dynadot.com' },
  { provider: 'DNParking', nameserver: 'ns1.dnparking.com' },
  { provider: 'DNParking', nameserver: 'ns2.dnparking.com' },
  { provider: 'Epik', nameserver: 'ns1.epik.com' },
  { provider: 'Epik', nameserver: 'ns2.epik.com' },
  { provider: 'Undeveloped', nameserver: 'ns1.undeveloped.com' },
  { provider: 'Undeveloped', nameserver: 'ns2.undeveloped.com' },
  { provider: 'Sav.com', nameserver: 'ns1.sav.com' },
  { provider: 'Sav.com', nameserver: 'ns2.sav.com' },
  { provider: 'Bodis', nameserver: 'ns1.bodis.com' },
  { provider: 'Bodis', nameserver: 'ns2.bodis.com' },
]);

const SELLER_PARKING_NAMESERVERS = Object.freeze([...baseSellerNameservers, ...PARKING_ONLY_NAMESERVERS]);

/**
 * Builds an { exact: Map<host, provider>, suffix: [{domain, provider}] }
 * lookup from a nameserver list. Two-label entries (e.g. above.com) match by
 * suffix (covers every subdomain host); longer entries (e.g. ns1.epik.com)
 * match exactly.
 */
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

/**
 * Authenticates against CZDS and returns the .com zone download link plus
 * the Bearer access value needed to fetch it. Same request shape as
 * server/czds-prefix-scan.js, but on global fetch rather than axios.
 */
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

/**
 * Consumes a gzip-compressed readable of the zone (readline over
 * zlib.createGunzip()) and calls onHit(name, provider) for every NS record
 * whose rdata matches a known seller/parking nameserver. This no longer
 * keeps its own dedupe Set — callers own dedup semantics (in-memory for the
 * legacy builder, PRIMARY KEY-based for the bounded store builder). `hits`
 * in the return value is a plain counter incremented whenever onHit returns
 * exactly `true`; callers that dedupe elsewhere (e.g. via batched SQL
 * inserts) can ignore this counter and report their own instead.
 */
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

/**
 * Creates the bounded on-disk store for zone NS universe hits, if missing.
 * `zone_ns_universe_hits` is the streamed hit table (PRIMARY KEY dedupes per
 * day); `zone_ns_universe_runs` records one row per day's run status so the
 * child worker's outcome is observable without holding anything in process
 * memory.
 */
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

/**
 * Never-throw daily builder: authenticates, downloads the .com zone body
 * streamed (never written to disk), and returns every seller/parking
 * delegated domain plus its provider label. Returns {ran:false,...} on any
 * missing-credential or failure condition instead of throwing, so the daily
 * orchestrator can treat this as an optional union source.
 *
 * UNBOUNDED LEGACY FORM: this keeps a process-wide Set/Map of the whole
 * day's matches in memory. Kept only for existing callers/tests; use
 * `buildZoneUniverseDayToStore` for anything that runs in the web process.
 */
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

/**
 * Bounded-memory daily builder: same auth/download as buildZoneUniverseDay,
 * but streams matched hits into `zone_ns_universe_hits` in batches of
 * `batchSize` rows instead of accumulating a process-wide Set/Map. Memory
 * stays O(batchSize) regardless of zone size. Records a
 * `zone_ns_universe_runs` row (`running` -> `complete`/`failed`) so an
 * external caller can observe outcome without holding results in memory
 * either. Never throws.
 */
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
    const response = await fetchImpl(link, { headers: { Authorization: [redacted] ${czdsAccess}` } });
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
