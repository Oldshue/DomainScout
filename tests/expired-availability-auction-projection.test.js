const assert = require('assert');
const path = require('path');
const Database = require('better-sqlite3');

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

function createFixture() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE domains (
      domain TEXT NOT NULL, base_name TEXT, tld TEXT, stream TEXT, source TEXT, status TEXT,
      auction_end TEXT, discovered_at TEXT, bid_count INTEGER, tlds_taken INTEGER DEFAULT 0,
      age_years INTEGER DEFAULT 0, wayback_snapshots INTEGER DEFAULT 0, has_numbers INTEGER DEFAULT 0,
      has_hyphens INTEGER DEFAULT 0, length INTEGER, drop_date TEXT, expiry_date TEXT,
      dns_available INTEGER, registration_available INTEGER, availability_checked_at TEXT,
      availability_error TEXT, availability_source TEXT
    );
    CREATE TABLE drop_events (
      domain TEXT NOT NULL, source TEXT NOT NULL, source_event_at TEXT NOT NULL, base_name TEXT, tld TEXT,
      source_kind TEXT, released_at TEXT, registration_available INTEGER, availability_checked_at TEXT,
      availability_source TEXT, observed_at TEXT, prior_registered_evidence TEXT,
      PRIMARY KEY (domain, source, source_event_at)
    ) WITHOUT ROWID;
    CREATE TABLE projected (
      domain TEXT PRIMARY KEY, stream TEXT NOT NULL, drop_date TEXT
    );
  `);
  const addDomain = database.prepare(`
    INSERT INTO domains (domain, base_name, tld, stream, status, auction_end, discovered_at, length, registration_available)
    VALUES (@domain, @base_name, @tld, @stream, @status, @auction_end, '2000-01-01T00:00:00.000Z', @length, @registration_available)
  `);
  const rows = [
    ['ended.ai', '.ai', 'namecheap-auction', 'active', '2001-01-01T00:00:00.000Z', null],
    ['unrelated.sh', '.sh', 'godaddy-auction', 'active', '2001-01-02T00:00:00.000Z', null],
    ['active.ai', '.ai', 'namecheap-auction', 'active', '2999-01-01T00:00:00.000Z', null],
    ['pending.ai', '.ai', 'namecheap-auction', 'pending-delete', '2001-01-03T00:00:00.000Z', null],
    ['random.ai', '.ai', 'namecheap-auction', 'active', '2001-01-04T00:00:00.000Z', 1],
  ];
  for (const [domain, tld, stream, status, auction_end, registration_available] of rows) {
    const base_name = domain.slice(0, domain.lastIndexOf('.'));
    addDomain.run({ domain, base_name, tld, stream, status, auction_end, length: base_name.length, registration_available });
  }
  const addEvidence = database.prepare(`
    INSERT INTO drop_events
      (domain, source, source_event_at, base_name, tld, source_kind, observed_at, prior_registered_evidence)
    VALUES (?, ?, ?, ?, ?, 'expired-auction-ended', datetime('now'), ?)
  `);
  addEvidence.run('ended.ai', 'auction:namecheap-auction', '2001-01-01T00:00:00.000Z', 'ended', '.ai', '{}');
  addEvidence.run('unrelated.sh', 'auction:godaddy-auction', '2001-01-02T00:00:00.000Z', 'unrelated', '.sh', '{}');
  database.prepare(`
    INSERT INTO drop_events (
      domain, source, source_event_at, base_name, tld, source_kind, released_at,
      registration_available, availability_checked_at, availability_source, observed_at
    ) VALUES (
      'ended.ai', 'availability:unrelated', '2026-08-04T12:30:00.000Z', 'ended', '.ai',
      'availability-observation', '2026-08-04T12:31:00.000Z', 1,
      '2026-08-04T12:31:00.000Z', 'rdap', '2026-08-04T12:31:00.000Z'
    )
  `).run();
  return database;
}

function dueParams(limit = 100) {
  return {
    limit, errorRefresh: '-1 hours', unknownRefresh: '-1 hours',
    unavailableRefresh: '-1 hours', availableRefresh: '-1 hours',
  };
}

function testEvidenceBackedCandidates(api, database) {
  const sql = api.candidateQuery(['.ai', '.sh']);
  const candidates = database.prepare(sql).all({ ...dueParams(), tld0: '.ai', tld1: '.sh' });
  assert.deepStrictEqual(candidates.map(row => row.domain).sort(), ['ended.ai', 'unrelated.sh']);

  const backlog = database.prepare(api.backlogEstimateQuery(['.ai', '.sh'])).all({
    ...dueParams(), tld0: '.ai', tld1: '.sh',
  });
  assert.strictEqual(backlog.reduce((sum, row) => sum + Number(row.n), 0), 2);
}

function projectionStatement(database) {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO projected (domain, stream, drop_date)
    SELECT @domain, 'just-dropped', drop_event.source_event_at
    FROM drop_events drop_event
    WHERE drop_event.domain = @domain
      AND drop_event.prior_registered_evidence IS NOT NULL
      AND drop_event.released_at IS NOT NULL
      AND drop_event.registration_available = 1
    ORDER BY drop_event.source_event_at DESC
    LIMIT 1
  `);
  return { run: values => insert.run(values) };
}

