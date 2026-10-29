'use strict';

// Sale Watch theme-search precision against the exact production noise seen at
// f3c6494 (GET /api/sale-watch/candidates?days=7&q=compute|inference).
// No network: in-memory SQLite plus the pure ledger matcher.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ensureReconstructionSchema } = require('../server/sale-watch-reconstruction');
const { readSaleWatchCandidates } = require('../server/sale-watch-candidates');
const { pageSaleLedger } = require('../server/sale-watch');
const search = require('../server/sale-watch-search');

const NOW = new Date('2026-10-28T12:00:00Z');
const DAY = '2026-10-27';
const SELLER = ['ns1.dan.com', 'ns2.dan.com'];

const COMPUTE_NOISE = ['computerdealz.com', 'gizcomputer.com', 'oaklandcomputerrepair.com', 'bayareacomputersupport.com',
  'ausclub-casino.com', 'bbwporn.one', 'bettingexchange.uno', 'aris99.vip'];
const COMPUTE_WANTED = ['pilotcompute.com', 'queuecompute.com', 'computediscovery.com'];
const INFERENCE_WANTED = ['pulseinference.com', 'verxl.com', 'lallm.com', 'llmgem.com', 'gpuvast.net', 'robotinfer.com', 'smallllms.com'];
const INFERENCE_NOISE = ['g89pu140bt.skin', 'l24lm551bp.skin', 'vy86l0lm8zb-gml5.top', 't42pu317eu.skin',
  'tpusa.mom', 'tpuss.com', 'fireballcasino1-hu.com', 'raspadinhadasortee.com', 'pornllm.site'];

function evidence(domain, { destination = [`ns1.${domain.replace(/\./g, '-')}.example`], homepage = null, extra = {} } = {}) {
  return {
    domain, tier: 'suspected', reportDate: DAY, sellerNameservers: SELLER, buyerNameservers: destination,
    discovery: {
      movement: { day: DAY, prevDay: DAY, previousNameservers: SELLER, currentNameservers: destination, source: 'daily-zone-delegation-diff' },
      structurallyMoved: true, departureDate: DAY, ...(homepage ? { homepage } : {}),
    },
    ...extra,
  };
}

