'use strict';

// Sale Watch search: q matches only buyer-meaningful text (domain, label words,
// observed site text, theme families), never classifier prose, nameservers or
// registrars; theme families widen recall; expiry-origin departures leave the
// tape and are counted; and the read path never writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { ensureReconstructionSchema, readReconstructionEntries } = require('../server/sale-watch-reconstruction');
const { readSaleWatchCandidates } = require('../server/sale-watch-candidates');
const { pageSaleLedger } = require('../server/sale-watch');
const search = require('../server/sale-watch-search');

const NOW = new Date('2026-10-28T12:00:00Z');
const DAY = '2026-10-27';
const SELLER = ['ns1.dan.com', 'ns2.dan.com'];
const PROSE = 'Expiration/deletion evidence contradicts a purchase inference';

function evidence(domain, { seller = SELLER, destination = ['ns1.host.example'], homepage = null, extra = {} } = {}) {
  return {
    domain,
    tier: 'suspected',
    reportDate: DAY,
    sellerNameservers: seller,
    buyerNameservers: destination,
    discovery: {
      movement: { day: DAY, prevDay: DAY, previousNameservers: seller, currentNameservers: destination, source: 'daily-zone-delegation-diff' },
      structurallyMoved: true,
      departureDate: DAY,
      ...(homepage ? { homepage } : {}),
    },
    ...extra,
  };
}