function testAvailabilityAndProjection(api, database) {
  const ended = {
    domain: 'ended.ai', base_name: 'ended', tld: '.ai', registration_available: 1,
    availability_checked_at: '2026-08-04T12:00:00.000Z', availability_source: 'rdap',
  };
  const project = projectionStatement(database);
  assert.strictEqual(api.projectConfirmedDrops([ended], { database, projectStatement: project }), 1);
  let event = database.prepare(
    'SELECT * FROM drop_events WHERE domain = ? AND prior_registered_evidence IS NOT NULL'
  ).get('ended.ai');
  assert.strictEqual(event.registration_available, 1);
  assert.strictEqual(event.released_at, ended.availability_checked_at);
  assert.strictEqual(api.projectConfirmedDrops([ended], { database, projectStatement: project }), 0);
  const projected = database.prepare('SELECT * FROM projected WHERE domain = ?').get('ended.ai');
  assert.strictEqual(projected.stream, 'just-dropped');
  assert.strictEqual(projected.drop_date, '2001-01-01T00:00:00.000Z');

  api.recordDropAvailabilityResult({
    domain: 'unrelated.sh', registration_available: 0, availability_checked_at: '2026-08-04T12:01:00.000Z',
    availability_source: 'rdap',
  }, database);
  event = database.prepare('SELECT * FROM drop_events WHERE domain = ?').get('unrelated.sh');
  assert.strictEqual(event.registration_available, 0);
  assert.strictEqual(event.released_at, null);
  assert.strictEqual(api.projectConfirmedDrops([{ ...ended, domain: 'unrelated.sh', registration_available: 0 }], { database, projectStatement: project }), 0);

  api.recordDropAvailabilityResult({
    domain: 'ended.ai', registration_available: null, availability_checked_at: '2026-08-04T12:02:00.000Z',
    availability_source: 'rdap',
  }, database);
  event = database.prepare(
    'SELECT * FROM drop_events WHERE domain = ? AND prior_registered_evidence IS NOT NULL'
  ).get('ended.ai');
  assert.strictEqual(event.registration_available, 1);
  assert.strictEqual(event.released_at, ended.availability_checked_at);
  assert.strictEqual(event.availability_checked_at, ended.availability_checked_at);

  assert.strictEqual(api.projectConfirmedDrops([{
    ...ended, domain: 'random.ai', availability_checked_at: '2026-08-04T12:03:00.000Z',
  }], { database, projectStatement: project }), 0);
  assert.strictEqual(database.prepare('SELECT * FROM drop_events WHERE domain = ?').get('random.ai'), undefined);
  assert.strictEqual(api.projectConfirmedDrops([{ ...ended, domain: 'active.ai' }], { database, projectStatement: project }), 0);
}

function main() {
  const api = loadAvailabilityModule();
  const database = createFixture();
  testEvidenceBackedCandidates(api, database);
  testAvailabilityAndProjection(api, database);
  database.close();
  console.log(`${path.basename(__filename)}: all assertions passed`);
}

main();
