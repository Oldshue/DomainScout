'use strict';

// Sale Watch insights (server/sale-watch-insights.js): contract validation and
// rejection reasons, the POST reply shape, agent-token authority, history and
// latest-wins upsert, and a query-plan assertion for every statement.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ins = require('../server/sale-watch-insights');
const { AGENT_TOKEN_POST_PATHS } = require('../server/universe-token-paths');

let Database = null;
let sqliteSkip = false;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch (error) { sqliteSkip = `better-sqlite3 unavailable: ${error.message.split('\n')[0]}`; }

const ROW = Object.freeze({
  domain: 'brightpath.com', tape: 'aftermarket', construction: 'two-word', category: 'career coaching',
  buyerType: 'small-business', signal: 'strong', registeredYear: 2004, wordCount: 2,
  buyerUrl: 'https://brightpath.com/', lesson: 'Plain two-word .com names are selling to coaching businesses.',
});
const SOURCE = { kind: 'agentforge-run', runId: 'run_1', model: 'test-model' };

test('a contract row validates; registeredYear accepts a JSON integer or a 4-digit string', () => {
  assert.equal(ins.validateInsightRow(ROW).ok, true);
  assert.equal(ins.validateInsightRow({ ...ROW, registeredYear: '2004' }).ok, true);
  assert.equal(ins.validateInsightRow({ ...ROW, wordCount: 50, otherExtensionsTaken: 5000 }).ok, true);
});

test('off-contract rows are rejected with a reason, never coerced', () => {
  const reason = row => ins.validateInsightRow(row).reason;
  assert.match(reason({ ...ROW, tape: 'resale' }), /^tape: must be one of/);
  assert.match(reason({ ...ROW, construction: 'brandable' }), /^construction:/);
  assert.match(reason({ ...ROW, buyerType: 'corp' }), /^buyerType:/);
  assert.match(reason({ ...ROW, signal: 'high' }), /^signal:/);
  assert.match(reason({ ...ROW, wordCount: 51 }), /^wordCount: must be an integer from 0 to 50/);
  assert.match(reason({ ...ROW, wordCount: '2' }), /^wordCount:/);
  assert.match(reason({ ...ROW, otherExtensionsTaken: 5001 }), /^otherExtensionsTaken:/);
  assert.match(reason({ ...ROW, registeredYear: 20040 }), /^registeredYear:/);
  assert.match(reason({ ...ROW, buyerUrl: 'ftp://x.com/' }), /^buyerUrl:/);
  assert.match(reason({ ...ROW, buyerUrl: `https://x.com/${'a'.repeat(2000)}` }), /^buyerUrl: .*2000/);
  assert.match(reason({ ...ROW, category: 'x'.repeat(81) }), /^category: must be at most 80/);
  assert.match(reason({ ...ROW, lesson: 'x'.repeat(241) }), /^lesson:/);
  assert.match(reason({ ...ROW, buyer: null }), /^buyer: must be omitted when empty, never null/);
  assert.match(reason({ ...ROW, category: undefined }), /^category: required/);
  assert.match(reason({ ...ROW, extra: 1 }), /^extra: unknown field/);
  assert.match(reason({ ...ROW, priorAsk: '$4,999' }), /^priorAskUrl: required with priorAsk/);
  assert.match(reason({ ...ROW, domain: ' BrightPath.com' }), /^domain:/);
});

test('envelope errors throw; row errors are itemised', () => {
  assert.throws(() => ins.validateInsightPayload({ schema: 'x', source: SOURCE, rows: [ROW] }), /schema/);
  assert.throws(() => ins.validateInsightPayload({ schema: ins.WRITE_SCHEMA, source: { ...SOURCE, kind: 'other' }, rows: [ROW] }), /source.kind/);
  assert.throws(() => ins.validateInsightPayload({ schema: ins.WRITE_SCHEMA, source: SOURCE, rows: [] }), /rows/);
  assert.throws(() => ins.validateInsightPayload({ schema: ins.WRITE_SCHEMA, source: SOURCE, rows: Array(201).fill(ROW) }), /rows/);
  const out = ins.validateInsightPayload({ schema: ins.WRITE_SCHEMA, source: SOURCE, rows: [ROW, { ...ROW, domain: 'b.com', tape: 'x' }] });
  assert.equal(out.valid.length, 1);
  assert.deepEqual(out.rejected.map(r => r.domain), ['b.com']);
});