function insert(db, domain, opts = {}) {
  db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, ?, ?, ?)`)
    .run(domain, DAY, DAY, DAY, DAY, opts.probeCount || 0, JSON.stringify(evidence(domain, opts)), `${DAY}T00:00:00Z`);
}

const spamSite = title => ({ probeCount: 1, homepage: { active: true, parked: false, placeholder: false, status: 200, title, description: title, purpose: { kind: 'spam', spam: true } }, extra: { assessment: { contentQuality: 'spam' } } });
const builtSite = title => ({ probeCount: 1, homepage: { active: true, parked: false, placeholder: false, status: 200, title, description: title } });

function buildDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  for (const domain of [...COMPUTE_NOISE, ...COMPUTE_WANTED, ...INFERENCE_WANTED, ...INFERENCE_NOISE]) insert(db, domain);
  // Spam/adult/gambling assessment: never a site or theme hit, but an exact name hit still shows.
  insert(db, 'nimbuscloud.com', spamSite('Inference casino bonus slots'));
  insert(db, 'pulsecompute.com', spamSite('Casino slots'));
  // A buyer-built on-theme site ranks first.
  insert(db, 'hollowmint.com', builtSite('Hollow - GPU compute marketplace for inference'));
  for (const row of db.prepare('SELECT domain, evidence_json FROM sale_watch_candidates').all()) search.writeSearchDocument(db, row.domain, row.evidence_json);
  return db;
}

const read = (db, q) => readSaleWatchCandidates(db, { now: NOW, days: 7, q, limit: 500 });

test('q=compute: segment word boundary (never computer/computers), no casino/porn/junk theme hits', () => {
  const db = buildDb();
  const domains = read(db, 'compute').rows.map(row => row.domain);
  for (const domain of COMPUTE_NOISE) assert.ok(!domains.includes(domain), `${domain} must not match compute`);
  for (const domain of COMPUTE_WANTED) assert.ok(domains.includes(domain), `${domain} must match compute`);
  const byDomain = Object.fromEntries(read(db, 'compute').rows.map(row => [row.domain, row]));
  assert.equal(byDomain['pilotcompute.com'].matchedOn, 'name');
  assert.equal(byDomain['queuecompute.com'].matchedOn, 'name');
});

test('q=inference: random kit labels, tpu inside words and casino/porn names never match', () => {
  const db = buildDb();
  const domains = read(db, 'inference').rows.map(row => row.domain);
  for (const domain of INFERENCE_NOISE) assert.ok(!domains.includes(domain), `${domain} must not match inference`);
  for (const domain of ['pulseinference.com', 'lallm.com', 'gpuvast.net', 'robotinfer.com']) assert.ok(domains.includes(domain), `${domain} must match inference`);
});

test('spam/adult/gambling assessments: excluded from site and theme matches, exact name matches still show', () => {
  const db = buildDb();
  assert.ok(!read(db, 'inference').rows.some(row => row.domain === 'nimbuscloud.com'), 'spam site text never matches');
  const pulse = read(db, 'compute').rows.find(row => row.domain === 'pulsecompute.com');
  assert.ok(pulse && pulse.matchedOn === 'name', 'exact name match still shows');
});

test('ranking: buyer-built on-theme site first, then alpha names, then the rest', () => {
  const db = buildDb();
  const rows = read(db, 'inference').rows;
  assert.equal(rows[0].domain, 'hollowmint.com');
  const index = domain => rows.findIndex(row => row.domain === domain);
  // pulseinference.com is alpha; llmgem.com is standard.
  assert.ok(index('pulseinference.com') < index('llmgem.com'));
});

test('ranking: kit/batch rows rank last, below every other tier', () => {
  const db = buildDb();
  // gpuserve.com is an alpha name, but its destination brand took 3+ names (a title kit).
  insert(db, 'gpuserve.com');
  db.prepare("UPDATE sale_watch_candidates SET evidence_json = json_set(evidence_json, '$.discovery.kit', json(?)) WHERE domain = 'gpuserve.com'")
    .run(JSON.stringify({ key: 'gpu-kit', size: 4 }));
  const row = db.prepare("SELECT evidence_json FROM sale_watch_candidates WHERE domain = 'gpuserve.com'").get();
  search.writeSearchDocument(db, 'gpuserve.com', row.evidence_json);
  const rows = read(db, 'inference').rows;
  assert.equal(rows.at(-1).domain, 'gpuserve.com', rows.map(r => r.domain).join(','));
  assert.ok(rows.findIndex(r => r.domain === 'llmgem.com') < rows.findIndex(r => r.domain === 'gpuserve.com'));
  // A destination batch (cohort >= BATCH_MIN_NAMES) is ranked in the same last tier.
  const match = { matchedOn: 'name', onTheme: true };
  assert.ok(search.resultRank(match, { domain: 'pulseinference.com', built: true, batch: true })
    > search.resultRank({ matchedOn: 'theme', onTheme: true }, { domain: 'llmgem.com' }));
});

test('the in-memory ledger matcher applies the same precision rules', () => {
  const entries = [...COMPUTE_NOISE, ...COMPUTE_WANTED, ...INFERENCE_WANTED, ...INFERENCE_NOISE]
    .map(domain => ({ domain, tier: 'suspected', reportDate: DAY }));
  const clone = () => entries.map(entry => ({ ...entry }));
  const compute = pageSaleLedger({ entries: clone(), excludedEntries: [] }, [], { q: 'compute' }).entries.map(e => e.domain);
  for (const domain of COMPUTE_NOISE) assert.ok(!compute.includes(domain), `ledger: ${domain} must not match compute`);
  for (const domain of ['pilotcompute.com', 'queuecompute.com']) assert.ok(compute.includes(domain));
  const inference = pageSaleLedger({ entries: clone(), excludedEntries: [] }, [], { q: 'inference' }).entries.map(e => e.domain);
  for (const domain of INFERENCE_NOISE) assert.ok(!inference.includes(domain), `ledger: ${domain} must not match inference`);
  for (const domain of ['pulseinference.com', 'lallm.com', 'gpuvast.net', 'robotinfer.com']) assert.ok(inference.includes(domain));
});

test('SEARCH_VERSION is bumped so the worker re-renders old documents in place', () => {
  assert.equal(search.SEARCH_VERSION, 'sale-watch-search/v6');
});

// ── weak theme terms: serving/tokens/compute/accelerator never tag AI inference alone ──

test('weak inference terms count only with a strong term in the same document (index time)', () => {
  const { themeMatches } = require('../server/movement-report-semantics');
  const ids = tokens => themeMatches(new Set(tokens)).map(m => m.id);
  for (const weak of ['serving', 'tokens', 'compute', 'accelerator']) {
    assert.ok(!ids([weak]).includes('aiinference'), `${weak} alone must not tag aiinference`);
    // A strong member of a DIFFERENT sub-theme (ai -> aigeneral) does not lift a weak inference term.
    assert.ok(!ids([weak, 'ai']).includes('aiinference'), `${weak} + ai must not tag aiinference`);
  }
  for (const strong of ['inference', 'llm', 'gpu', 'tensor', 'cuda', 'tpu', 'vllm', 'modelserving']) {
    const matches = themeMatches(new Set([strong, 'serving']));
    const sub = matches.find(m => m.id === 'aiinference');
    assert.ok(sub, `${strong} tags aiinference`);
    assert.ok(sub.terms.includes('serving'), `serving joins aiinference with ${strong}`);
  }
  const rill = search.buildSearchDocument('rillvector.com', evidence('rillvector.com', {
    homepage: { active: true, parked: false, placeholder: false, status: 200, title: 'Rill Vector', description: 'Fast serving for ai apps' },
  }));
  assert.ok(!rill.theme.split(' ').includes('aiinference'), rill.searchText);
  assert.equal(search.matchDocument(rill, 'serving', 'rillvector.com')?.matchedOn === 'theme', false);
  assert.equal(search.matchDocument(rill, 'inference', 'rillvector.com'), null);
  const gpu = search.buildSearchDocument('gpuserving.com', {});
  assert.ok(gpu.theme.split(' ').includes('aiinference'), gpu.searchText);
});

test('weak inference terms never theme-match at match time, even on documents built before v6', () => {
  // A v5 document stored aiinference from "serving" alone (rillvector.com, "theme: serving").
  const legacy = { name: 'rillvector rill vector', site: '', theme: 'ai aiinference',
    themeTerms: JSON.stringify({ ai: ['serving'], aiinference: ['serving'] }) };
  assert.equal(search.matchDocument(legacy, 'serving', 'rillvector.com'), null);
  assert.equal(search.matchDocument(legacy, 'inference', 'rillvector.com'), null);
  assert.equal(search.matchDocument(legacy, 'tokens', 'rillvector.com'), null);
  // With a strong term stored alongside, the same theme still matches.
  const strong = { ...legacy, themeTerms: JSON.stringify({ ai: ['llm', 'serving'], aiinference: ['llm', 'serving'] }) };
  assert.equal(search.matchDocument(strong, 'inference', 'rillvector.com')?.matchedOn, 'theme');
  // The SQL read path applies the same verdict through evaluateMatch.
  assert.equal(search.evaluateMatch(legacy, search.compileSearch('serving'), 'rillvector.com'), null);
});
