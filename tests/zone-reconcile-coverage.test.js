'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileCzdsCoverage } = require('../server/zone-drop-census');

const ZONE_SOURCE = 'First-party Zone Diff';

function dotted(value) {
  const tld = String(value || '').toLowerCase();
  return tld.startsWith('.') ? tld : `.${tld}`;
}

function zoneDatabase({ stats = [], candidates = [] } = {}) {
  return {
    closed: false,
    prepare(sql) {
      if (sql.includes('PRAGMA table_info(zone_daily_stats)')) {
        return { all: () => [{ name: 'tld' }, { name: 'stat_date' }, { name: 'dropped_count' }, { name: 'had_previous' }] };
      }
      if (sql.includes('FROM zone_daily_stats')) {
        return {
          all: () => stats
            .filter((stat) => Number(stat.had_previous) === 1)
            .sort((a, b) => String(a.stat_date).localeCompare(String(b.stat_date)) || dotted(a.tld).localeCompare(dotted(b.tld)))
            .map((stat) => {
              const matched = candidates.filter((candidate) =>
                dotted(candidate.tld) === dotted(stat.tld) && String(candidate.drop_date) === String(stat.stat_date));
              return {
                tld: dotted(stat.tld),
                date: String(stat.stat_date),
                dropped_count: Number(stat.dropped_count || 0),
                candidate_count: matched.length,
                imported_count: matched.filter((candidate) => candidate.imported_at != null).length,
              };
            }),
        };
      }
      throw new Error(`unexpected zone query: ${sql}`);
    },
    close() { this.closed = true; },
  };
}

function primaryDatabase(events = []) {
  return {
    prepare(sql) {
      if (!sql.includes('FROM drop_events')) throw new Error(`unexpected primary query: ${sql}`);
      return {
        get(source, tld, date) {
          const matched = events.filter((event) => event.source === source
            && dotted(event.tld) === dotted(tld)
            && String(event.source_event_at).slice(0, 10) === String(date));
          return {
            observed: matched.length,
            available: matched.filter((event) => event.registration_available === 1).length,
            unavailable: matched.filter((event) => event.registration_available === 0).length,
            unknown: matched.filter((event) => event.registration_available == null).length,
          };
        },
      };
    },
  };
}

function noOpDropUniverse() {
  const calls = { receipts: [], registered: [], statuses: [] };
  return {
    calls,
    recordCoverageReceipt: (args) => calls.receipts.push(args),
    registerDropSource: (args) => calls.registered.push(args),
    recordDropSourceStatus: (args) => calls.statuses.push(args),
  };
}

function loadAvailabilityModule() {
  const dbPath = require.resolve('../server/db');
  const enrichmentPath = require.resolve('../enrichment');
  const qualityPath = require.resolve('../server/domain-quality');
  const availabilityPath = require.resolve('../server/expired-availability');
  const noOpStatement = {
    all: () => [],
    get: () => undefined,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { prepare: () => noOpStatement, transaction: fn => fn },
  };
  require.cache[enrichmentPath] = {
    id: enrichmentPath, filename: enrichmentPath, loaded: true,
    exports: {
      checkRegistrationAvailability: async () => ({ registration_available: null }),
      getRegistrarAvailabilityConfig: () => ({ configured: true, registrarRequiredAvailableTlds: [] }),
    },
  };
  require.cache[qualityPath] = {
    id: qualityPath, filename: qualityPath, loaded: true,
    exports: { computeDomainQuality: () => ({ score: 0, reasons: [] }) },
  };
  delete require.cache[availabilityPath];
  return require(availabilityPath);
}

test('reconcileCzdsCoverage: default opener owns and closes the zone db', () => {
  const zoneDb = zoneDatabase();
  const result = reconcileCzdsCoverage({
    database: primaryDatabase(), dropUniverse: noOpDropUniverse(), openZoneDbImpl: () => zoneDb,
  });
  assert.equal(result.failClosed, true);
  assert.equal(result.status, 'pending');
  assert.equal(zoneDb.closed, true);
});

test('reconcileCzdsCoverage: injected zoneDb is not closed', () => {
  const zoneDb = zoneDatabase();
  const result = reconcileCzdsCoverage({ zoneDb, database: primaryDatabase(), dropUniverse: noOpDropUniverse() });
  assert.equal(result.failClosed, true);
  assert.equal(zoneDb.closed, false);
});

test('reconcileCzdsCoverage: missing zone db fails closed', () => {
  const dropUniverse = noOpDropUniverse();
  const result = reconcileCzdsCoverage({
    database: primaryDatabase(), dropUniverse, openZoneDbImpl: () => null,
  });
  assert.deepEqual(
    { structuralErrors: result.structuralErrors, complete: result.complete, failClosed: result.failClosed, status: result.status },
    { structuralErrors: 1, complete: false, failClosed: true, status: 'error' },
  );
  assert.match(result.error, /zoneDb is required/);
  assert.equal(dropUniverse.calls.statuses.length, 1);
});