function routes(options) {
  const map = new Map();
  const app = { get(p, ...h) { map.set(`GET ${p}`, h.at(-1)); }, post(p, ...h) { map.set(`POST ${p}`, h.at(-1)); } };
  ins.registerSaleWatchInsightRoutes(app, options);
  return map;
}
async function call(handler, req) {
  const res = { code: 200, body: null, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ query: {}, ...req }, res);
  return res;
}

test('POST keeps the { accepted, rejected: [{ domain, reason }] } shape on success, row rejection, envelope error and outage', async () => {
  const r = routes({ insightWriter: async ({ rows }) => ({ accepted: rows.length - 1, rejected: [{ index: rows.at(-1).index, domain: rows.at(-1).value.domain, reason: 'domain: not a Sale Watch ledger name' }] }) });
  const post = r.get('POST /api/sale-watch/insights');
  const ok = await call(post, { body: { schema: ins.WRITE_SCHEMA, source: SOURCE, rows: [ROW, { ...ROW, domain: 'c.com', signal: 'x' }, { ...ROW, domain: 'notledger.com' }] } });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.accepted, 1);
  assert.deepEqual(ok.body.rejected.map(x => x.domain), ['c.com', 'notledger.com']);
  assert.ok(ok.body.rejected.every(x => typeof x.reason === 'string' && x.reason));
  const bad = await call(post, { body: { schema: 'nope', source: SOURCE, rows: [ROW] } });
  assert.equal(bad.code, 400);
  assert.equal(bad.body.accepted, 0);
  assert.deepEqual(bad.body.rejected.map(x => x.domain), ['brightpath.com']);
  const down = await call(routes({ insightWriter: async () => { throw new Error('disk'); } }).get('POST /api/sale-watch/insights'), { body: { schema: ins.WRITE_SCHEMA, source: SOURCE, rows: [ROW] } });
  assert.equal(down.code, 503);
  assert.equal(down.body.accepted, 0);
  assert.deepEqual(down.body.rejected, []);
});

test('GET routes reject off-contract queries with 400', async () => {
  const r = routes({ insightQueueLoader: async () => ({ rows: [] }), insightDailyLoader: async () => ({ days: [] }) });
  assert.equal((await call(r.get('GET /api/sale-watch/insights/pending'), { query: { days: '32' } })).code, 400);
  assert.equal((await call(r.get('GET /api/sale-watch/insights/pending'), { query: { limit: '0' } })).code, 400);
  assert.equal((await call(r.get('GET /api/sale-watch/daily'), { query: { tape: 'noise-ish' } })).code, 400);
  assert.equal((await call(r.get('GET /api/sale-watch/daily'), { query: { from: '2026-13-01' } })).code, 400);
  assert.equal((await call(r.get('GET /api/sale-watch/insights/pending'), { query: {} })).code, 200);
});

function loadAgentTokenAllowed(env) {
  const source = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const start = source.indexOf('function agentTokenAllowed');
  const end = source.indexOf('function requireAuth', start);
  const serverRequire = p => require(p.startsWith('./') ? path.join(root, 'server', p) : p);
  return Function('require', 'process', `${source.slice(start, end)}; return agentTokenAllowed;`)(serverRequire, { env });
}

test('an X-DomainScout-Token caller may POST insights; an unauthenticated caller may not', () => {
  assert.ok(AGENT_TOKEN_POST_PATHS.includes('/api/sale-watch/insights'));
  const token = 'agent-token-0123456789abcdef';
  const allowed = loadAgentTokenAllowed({ DOMAINSCOUT_AGENT_TOKEN: token });
  const req = headers => ({ method: 'POST', path: '/api/sale-watch/insights', headers, query: {} });
  assert.equal(allowed(req({ 'x-domainscout-token': token })), true);
  assert.equal(allowed(req({})), false);
  assert.equal(allowed(req({ 'x-domainscout-token': 'wrong-token-0123456789abcd' })), false);
  assert.equal(allowed({ ...req({ 'x-domainscout-token': token }), path: '/api/sale-watch/other' }), false);
});

