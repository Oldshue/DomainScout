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
  // Synchronous seed: the cooperative indexer is async, so index each row
  // directly with the same per-row writer it uses.
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates WHERE search_text IS NULL AND evidence_json IS NOT NULL').all()) {
    search.writeSearchDocument(db, row.domain, row.evidence_json);
  }
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

// ── cooperative, bounded indexing ──────────────────────────────────────────

const { runProbeWave, ensureAssessmentVersion } = require('../server/sale-watch-reconstruction');

function insertOnDay(db, domain, day, opts = {}) {
  db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 0, ?, ?)`)
    .run(domain, day, day, day, day, JSON.stringify(evidence(domain, opts)), `${day}T00:00:00Z`);
}

function emptyDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  return db;
}

const unindexed = db => db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates WHERE search_text IS NULL').get().n;

test('async indexer yields: a setImmediate scheduled before indexing runs before it finishes', async () => {
  const db = emptyDb();
  db.transaction(() => { for (let i = 0; i < 2500; i += 1) insertOnDay(db, `name${i}.com`, DAY); })();
  let finished = false;
  let ranBeforeFinish = null;
  setImmediate(() => { ranBeforeFinish = !finished; });
  const result = await search.indexMissingSearchDocuments(db, { batch: 1000 });
  finished = true;
  assert.equal(ranBeforeFinish, true, 'the event loop got a turn while indexing');
  assert.equal(result.indexed, 2500);
  assert.equal(result.pages, 3, 'three 1000-row transactions');
  assert.equal(result.exhausted, true);
  assert.equal(unindexed(db), 0);
});

const DAYS = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
const quietWave = (db, extra = {}) => runProbeWave(db, {
  now: NOW.toISOString(), waveSize: 1, skipMovementImport: true, skipRdapSweep: true, skipTransferScreen: true,
  selectDueCandidates: async () => [], markAdoptionKits: () => null, ...extra,
});
const indexedDomains = db => db.prepare('SELECT domain FROM sale_watch_candidates WHERE search_text IS NOT NULL ORDER BY domain').all().map(r => r.domain);

test('runProbeWave honours the per-wave search-index cap, newest exit_observed_day first, and drains over waves', async () => {
  const db = emptyDb();
  DAYS.forEach((day, i) => insertOnDay(db, `wave${i}.com`, day));
  const first = await quietWave(db, { searchIndexPerWave: 3 });
  assert.equal(first.searchIndex.indexed, 3);
  assert.equal(first.searchIndex.exhausted, false);
  assert.deepEqual(indexedDomains(db), ['wave5.com', 'wave6.com', 'wave7.com']);
  const second = await quietWave(db, { searchIndexPerWave: 3 });
  assert.equal(second.searchIndex.indexed, 3);
  assert.deepEqual(indexedDomains(db), ['wave2.com', 'wave3.com', 'wave4.com', 'wave5.com', 'wave6.com', 'wave7.com']);
  const third = await quietWave(db, { searchIndexPerWave: 3 });
  assert.equal(third.searchIndex.indexed, 2);
  assert.equal(third.searchIndex.exhausted, true);
  assert.equal(unindexed(db), 0);
});

test('DOMAINSCOUT_SALE_WATCH_SEARCH_INDEX_PER_WAVE sets the per-wave cap', async () => {
  const db = emptyDb();
  DAYS.forEach((day, i) => insertOnDay(db, `env${i}.com`, day));
  const prior = process.env.DOMAINSCOUT_SALE_WATCH_SEARCH_INDEX_PER_WAVE;
  process.env.DOMAINSCOUT_SALE_WATCH_SEARCH_INDEX_PER_WAVE = '2';
  try {
    const summary = await quietWave(db);
    assert.equal(summary.searchIndex.indexed, 2);
    assert.deepEqual(indexedDomains(db), ['env6.com', 'env7.com']);
  } finally {
    if (prior === undefined) delete process.env.DOMAINSCOUT_SALE_WATCH_SEARCH_INDEX_PER_WAVE;
    else process.env.DOMAINSCOUT_SALE_WATCH_SEARCH_INDEX_PER_WAVE = prior;
  }
});

test('boot rebuild runs in the background: ensureAssessmentVersion returns before any index work', async () => {
  const db = buildDb();
  const version = () => (db.prepare("SELECT value FROM sale_watch_meta WHERE key = 'search_version'").get() || {}).value;
  assert.equal(version(), undefined, 'first run needs a rebuild');
  const result = ensureAssessmentVersion(db);
  assert.equal(result.search.background, true);
  assert.equal(result.search.started, true);
  // Synchronously after return: the rebuild has not cleared or indexed anything.
  assert.equal(version(), undefined);
  assert.equal(unindexed(db), 0);
  const rebuild = search.searchIndexRebuild(db);
  assert.ok(rebuild && typeof rebuild.then === 'function');
  const done = await rebuild;
  assert.equal(done.error, undefined);
  assert.equal(done.rebuilt, true);
  assert.equal(version(), search.SEARCH_VERSION);
  assert.equal(search.searchIndexRebuild(db), null);
});

test('a failing background rebuild is logged and never throws into the caller', async () => {
  const db = new Database(':memory:');
  const warnings = [];
  const started = search.startSearchIndexRebuild(db, { log: { log() {}, warn: message => warnings.push(message) } });
  assert.equal(started.started, true);
  const result = await search.searchIndexRebuild(db);
  assert.ok(result.error);
  assert.ok(warnings.some(message => /index rebuild failed/.test(message)), warnings.join('\n'));
});

test('q stays correct while rows are unindexed; coverage.searchIndex reports indexed/pending', async () => {
  const db = buildDb();
  const before = read(db, { q: 'inference' });
  const total = before.coverage.searchIndex.indexed + before.coverage.searchIndex.pending;
  assert.ok(total > 0);
  assert.deepEqual(before.coverage.searchIndex, { indexed: total, pending: 0, complete: true });
  // A rebuild has cleared search_text but not yet rewritten the documents.
  db.prepare('UPDATE sale_watch_candidates SET search_text = NULL').run();
  const during = read(db, { q: 'inference' });
  assert.deepEqual(during.rows.map(r => [r.domain, r.matchedOn]), before.rows.map(r => [r.domain, r.matchedOn]));
  assert.equal(during.matched, before.matched);
  assert.deepEqual(during.coverage.searchIndex, { indexed: 0, pending: total, complete: false });
  // Rows never indexed: domain matches need no index; others are counted as pending.
  insert(db, 'inferencelab.com');
  insert(db, 'acmelabs.com', { probeCount: 1, homepage: { active: true, parked: false, placeholder: false, status: 200, title: 'Acme Labs', description: 'Inference APIs for teams' } });
  const fresh = read(db, { q: 'inference' });
  assert.ok(fresh.rows.some(r => r.domain === 'inferencelab.com' && r.matchedOn === 'name'));
  assert.equal(fresh.coverage.searchIndex.pending, total + 2);
  assert.equal(fresh.coverage.searchIndex.complete, false);
  await search.indexAllMissingSearchDocuments(db);
  const after = read(db, { q: 'inference' });
  assert.equal((after.rows.find(r => r.domain === 'acmelabs.com') || {}).matchedOn, 'site');
  assert.deepEqual(after.coverage.searchIndex, { indexed: total + 2, pending: 0, complete: true });
});

// ── theme precision: q expands to the closest sub-theme, short terms are whole tokens ──

const site = (title, description, textSample = '') => ({ probeCount: 1, homepage: { active: true, parked: false, placeholder: false, status: 200, title, description, textSample } });

function precisionDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  // The exact production noise rows for q=inference, with realistic titles.
  insert(db, 'prezzi.com', site('Prezzi.com - Confronta prezzi e offerte online', 'Il comparatore di prezzi: risparmia sui tuoi acquisti', 'Vai ai prezzi migliori e ai negozi consigliati'));
  insert(db, 'ilovenote.com', site('iLoveNote - AI note taking app', 'Write, organize and share notes with AI summaries'));
  insert(db, 'guidecode.com', site('GuideCode - AI coding guides', 'Learn to code with step-by-step AI tutorials'));
  insert(db, 'pdl247.com', site('PDL247 - AI tools directory', 'Discover the best AI tools 24/7'));
  // Long page text alone never tags a theme.
  insert(db, 'quietpages.com', site('Quiet Pages', 'Handmade stationery shop', 'Our blog compares LLM and GPU prices for fun'));
  // Wanted AI inference/compute rows.
  insert(db, 'inferencevalley.com');
  insert(db, 'llmhost.ai');
  insert(db, 'gpuserve.com');
  insert(db, 'tensorstack.io');
  insert(db, 'nimbusrun.com', site('Nimbus - Serverless LLM inference', 'Deploy open models on demand'));
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  return db;
}

const NOISE = ['prezzi.com', 'ilovenote.com', 'guidecode.com', 'pdl247.com'];
const WANTED = ['inferencevalley.com', 'llmhost.ai', 'gpuserve.com', 'tensorstack.io'];

test('q=inference returns AI inference/compute names, never ai-flavoured noise (indexed tape)', () => {
  const db = precisionDb();
  const rows = read(db, { q: 'inference' }).rows;
  const byDomain = Object.fromEntries(rows.map(row => [row.domain, row]));
  for (const domain of NOISE) assert.ok(!byDomain[domain], `${domain} must not match q=inference`);
  assert.ok(!byDomain['quietpages.com'], 'long page text must not create a theme hit');
  for (const domain of WANTED) assert.ok(byDomain[domain] && ['name', 'theme'].includes(byDomain[domain].matchedOn), `${domain} must match`);
  assert.equal(byDomain['inferencevalley.com'].matchedOn, 'name');
  assert.equal(byDomain['llmhost.ai'].matchedTerm, 'llm');
  assert.equal(byDomain['gpuserve.com'].matchedTerm, 'gpu');
  assert.equal(byDomain['tensorstack.io'].matchedTerm, 'tensor');
  assert.equal(byDomain['nimbusrun.com'].matchedOn, 'site');
});

test('q=inference precision also holds for the in-memory ledger matcher', () => {
  const entries = [...NOISE, ...WANTED].map(domain => ({ domain, tier: 'suspected', reportDate: DAY }));
  entries.push({ domain: 'prezzi.com', tier: 'suspected', reportDate: DAY, buyerTitle: 'Confronta prezzi', discovery: { homepage: { title: 'Prezzi', textSample: 'vai ai prezzi' } } });
  const ledger = pageSaleLedger({ entries, excludedEntries: [] }, [], { q: 'inference' });
  assert.deepEqual(ledger.entries.map(e => e.domain).sort(), [...WANTED].sort());
});

test('theme expansion: inference maps to the inference/compute sub-theme; ai keeps the whole family', () => {
  const { themesForTerm } = require('../server/movement-report-semantics');
  assert.deepEqual(themesForTerm('inference'), ['aiinference']);
  assert.deepEqual(themesForTerm('model serving'), ['aiinference']);
  assert.ok(themesForTerm('ai').includes('ai'));
  const db = precisionDb();
  const ai = read(db, { q: 'ai' }).rows.map(row => row.domain);
  for (const domain of WANTED) assert.ok(ai.includes(domain), `q=ai keeps ${domain}`);
});

test('short terms match only whole tokens: never a substring of another word', () => {
  assert.equal(search.domainSubstringMatch('prezzi.com', 'ai'), false);
  assert.equal(search.domainSubstringMatch('inferencevalley.com', 'inference'), true);
  for (const domain of ['prezzi.com', 'pdl247.com', 'ilovenote.com', 'chairmail.com', 'mailbox.com']) {
    assert.equal(search.matchDocument(search.buildSearchDocument(domain, {}), 'ai', domain), null, domain);
  }
  assert.equal(search.matchDocument(search.buildSearchDocument('aibooks.net', {}), 'ai', 'aibooks.net').matchedOn, 'name');
  assert.equal(search.matchDocument(search.buildSearchDocument('gpuserve.com', {}), 'gpu', 'gpuserve.com').matchedOn, 'name');
  const said = search.buildSearchDocument('acmerepair.com', { discovery: { homepage: { title: 'Acme said', description: 'Repair and maintenance' } } });
  assert.equal(search.matchDocument(said, 'ai', 'acmerepair.com'), null);
  const word = search.buildSearchDocument('acmerepair.com', { discovery: { homepage: { title: 'Acme AI repair', description: '' } } });
  assert.equal(search.matchDocument(word, 'ai', 'acmerepair.com').matchedOn, 'site');
  const db = precisionDb();
  const prezzi = read(db, { q: 'ai' }).rows.find(row => row.domain === 'prezzi.com');
  // "prezzi" never yields a name or theme hit for ai; only the standalone
  // Italian word "ai" in the stored page text may match, as a site hit.
  assert.ok(!prezzi || prezzi.matchedOn === 'site', `prezzi.com must not match ai on ${prezzi && prezzi.matchedOn}`);
  const names = read(db, { q: 'ai' }).rows.filter(row => row.matchedOn !== 'site').map(row => row.domain);
  for (const domain of ['prezzi.com', 'pdl247.com', 'ilovenote.com']) assert.ok(!names.includes(domain) || read(db, { q: 'ai' }).rows.find(r => r.domain === domain).matchedOn !== 'name', `${domain} has no ai name hit`);
});