test('reconcileCzdsCoverage: opener error fails closed', () => {
  const result = reconcileCzdsCoverage({
    database: primaryDatabase(), dropUniverse: noOpDropUniverse(),
    openZoneDbImpl: () => { throw new Error('disk unavailable'); },
  });
  assert.equal(result.structuralErrors, 1);
  assert.equal(result.complete, false);
  assert.equal(result.failClosed, true);
  assert.equal(result.status, 'error');
  assert.match(result.error, /disk unavailable/);
});

test('reconcileCzdsCoverage: corrupt owned db fails closed and close error does not mask it', () => {
  const corrupt = {
    prepare() { throw new Error('database disk image is malformed'); },
    close() { throw new Error('close failed'); },
  };
  const result = reconcileCzdsCoverage({
    database: primaryDatabase(), dropUniverse: noOpDropUniverse(), openZoneDbImpl: () => corrupt,
  });
  assert.equal(result.structuralErrors, 1);
  assert.equal(result.failClosed, true);
  assert.equal(result.status, 'error');
  assert.match(result.error, /database disk image is malformed/);
});

test('reconcileCzdsCoverage: no ledger rows has explicit reason', () => {
  const result = reconcileCzdsCoverage({
    zoneDb: zoneDatabase(), database: primaryDatabase(), dropUniverse: noOpDropUniverse(),
  });
  assert.equal(result.sourceRows, 0);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'pending');
  assert.match(result.error, /no zone ledger rows available/i);
});

test('reconcileCzdsCoverage: undecided event has explicit pending reason', () => {
  const date = '2026-08-02';
  const zoneDb = zoneDatabase({
    stats: [{ tld: 'io', stat_date: date, dropped_count: 1, had_previous: 1 }],
    candidates: [{ domain: 'a.io', tld: '.io', drop_date: date, imported_at: `${date}T00:00:00.000Z` }],
  });
  const database = primaryDatabase([
    { domain: 'a.io', source: ZONE_SOURCE, tld: '.io', source_event_at: `${date}T00:00:00.000Z`, registration_available: null },
  ]);
  const result = reconcileCzdsCoverage({ zoneDb, database, dropUniverse: noOpDropUniverse() });
  assert.equal(result.structuralErrors, 0);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'pending');
  assert.match(result.error, /awaiting decisive/i);
});

test('reconcileCzdsCoverage: unrelated .com/.bio/.sh registrations do not affect .ai coverage', () => {
  const date = '2026-08-01';
  const zoneDb = zoneDatabase({
    stats: [{ tld: 'ai', stat_date: date, dropped_count: 1, had_previous: 1 }],
    candidates: [{ domain: 'foo.ai', tld: '.ai', drop_date: date, imported_at: `${date}T00:00:00.000Z` }],
  });
  const database = primaryDatabase([
    { domain: 'foo.ai', source: ZONE_SOURCE, tld: '.ai', source_event_at: `${date}T00:00:00.000Z`, registration_available: 1 },
    { domain: 'bar.com', source: 'auction:godaddy-auction', tld: '.com', source_event_at: `${date}T00:00:00.000Z`, registration_available: 1 },
    { domain: 'baz.bio', source: 'auction:namecheap-auction', tld: '.bio', source_event_at: `${date}T00:00:00.000Z`, registration_available: 0 },
    { domain: 'qux.sh', source: 'auction:godaddy-auction', tld: '.sh', source_event_at: `${date}T00:00:00.000Z`, registration_available: null },
  ]);
  const result = reconcileCzdsCoverage({ zoneDb, database, dropUniverse: noOpDropUniverse() });
  assert.equal(result.structuralErrors, 0);
  assert.equal(result.complete, true);
  assert.equal(result.status, 'complete');
  assert.equal(result.receipts.length, 1);
  assert.deepEqual(
    { tld: result.receipts[0].tld, observed: result.receipts[0].observed, available: result.receipts[0].available },
    { tld: '.ai', observed: 1, available: 1 },
  );
});

test('refreshExpiredAvailability: zero candidates delegates to injected coverage', async () => {
  const { refreshExpiredAvailability } = loadAvailabilityModule();
  let calls = 0;
  const coverage = {
    receipts: [], sourceRows: 0, structuralErrors: 0,
    complete: true, failClosed: true, status: 'complete', error: null,
  };
  const summary = await refreshExpiredAvailability({
    reconcileCoverage: async () => { calls += 1; return coverage; },
  });
  assert.equal(summary.candidates, 0);
  assert.equal(calls, 1);
  assert.deepEqual(summary.coverage, coverage);
});