function buildDb() {
  const db = new Database(':memory:');
  require('../server/sale-watch-reconstruction').ensureReconstructionSchema(db);
  require('../server/sale-watch-assessments').ensureAssessmentSchema(db);
  const view = db.prepare('INSERT INTO sale_watch_assessment_views(view, report_date, evidence_rank, dlen, domain) VALUES (?, ?, 0, ?, ?)');
  view.run('alpha', '2026-11-10', 14, 'brightpath.com');
  view.run('alpha', '2026-11-09', 7, 'zest.io');
  view.run('excluded', '2026-11-09', 9, 'gone.com');
  return db;
}

test('writes keep history, latest wins, retries upsert, non-ledger names are never stored', { skip: sqliteSkip }, () => {
  const db = buildDb();
  const first = ins.writeInsights(db, { source: SOURCE, rows: [{ index: 0, value: ROW }, { index: 1, value: { ...ROW, domain: 'gone.com' } }, { index: 2, value: { ...ROW, domain: 'nope.com' } }], now: '2026-11-11T10:00:00Z' });
  assert.equal(first.accepted, 1);
  assert.deepEqual(first.rejected.map(r => [r.domain, r.reason]), [['gone.com', 'domain: not a Sale Watch ledger name'], ['nope.com', 'domain: not a Sale Watch ledger name']]);
  const retry = ins.writeInsights(db, { source: SOURCE, rows: [{ index: 0, value: ROW }], now: '2026-11-11T10:00:01Z' });
  assert.equal(retry.accepted, 1);
  ins.writeInsights(db, { source: SOURCE, rows: [{ index: 0, value: { ...ROW, tape: 'builder', signal: 'medium' } }], now: '2026-11-11T11:00:00Z' });
  const current = ins.readCurrentInsights(db, ['brightpath.com', 'gone.com', 'nope.com']);
  assert.deepEqual(Object.keys(current), ['brightpath.com']);
  assert.equal(current['brightpath.com'].tape, 'builder');
  assert.equal(current['brightpath.com'].classifiedAt, '2026-11-11T11:00:00.000Z');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${ins.TABLE}`).get().n, 1);
  const history = ins.readInsightHistory(db, 'brightpath.com');
  assert.deepEqual(history.map(h => h.insight.tape), ['builder', 'aftermarket', 'aftermarket']);
  assert.equal(ins.lastInsightWrittenAt(db), '2026-11-11T11:00:00.000Z');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${ins.HISTORY_TABLE} WHERE domain IN ('gone.com','nope.com')`).get().n, 0);
});

test('every insight statement is index-driven (query plan)', { skip: sqliteSkip }, () => {
  const db = buildDb();
  ins.ensureInsightSchema(db);
  const plan = sql => {
    const names = [...sql.matchAll(/@(\w+)/g)].map(m => m[1]);
    const args = Object.fromEntries(names.map(n => [n, n === 'limit' || n === 'historyId' ? 1 : n === 'domains' ? '[]' : 'x']));
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(args).map(r => r.detail);
  };
  assert.match(plan(ins.SQL.currentForDomains).join(' | '), /SEARCH sale_watch_insights USING (?:PRIMARY KEY|INDEX sqlite_autoindex_sale_watch_insights_1) \(domain=\?\)/);
  assert.match(plan(ins.SQL.lastWritten).join(' | '), /SEARCH sale_watch_insights USING COVERING INDEX idx_sale_watch_insights_classified/);
  assert.match(plan(ins.SQL.ledgerMember).join(' | '), /SEARCH sale_watch_assessment_views USING (?:COVERING )?INDEX idx_sale_watch_assessment_views_domain \(domain=\?/);
  assert.match(plan(ins.SQL.historyForDomain).join(' | '), /SEARCH sale_watch_insight_history USING INDEX idx_sale_watch_insight_history_domain \(domain=\?\)/);
  for (const [name, sql] of Object.entries(ins.SQL)) {
    for (const line of plan(sql)) {
      if (/^SCAN/.test(line)) assert.match(line, /json_each|sqlite_master|CONSTANT ROW/, `${name} scans: ${line}`);
    }
  }
});