function insert(db, domain, opts = {}) {
  db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, ?, ?, ?, ?, ?)`)
    .run(domain, DAY, DAY, DAY, opts.state || 'exited', DAY, opts.probeCount || 0, JSON.stringify(evidence(domain, opts)), `${DAY}T00:00:00Z`);
}

function seed(db) {
  insert(db, 'inferencevalley.com');
  insert(db, 'llmhub.com');
  insert(db, 'gpucloud.com');
  insert(db, 'acmeworks.com', { probeCount: 1, homepage: { active: true, parked: false, placeholder: false, status: 200, title: 'Acme', description: 'We run inference for your models at scale' } });
  // Only "inference" here is classifier prose, a registrar and a nameserver.
  insert(db, 'bluelemonrestaurant.com', {
    destination: ['ns1.inference-dns.example'],
    extra: { rationale: PROSE, counterEvidence: [PROSE], discovery: undefined },
  });
  db.prepare("UPDATE sale_watch_candidates SET evidence_json = json_set(evidence_json, '$.discovery.rdap', json(?)) WHERE domain = 'bluelemonrestaurant.com'")
    .run(JSON.stringify({ registrar: 'Inference Registrar LLC' }));
  // Departure from Web.com expiry/renewal nameservers: owner renewing, not a sale.
  insert(db, 'accountablearizona.org', { seller: ['ns1.renewyourname.net', 'ns2.renewyourname.net'], state: 'parked-watch', extra: { counterEvidence: [PROSE] } });
  db.prepare('INSERT OR REPLACE INTO sale_watch_movement_imports VALUES(?,?,?,?,?,?)')
    .run(DAY, 'sig', `${DAY}T01:00:00Z`, 100, 6, JSON.stringify({ day: DAY, departures: 100, expiryExcluded: 3, platformExcluded: 80, excludedByPolicy: 11, eligible: 6, cursorComplete: true }));
  search.indexAllMissingSearchDocuments(db);
  return db;
}

function buildDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  return seed(db);
}

const read = (db, params) => readSaleWatchCandidates(db, { now: NOW, days: 7, ...params });

test('false-hit regression: classifier prose, nameservers and registrars never match q', () => {
  const db = buildDb();
  const domains = read(db, { q: 'inference' }).rows.map(row => row.domain);
  assert.ok(!domains.includes('bluelemonrestaurant.com'), 'classifier prose / NS / registrar must not match');
  assert.ok(!domains.includes('accountablearizona.org'));
  assert.equal(read(db, { q: 'renewyourname' }).matched, 0);
  assert.equal(read(db, { q: 'expiration' }).matched, 0);
  assert.equal(read(db, { q: 'registrar' }).matched, 0);
  const row = db.prepare("SELECT search_text FROM sale_watch_candidates WHERE domain = 'bluelemonrestaurant.com'").get();
  assert.ok(!/inference/.test(row.search_text), row.search_text);
});

test('theme match: llm/gpu names match q=inference via the ai family, ranked name > site > theme', () => {
  const db = buildDb();
  const tape = read(db, { q: 'inference' });
  const byDomain = Object.fromEntries(tape.rows.map(row => [row.domain, row]));
  assert.equal(byDomain['inferencevalley.com'].matchedOn, 'name');
  assert.equal(byDomain['llmhub.com'].matchedOn, 'theme');
  assert.equal(byDomain['llmhub.com'].matchedTerm, 'llm');
  assert.equal(byDomain['gpucloud.com'].matchedOn, 'theme');
  assert.equal(byDomain['gpucloud.com'].matchedTerm, 'gpu');
  assert.deepEqual(tape.rows.map(row => row.matchedOn), ['name', 'site', 'theme', 'theme']);
  assert.equal(tape.matched, 4);
  // No q: rows carry no match fields and the response is unchanged in shape.
  assert.ok(read(db, {}).rows.every(row => row.matchedOn === undefined));
});

test('site match: text the probe saw on the page matches with matchedOn site', () => {
  const db = buildDb();
  const row = read(db, { q: 'inference' }).rows.find(r => r.domain === 'acmeworks.com');
  assert.ok(row);
  assert.equal(row.matchedOn, 'site');
  assert.equal(row.matchedTerm, 'inference');
});

test('cursor paging over a ranked q search walks every row exactly once', () => {
  const db = buildDb();
  const seen = [];
  let cursor = null;
  do {
    const page = read(db, { q: 'inference', limit: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...page.rows.map(row => row.domain));
    cursor = page.pagination.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, read(db, { q: 'inference' }).rows.map(row => row.domain));
});

test('expiry exclusion: expiry-origin departures leave the tape and count under excludedByReason.expiry', () => {
  const db = buildDb();
  const tape = read(db, {});
  assert.ok(!tape.rows.some(row => row.domain === 'accountablearizona.org'));
  assert.equal(tape.coverage.expiryOriginExcluded, 1);
  assert.equal(tape.coverage.excludedByReason.expiry, 3 + 1);
  assert.equal(tape.coverage.eligible, 5);
});

test('ledger pageSaleLedger: q never matches classifier prose and reports matchedOn', () => {
  const entries = [
    { domain: 'bluelemonrestaurant.com', tier: 'suspected', reportDate: DAY, rationale: PROSE, counterEvidence: [PROSE], sellerNameservers: ['ns1.inference.example'] },
    { domain: 'llmhub.com', tier: 'suspected', reportDate: DAY },
    { domain: 'inferencevalley.com', tier: 'suspected', reportDate: DAY },
  ];
  const ledger = pageSaleLedger({ entries, excludedEntries: [] }, [], { q: 'inference' });
  const domains = ledger.entries.map(entry => entry.domain).sort();
  assert.deepEqual(domains, ['inferencevalley.com', 'llmhub.com']);
  assert.equal(ledger.entries.find(e => e.domain === 'llmhub.com').matchedOn, 'theme');
});

test('read path issues no writes: candidates and ledger q searches run on a read-only handle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-search-'));
  const file = path.join(dir, 'sale_watch.db');
  const writer = new Database(file);
  ensureReconstructionSchema(writer);
  seed(writer);
  writer.close();
  const before = fs.readFileSync(file);
  const reader = new Database(file, { readonly: true });
  const startChanges = reader.prepare('SELECT total_changes() AS n').get().n;
  const tape = read(reader, { q: 'inference' });
  assert.equal(tape.matched, 4);
  const ledgerRows = readReconstructionEntries(reader, { q: 'inference', now: NOW }).map(row => row.domain);
  assert.ok(ledgerRows.includes('llmhub.com'));
  assert.ok(!ledgerRows.includes('bluelemonrestaurant.com'));
  assert.equal(reader.prepare('SELECT total_changes() AS n').get().n, startChanges);
  reader.close();
  assert.ok(before.equals(fs.readFileSync(file)), 'database file unchanged by reads');
});
