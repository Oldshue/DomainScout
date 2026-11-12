'use strict';

// Sale Watch insights: what an outside agent desk learned about each ledger
// name (who bought it, what they do, how the name is built, which tape it
// belongs to), stored in sale_watch.db with full history, served day by day.
//
// Tables (created only by the writable worker below, never on the HTTP thread):
//   sale_watch_insight_history  every accepted write, in write order (id)
//   sale_watch_insights         the current (latest) write per domain
//
// Reads (readPendingQueue, readDaily) run in the Sale Watch read lane on a
// read-only connection and return plain, structured-clone-safe data only.
// The ledger comes from the existing stored-ledger reader
// (sale-watch-assessments.readStoredLedgerEntries, view 'alpha'), never the
// candidate tape. Every statement here is index-driven and bounded; the SQL
// is exported as SQL so tests assert each query plan.
//
// Writes (schema creation + insert history + upsert current) run in a worker
// thread with its own writable connection (writeInsightsOffThread), the same
// pattern as server/sale-watch-select-worker.js.

const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const QUEUE_SCHEMA = 'domainscout.sale-watch-insight-queue/v1';
const WRITE_SCHEMA = 'domainscout.sale-watch-insights/v1';
const DAILY_SCHEMA = 'domainscout.sale-watch-daily/v1';
const TABLE = 'sale_watch_insights';
const HISTORY_TABLE = 'sale_watch_insight_history';
const VIEWS_TABLE = 'sale_watch_assessment_views';
const LEDGER_VIEW = 'alpha';
// The feed reads exactly three stored views, merged by domain: 'probable'
// (likely-sale), 'transfer' (transfer-in-progress / transfer-completed) and
// 'alpha' (likely-sale + acquisition-candidate). It never reads 'suspected':
// in production that view is every unconfirmed nameserver move (about 10,000
// rows a day, a 58 s read). About 1,500 unique names per 14 days.
const LEDGER_VIEWS = Object.freeze(['probable', 'transfer', 'alpha']);
const DAILY_Q_MAX = 100;

const TAPES = Object.freeze(['aftermarket', 'builder', 'noise']);
const DAILY_TAPES = Object.freeze(['aftermarket', 'builder', 'noise', 'all']);
const CONSTRUCTIONS = Object.freeze(['one-word', 'two-word', 'three-plus-words', 'invented', 'exact-match-phrase', 'acronym', 'affix', 'name', 'geo-service', 'numeric', 'other']);
const BUYER_TYPES = Object.freeze(['startup', 'small-business', 'established-company', 'agency', 'nonprofit', 'individual', 'investor', 'unknown']);
const SIGNALS = Object.freeze(['strong', 'medium', 'weak', 'noise']);

const MAX_WRITE_ROWS = 200;
const MAX_WINDOW_DAYS = 31;
const DEFAULT_WINDOW_DAYS = 14;
// Daily feed windows (the screen's window control). 14 is the default and the
// primary snapshot; 30 and 90 are built after it, at lower priority.
const DAILY_WINDOWS = Object.freeze([14, 30, 90]);
const DAILY_MAX_WINDOW_DAYS = 90;
// The stored-ledger reader is paged by date range in chunks of this many days:
// each chunk is its own bounded read and WINDOW_READ_LIMIT is checked per
// chunk, so a 90-day window never needs a larger limit.
const READ_CHUNK_DAYS = 14;
const DEFAULT_QUEUE_LIMIT = 50;
const MAX_QUEUE_LIMIT = 200;
// Upper bound on ledger rows one window read returns per view (the stored
// reader's alpha cap). Production carries about 1,300 alpha rows per 14 days.
// A view that returns this many rows is an error (windowReadErrors in the
// daily diagnostics), never a silent truncation.
const WINDOW_READ_LIMIT = 5000;
// A daily page holds whole days until it reaches this many rows.
const DAILY_PAGE_ROWS = 120;
const BREAKDOWN_MAX = 12;
const WINDOW_CACHE_MS = 20000;
const WRITE_TIMEOUT_MS = 60000;

const SQL = Object.freeze({
  tableExists: `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = '${TABLE}'`,
  currentForDomains: `SELECT domain, history_id, classified_at, insight_json FROM ${TABLE} WHERE domain IN (SELECT value FROM json_each(@domains))`,
  lastWritten: `SELECT MAX(classified_at) AS at FROM ${TABLE}`,
  ledgerMember: `SELECT report_date FROM ${VIEWS_TABLE} WHERE domain = @domain AND view <> 'excluded' LIMIT 1`,
  insertHistory: `INSERT INTO ${HISTORY_TABLE}(domain, classified_at, report_date, tape, signal, insight_json, source_json) VALUES (@domain, @classifiedAt, @reportDate, @tape, @signal, @insight, @source)`,
  upsertCurrent: `INSERT INTO ${TABLE}(domain, history_id, classified_at, report_date, tape, signal, insight_json) VALUES (@domain, @historyId, @classifiedAt, @reportDate, @tape, @signal, @insight)
    ON CONFLICT(domain) DO UPDATE SET history_id = excluded.history_id, classified_at = excluded.classified_at, report_date = excluded.report_date, tape = excluded.tape, signal = excluded.signal, insight_json = excluded.insight_json`,
  historyForDomain: `SELECT id, classified_at, insight_json, source_json FROM ${HISTORY_TABLE} WHERE domain = @domain ORDER BY id DESC LIMIT @limit`,
});

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
    id INTEGER PRIMARY KEY,
    domain TEXT NOT NULL,
    classified_at TEXT NOT NULL,
    report_date TEXT NOT NULL DEFAULT '',
    tape TEXT NOT NULL,
    signal TEXT NOT NULL,
    insight_json TEXT NOT NULL,
    source_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_${HISTORY_TABLE}_domain ON ${HISTORY_TABLE} (domain, id);
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    domain TEXT PRIMARY KEY,
    history_id INTEGER NOT NULL,
    classified_at TEXT NOT NULL,
    report_date TEXT NOT NULL DEFAULT '',
    tape TEXT NOT NULL,
    signal TEXT NOT NULL,
    insight_json TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_${TABLE}_classified ON ${TABLE} (classified_at);
`;

class InsightQueryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.code = 'SALE_WATCH_INSIGHT_QUERY'; }
}

// ── dates ──────────────────────────────────────────────────────────────────
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isoDay(at) { return new Date(at == null ? Date.now() : at).toISOString().slice(0, 10); }
function validDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}
function dayMinus(day, n) {
  const v = new Date(`${day}T00:00:00.000Z`);
  v.setUTCDate(v.getUTCDate() - n);
  return v.toISOString().slice(0, 10);
}
function dayDiff(later, earlier) {
  return Math.round((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86400000);
}

// ── validation (reject with a reason, never coerce) ─────────────────────────
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
function isDomain(v) {
  return typeof v === 'string' && v.length >= 4 && v.length <= 253 && v === v.trim().toLowerCase()
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z0-9-]*[a-z0-9]$/.test(v) && !v.includes('..');
}
const oneOf = list => v => (typeof v === 'string' && list.includes(v) ? null : `must be one of ${list.join(', ')}`);
const text = max => v => {
  if (typeof v !== 'string') return 'must be a string';
  if (!v.trim()) return 'must not be empty';
  if (v.length > max) return `must be at most ${max} characters`;
  if (CONTROL_RE.test(v)) return 'must not contain control characters or line breaks';
  return null;
};
const int = (min, max) => v => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? null : `must be an integer from ${min} to ${max}`);
function url(v) {
  if (typeof v !== 'string' || !v || v.length > 2000) return 'must be an http(s) URL of at most 2000 characters';
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'must be an http(s) URL';
  } catch (_) { return 'must be an http(s) URL'; }
}
function year(v) {
  const ok = ((typeof v === 'number' && Number.isInteger(v)) || typeof v === 'string') && /^\d{4}$/.test(String(v));
  return ok ? null : 'must be a 4-digit year';
}

const FIELD_RULES = Object.freeze({
  domain: { required: true, check: v => (isDomain(v) ? null : 'must be a lowercase domain name') },
  tape: { required: true, check: oneOf(TAPES) },
  construction: { required: true, check: oneOf(CONSTRUCTIONS) },
  constructionDetail: { check: text(120) },
  wordCount: { check: int(0, 50) },
  category: { required: true, check: text(80) },
  buyer: { check: text(120) },
  buyerUrl: { check: url },
  buyerType: { required: true, check: oneOf(BUYER_TYPES) },
  upgradeFrom: { check: text(120) },
  otherExtensionsTaken: { check: int(0, 5000) },
  priorAsk: { check: text(40) },
  priorAskUrl: { check: url },
  registeredYear: { check: year },
  signal: { required: true, check: oneOf(SIGNALS) },
  lesson: { check: text(240) },
});
const FIELD_NAMES = Object.freeze(Object.keys(FIELD_RULES));

/** { ok: true, value } with only the fields present, or { ok: false, domain, reason }. */
function validateInsightRow(row) {
  const domain = row && typeof row === 'object' && typeof row.domain === 'string' ? row.domain : null;
  const fail = reason => ({ ok: false, domain, reason });
  if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('row must be an object');
  for (const key of Object.keys(row)) if (!FIELD_RULES[key]) return fail(`${key}: unknown field`);
  const value = {};
  for (const name of FIELD_NAMES) {
    const rule = FIELD_RULES[name];
    const v = row[name];
    if (v === undefined) {
      if (rule.required) return fail(`${name}: required`);
      continue;
    }
    // Empty optional fields are omitted by the client; a null is off-contract.
    if (v === null) return fail(`${name}: ${rule.required ? 'required' : 'must be omitted when empty, never null'}`);
    const problem = rule.check(v);
    if (problem) return fail(`${name}: ${problem}`);
    value[name] = v;
  }
  if (value.priorAsk !== undefined && value.priorAskUrl === undefined) return fail('priorAskUrl: required with priorAsk (only a price a page printed)');
  if (value.priorAskUrl !== undefined && value.priorAsk === undefined) return fail('priorAsk: required with priorAskUrl');
  return { ok: true, value };
}

/**
 * Validates a POST body. Throws InsightQueryError (400) when the envelope is
 * invalid; otherwise { source, valid: [{ index, value }], rejected: [{ index, domain, reason }] }.
 */
function validateInsightPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InsightQueryError('body must be a JSON object');
  for (const key of Object.keys(body)) if (!['schema', 'source', 'rows'].includes(key)) throw new InsightQueryError(`${key}: unknown field`);
  if (body.schema !== WRITE_SCHEMA) throw new InsightQueryError(`schema: must be ${WRITE_SCHEMA}`);
  const s = body.source;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new InsightQueryError('source: must be an object');
  for (const key of Object.keys(s)) if (!['kind', 'runId', 'model'].includes(key)) throw new InsightQueryError(`source.${key}: unknown field`);
  if (s.kind !== 'agentforge-run') throw new InsightQueryError('source.kind: must be agentforge-run');
  for (const key of ['runId', 'model']) {
    const problem = text(200)(s[key]);
    if (problem) throw new InsightQueryError(`source.${key}: ${problem}`);
  }
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > MAX_WRITE_ROWS) throw new InsightQueryError(`rows: must be an array of 1-${MAX_WRITE_ROWS} rows`);
  const valid = [];
  const rejected = [];
  body.rows.forEach((row, index) => {
    const r = validateInsightRow(row);
    if (r.ok) valid.push({ index, value: r.value });
    else rejected.push({ index, domain: r.domain, reason: r.reason });
  });
  return { source: { kind: s.kind, runId: s.runId, model: s.model }, valid, rejected };
}

// ── schema + writes (writable handle, off the main thread in production) ───
function ensureInsightSchema(db) {
  const run = () => db.exec(SCHEMA_DDL);
  if (db.inTransaction) run();
  else db.transaction(run).immediate();
}

/**
 * Stores validated rows: one history row per accepted write and the current
 * row replaced (latest write wins). A domain that is not a Sale Watch ledger
 * name (no non-excluded stored view row) is rejected, never stored.
 * rows: [{ index, value }]. Returns plain { accepted, rejected, classifiedAt }.
 */
function writeInsights(db, { source, rows, now = null } = {}) {
  ensureInsightSchema(db);
  const member = db.prepare(SQL.ledgerMember);
  const insertHistory = db.prepare(SQL.insertHistory);
  const upsertCurrent = db.prepare(SQL.upsertCurrent);
  const classifiedAt = new Date(now || Date.now()).toISOString();
  const sourceJson = JSON.stringify(source || null);
  const rejected = [];
  let accepted = 0;
  db.transaction(() => {
    for (const { index, value } of rows || []) {
      const hit = member.get({ domain: value.domain });
      if (!hit) { rejected.push({ index, domain: value.domain, reason: 'domain: not a Sale Watch ledger name' }); continue; }
      const params = {
        domain: value.domain, classifiedAt, reportDate: String(hit.report_date || ''),
        tape: value.tape, signal: value.signal, insight: JSON.stringify(value), source: sourceJson,
      };
      const info = insertHistory.run(params);
      upsertCurrent.run({ ...params, historyId: Number(info.lastInsertRowid) });
      accepted += 1;
    }
  }).immediate();
  return { accepted, rejected, classifiedAt };
}

/** History of one domain, newest write first. Plain rows. */
function readInsightHistory(db, domain, { limit = 50 } = {}) {
  if (!insightTableExists(db)) return [];
  return db.prepare(SQL.historyForDomain).all({ domain, limit: Math.max(1, Math.min(500, Math.floor(Number(limit)) || 50)) })
    .map(r => ({ id: r.id, classifiedAt: r.classified_at, insight: JSON.parse(r.insight_json), source: JSON.parse(r.source_json) }));
}

/**
 * Runs writeInsights in a worker thread on its own writable connection to
 * dbPath. Resolves with the plain result; rejects on worker error, early exit
 * or the timeout ceiling (the worker is terminated).
 */
function writeInsightsOffThread(dbPath, payload, { busyTimeoutMs = 30000, timeoutMs = WRITE_TIMEOUT_MS, createWorker = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = { insightsJob: 'write', dbPath, payload, busyTimeoutMs };
    let worker;
    try { worker = createWorker ? createWorker(data) : new Worker(__filename, { workerData: data }); } catch (error) { reject(error); return; }
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      done(reject, new Error(`sale-watch insight write exceeded ${timeoutMs}ms`));
      try { worker.terminate(); } catch (_) { /* ignore */ }
    }, timeoutMs);
    if (timer.unref) timer.unref();
    worker.on('message', m => {
      if (!m) return;
      if (m.type === 'done') done(resolve, m.value);
      else if (m.type === 'error') done(reject, new Error(m.error));
    });
    worker.on('error', error => done(reject, error));
    worker.on('exit', code => done(reject, new Error(`sale-watch insight writer exited (${code}) before finishing`)));
  });
}

function runWorkerJob() {
  const Database = require('better-sqlite3');
  const data = workerData || {};
  let db;
  try {
    db = new Database(data.dbPath);
    db.pragma(`busy_timeout = ${Number(data.busyTimeoutMs) > 0 ? Math.floor(Number(data.busyTimeoutMs)) : 30000}`);
    try { db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); } catch (_) { /* keep the file's journal mode */ }
    if (data.insightsJob !== 'write') throw new Error(`unknown insight job ${data.insightsJob}`);
    const value = writeInsights(db, data.payload || {});
    parentPort.postMessage({ type: 'done', value });
  } catch (error) {
    parentPort.postMessage({ type: 'error', error: String((error && error.message) || error) });
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

// ── reads (read-only lane; plain data only) ────────────────────────────────
function insightTableExists(db) {
  try { return !!db.prepare(SQL.tableExists).get(); } catch (_) { return false; }
}

function lastInsightWrittenAt(db) {
  if (!insightTableExists(db)) return null;
  const row = db.prepare(SQL.lastWritten).get();
  return row && row.at ? row.at : null;
}

/** Current insight per domain: plain object { [domain]: { ...fields, classifiedAt } }. */
function readCurrentInsights(db, domains) {
  const out = {};
  if (!domains.length || !insightTableExists(db)) return out;
  const stmt = db.prepare(SQL.currentForDomains);
  for (let i = 0; i < domains.length; i += 1000) {
    for (const r of stmt.all({ domains: JSON.stringify(domains.slice(i, i + 1000)) })) {
      let value = null;
      try { value = JSON.parse(r.insight_json); } catch (_) { value = null; }
      if (value) out[r.domain] = { ...value, classifiedAt: r.classified_at };
    }
  }
  return out;
}

const windowCache = new Map();

/** [from, to] split into date chunks of READ_CHUNK_DAYS, newest first. */
function windowChunks(from, to, size = READ_CHUNK_DAYS) {
  const out = [];
  let hi = to;
  while (hi >= from) {
    let lo = dayMinus(hi, size - 1);
    if (lo < from) lo = from;
    out.push({ from: lo, to: hi });
    hi = dayMinus(lo, 1);
  }
  return out;
}

/**
 * Ledger names (stored view 'alpha') whose departure day is in [from, to],
 * read through the existing stored-ledger reader. Owner signal policy
 * (zero-weight extensions) is applied as readSaleWatchLedger applies it.
 * { status: 'pending' } before the stored assessment exists.
 */
function readWindowLedger(db, { from, to, q = '', now = null }) {
  const today = isoDay(now);
  const needle = String(q || '').toLowerCase().slice(0, DAILY_Q_MAX).trim();
  const key = `${from}|${to}|${today}|${needle}`;
  const hit = windowCache.get(key);
  if (hit && Date.now() - hit.at < WINDOW_CACHE_MS && !now) return hit.value;
  const store = require('./sale-watch-assessments');
  const { normalizeEntry } = require('./sale-watch');
  const { signalWeight } = require('./domain-signal-policy');
  const entries = [];
  const seen = new Set();
  let truncated = false;
  const readErrors = [];
  const chunks = windowChunks(from, to);
  for (const view of LEDGER_VIEWS) for (const chunk of chunks) {
    // Paged by date range: days puts the cutoff at chunk.from (report_date >=
    // cutoff) and after { date: chunk.to, rank: -1, domain: '' } keeps
    // report_date <= chunk.to (every stored evidence_rank is >= 0).
    const page = store.readStoredLedgerEntries(db, {
      view, q: needle, days: Math.max(1, dayDiff(today, chunk.from)), after: { date: chunk.to, rank: -1, domain: '' }, limit: WINDOW_READ_LIMIT, now: now || undefined,
    });
    if (!page || page.status !== 'ready') return { status: 'pending' };
    if ((page.entries || []).length >= WINDOW_READ_LIMIT) {
      truncated = true;
      readErrors.push({ code: 'WINDOW_READ_LIMIT', view, from: chunk.from, to: chunk.to, rows: page.entries.length, limit: WINDOW_READ_LIMIT, detail: `view '${view}' returned the read limit for ${chunk.from}..${chunk.to}; the window is incomplete` });
    }
    for (const raw of page.entries || []) {
      const entry = normalizeEntry(raw);
      if (!entry || seen.has(entry.domain)) continue;
      const day = String(entry.reportDate || '').slice(0, 10);
      if (!day || day < chunk.from || day > chunk.to) continue;
      if (signalWeight(entry.domain.split('.').at(-1)) === 0) continue;
      seen.add(entry.domain);
      entries.push(entry);
    }
  }
  const value = { status: 'ready', entries, truncated, readErrors };
  if (!now) {
    windowCache.set(key, { at: Date.now(), value });
    while (windowCache.size > 8) windowCache.delete(windowCache.keys().next().value);
  }
  return value;
}

function queuePriority(entry) {
  if (entry.classification === 'likely-sale') return 0;
  if (entry.tier === 'verified' || entry.tier === 'probable') return 1;
  if (entry.tier === 'suspected') return 2;
  return 3;
}
function queueKey(entry) { return { date: String(entry.reportDate || '').slice(0, 10), p: queuePriority(entry), domain: entry.domain }; }
function compareQueue(a, b) {
  return b.date.localeCompare(a.date) || a.p - b.p || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
}
function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(cursor) {
  try {
    const v = JSON.parse(Buffer.from(String(cursor), 'base64url').toString());
    if (!v || typeof v !== 'object' || v.v !== 1) throw new Error('bad');
    return v;
  } catch (_) { throw new InsightQueryError('cursor: invalid page cursor'); }
}

function queueRow(e) {
  return {
    domain: e.domain,
    reportDate: e.reportDate || null,
    tier: e.tier || null,
    classification: e.classification || null,
    venue: e.venue || null,
    sellerNameservers: Array.isArray(e.sellerNameservers) ? e.sellerNameservers.slice() : [],
    buyerNameservers: Array.isArray(e.buyerNameservers) ? e.buyerNameservers.slice() : [],
    buyerTitle: e.buyerTitle || null,
    buyerUrl: e.buyerUrl || null,
    registrar: (e.discovery && e.discovery.rdap && e.discovery.rdap.registrar) || null,
    signals: Array.isArray(e.assessment && e.assessment.signals) ? e.assessment.signals.slice() : [],
  };
}

/** Parses ?days&limit&cursor; throws InsightQueryError on anything off-contract. */
function normalizeQueueQuery(query = {}) {
  const intParam = (name, min, max, fallback) => {
    const raw = query[name];
    if (raw === undefined || raw === '') return fallback;
    if (typeof raw !== 'string' && typeof raw !== 'number') throw new InsightQueryError(`${name}: must be an integer from ${min} to ${max}`);
    if (!/^\d+$/.test(String(raw)) || Number(raw) < min || Number(raw) > max) throw new InsightQueryError(`${name}: must be an integer from ${min} to ${max}`);
    return Number(raw);
  };
  const days = intParam('days', 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
  const limit = intParam('limit', 1, MAX_QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT);
  const cursor = query.cursor ? String(query.cursor).slice(0, 1024) : null;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c.days !== days) throw new InsightQueryError('cursor: minted for a different days window');
  }
  return { days, limit, cursor };
}

/**
 * Pending queue: ledger names in the past `days` days with no current
 * insight, newest reportDate first, likely-sale before suspected, then domain.
 */
function readPendingQueue(db, { days = DEFAULT_WINDOW_DAYS, limit = DEFAULT_QUEUE_LIMIT, cursor = null, now = null } = {}) {
  const today = isoDay(now);
  const from = dayMinus(today, days - 1);
  const ledger = readWindowLedger(db, { from, to: today, now });
  if (ledger.status !== 'ready') return { schema: QUEUE_SCHEMA, status: 'pending', rows: [], pagination: { nextCursor: null, totalPending: null } };
  const current = readCurrentInsights(db, ledger.entries.map(e => e.domain));
  const pending = ledger.entries.filter(e => !current[e.domain]).map(e => ({ e, k: queueKey(e) })).sort((a, b) => compareQueue(a.k, b.k));
  let start = 0;
  if (cursor) {
    const c = decodeCursor(cursor);
    const after = { date: String(c.date || ''), p: Number(c.p) || 0, domain: String(c.domain || '') };
    start = pending.findIndex(x => compareQueue(x.k, after) > 0);
    if (start < 0) start = pending.length;
  }
  const page = pending.slice(start, start + limit);
  const more = start + limit < pending.length;
  const last = page.at(-1);
  return {
    schema: QUEUE_SCHEMA,
    rows: page.map(x => queueRow(x.e)),
    pagination: {
      nextCursor: more && last ? encodeCursor({ v: 1, days, date: last.k.date, p: last.k.p, domain: last.k.domain }) : null,
      totalPending: pending.length,
    },
    window: { from, to: today, truncated: ledger.truncated },
  };
}

/** Parses ?from&to&tape&q&cursor for the daily route; throws InsightQueryError. */
function normalizeDailyQuery(query = {}, { now = null } = {}) {
  const today = isoDay(now);
  let windowDays = DEFAULT_WINDOW_DAYS;
  if (query.window !== undefined && query.window !== '') {
    if (!/^\d+$/.test(String(query.window)) || !DAILY_WINDOWS.includes(Number(query.window))) throw new InsightQueryError(`window: must be one of ${DAILY_WINDOWS.join(', ')}`);
    windowDays = Number(query.window);
  }
  const to = query.to === undefined || query.to === '' ? today : query.to;
  if (!validDay(to)) throw new InsightQueryError('to: must be a YYYY-MM-DD date');
  const from = query.from === undefined || query.from === '' ? dayMinus(to, windowDays - 1) : query.from;
  if (!validDay(from)) throw new InsightQueryError('from: must be a YYYY-MM-DD date');
  if (from > to) throw new InsightQueryError('from: must not be after to');
  if (dayDiff(to, from) + 1 > DAILY_MAX_WINDOW_DAYS) throw new InsightQueryError(`from/to: window must be at most ${DAILY_MAX_WINDOW_DAYS} days`);
  const tape = query.tape === undefined || query.tape === '' ? 'all' : query.tape;
  if (!DAILY_TAPES.includes(tape)) throw new InsightQueryError(`tape: must be one of ${DAILY_TAPES.join(', ')}`);
  const rawQ = query.q === undefined ? '' : query.q;
  if (typeof rawQ !== 'string') throw new InsightQueryError('q: must be a string');
  if (rawQ.length > DAILY_Q_MAX) throw new InsightQueryError(`q: must be at most ${DAILY_Q_MAX} characters`);
  if (CONTROL_RE.test(rawQ)) throw new InsightQueryError('q: must not contain control characters');
  const q = rawQ.trim().toLowerCase();
  const cursor = query.cursor ? String(query.cursor).slice(0, 1024) : null;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c.from !== from || c.to !== to || c.tape !== tape || String(c.q || '') !== q || !validDay(c.day)) throw new InsightQueryError('cursor: minted for a different query');
    if (c.offset !== undefined && (!Number.isInteger(c.offset) || c.offset < 0 || c.offset > WINDOW_READ_LIMIT * 3)) throw new InsightQueryError('cursor: invalid day offset');
  }
  return { from, to, tape, q, cursor };
}

function breakdown(rows, keyOf, label) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, BREAKDOWN_MAX)
    .map(([k, n]) => ({ [label]: k, n }));
}

function breakdowns(rows) {
  // Derived fields (every row); stored insights are optional enrichment.
  const classified = rows.filter(r => r.insight);
  return {
    byVenue: breakdown(rows, r => r.derived.venue || 'not public', 'venue'),
    byTape: breakdown(rows, r => r.derived.tape, 'tape'),
    byExtension: breakdown(rows, r => r.derived.extension, 'extension'),
    byLengthBand: breakdown(rows, r => r.derived.lengthBand, 'lengthBand'),
    byHomepage: breakdown(rows, r => r.derived.homepageState, 'homepageState'),
    byTier: breakdown(rows, r => r.derived.tier, 'tier'),
    bySoldReason: breakdown(rows, r => r.derived.soldReason, 'soldReason'),
    byRegisteredYear: breakdown(rows, r => r.derived.registeredYearBand, 'registeredYearBand'),
    byOtherExtensions: breakdown(rows, r => r.derived.otherExtensionsBand, 'otherExtensionsBand'),
    byConstruction: breakdown(classified, r => r.insight.construction, 'construction'),
    byCategory: breakdown(classified, r => r.insight.category, 'category'),
    byBuyerType: breakdown(classified, r => r.insight.buyerType, 'buyerType'),
  };
}

// Words that are selling: over the SOLD rows given, each segmented word counted
// once per name (derived.words, built with the snapshot), names that do not
// segment under 'invented', plus adjacent two-word pairs.
const WORDS_WINDOW_MAX = 60;
const WORD_PAIRS_MAX = 20;
const WORDS_DAY_MAX = 10;
function soldWords(rows, maxWords, maxPairs) {
  const words = new Map();
  const pairs = new Map();
  // The split of the sold names: made of words, invented, with a known affix (once per name).
  const split = { madeOfWords: 0, invented: 0, withAffix: 0 };
  for (const r of rows) {
    if (!isSoldRow(r)) continue;
    const d = r.derived || {};
    if (d.invented === true) split.invented += 1; else if ((d.words || []).length) split.madeOfWords += 1;
    if (d.affix) split.withAffix += 1;
    if (d.invented === true) words.set('invented', (words.get('invented') || 0) + 1);
    for (const w of new Set(d.words || [])) words.set(w, (words.get(w) || 0) + 1);
    for (const p of new Set(d.wordPairs || [])) pairs.set(p, (pairs.get(p) || 0) + 1);
  }
  const top = (m, key, max) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max).map(([k, n]) => ({ [key]: k, n }));
  const out = { byWord: top(words, 'word', maxWords), wordSplit: split };
  if (maxPairs) out.byWordPair = top(pairs, 'wordPair', maxPairs);
  return out;
}

function tapeCounts(rows) {
  // The tapes are counted separately and never summed.
  const counts = { aftermarket: 0, builder: 0, noise: 0 };
  for (const r of rows) if (counts[r.derived.tape] !== undefined) counts[r.derived.tape] += 1;
  return counts;
}

const isSold = r => r.derived.probablySold === true;
// SOLD (owner definition, server/sale-watch-derive.js soldReason).
const isSoldRow = r => r.derived.sold === true;
function reasonCounts(rows) {
  const { SOLD_REASONS } = require('./sale-watch-derive');
  const out = {};
  for (const k of SOLD_REASONS) out[k] = 0;
  for (const r of rows) if (r.derived.soldReason && out[r.derived.soldReason] !== undefined) out[r.derived.soldReason] += 1;
  return out;
}
function soldByDay(rows) {
  const out = {};
  for (const r of rows) if (isSoldRow(r)) { const d = String(r.reportDate || '').slice(0, 10); out[d] = (out[d] || 0) + 1; }
  return out;
}

// Per-classification counts the feed names: probably sold (likely-sale),
// transfer completed, transfer in progress, and candidates (everything else).
function classCounts(rows) {
  const out = { likelySale: 0, transferCompleted: 0, transferInProgress: 0, candidate: 0 };
  for (const r of rows) {
    const c = r.classification || (r.derived && r.derived.classification);
    if (c === 'likely-sale') out.likelySale += 1;
    else if (c === 'transfer-completed') out.transferCompleted += 1;
    else if (c === 'transfer-in-progress') out.transferInProgress += 1;
    else out.candidate += 1;
  }
  return out;
}

// Within a day: probably sold (likely-sale) first, then evidence strength
// (the stored evidence rank), then shorter names, then domain.
// Feed order within a day by classification: likely-sale, transfer-completed,
// transfer-in-progress, then candidates (acquisition-candidate and the rest).
const FEED_CLASS_ORDER = Object.freeze(['likely-sale', 'transfer-completed', 'transfer-in-progress']);
// Sold rows first by reason strength (SOLD_REASONS order), then candidates
// by classification (likely-sale, transfer-completed, transfer-in-progress, rest).
function feedClassRank(r) {
  const { SOLD_REASONS } = require('./sale-watch-derive');
  const why = r.derived && r.derived.soldReason;
  const s = why ? SOLD_REASONS.indexOf(why) : -1;
  if (s >= 0) return s;
  const i = FEED_CLASS_ORDER.indexOf(r.classification || (r.derived && r.derived.classification));
  return SOLD_REASONS.length + (i === -1 ? FEED_CLASS_ORDER.length : i);
}
function compareFeedRows(a, b) {
  // A search ranks name matches first, then theme, site title, site text (matchRank 0..3).
  return ((a.matchRank || 0) - (b.matchRank || 0)) || (feedClassRank(a) - feedClassRank(b)) || (a.evidenceRank - b.evidenceRank)
    || (a.domain.length - b.domain.length) || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
}

/** Whole-window summary: counts per tape and the same breakdowns as a day, per tape. */
function windowSummary(allRows, { from, to, tape, truncated }) {
  const perTape = { aftermarket: [], builder: [], noise: [] };
  for (const r of allRows) if (perTape[r.derived.tape]) perTape[r.derived.tape].push(r);
  const tapes = {};
  for (const t of TAPES) tapes[t] = { names: perTape[t].length, probable: perTape[t].filter(isSold).length, sold: perTape[t].filter(isSoldRow).length, soldReasons: reasonCounts(perTape[t]), soldByDay: soldByDay(perTape[t]), classes: classCounts(perTape[t]), ...breakdowns(perTape[t]) };
  const shown = tape === 'all' ? allRows : perTape[tape];
  const words = soldWords(shown, WORDS_WINDOW_MAX, WORD_PAIRS_MAX);
  return { from, to, tape, names: allRows.length, counts: tapeCounts(allRows), probable: tapeCounts(allRows.filter(isSold)), sold: tapeCounts(allRows.filter(isSoldRow)), soldReasons: reasonCounts(shown), soldByDay: soldByDay(shown), classes: classCounts(shown), truncated, ...breakdowns(shown), ...words, soldOnly: { ...breakdowns(shown.filter(isSoldRow)), ...words }, tapes };
}

/** Share of window rows with a known registration date from stored evidence. */
function registrationKnown(rows) {
  return { n: rows.filter(r => r.derived && r.derived.registeredDate).length, of: rows.length };
}

/** Venues the venue table does not know; their rows are on the noise tape. */
function unknownVenues(rows) {
  return breakdown(rows.filter(r => r.derived.tape === 'noise' && r.derived.venue && r.derived.venueKnown === false), r => r.derived.venue, 'venue');
}

/**
 * Day-by-day ledger with each name's current insight. Days newest first; rows
 * in a day probably-sold first, then by evidence strength. counts and probable
 * carry the three tapes separately; the breakdowns cover the tape shown. The
 * first page (no cursor) carries window: the whole from..to summary per tape.
 */
function readDailyRows(db, { from, to, q = '', now = null } = {}) {
  const ledger = readWindowLedger(db, { from, to, q, now });
  if (ledger.status !== 'ready') return { status: 'pending' };
  const current = readCurrentInsights(db, ledger.entries.map(e => e.domain));
  const { deriveRow, nameWords } = require('./sale-watch-derive');
  const { evidenceRank } = require('./sale-watch-evidence');
  // Slimmed here, in the read lane: the fat ledger entry (discovery,
  // reconstruction, assessment) never leaves this process.
  const rows = ledger.entries.map(entry => slimRow({ ...entry, derived: { ...deriveRow(entry), ...nameWords(entry.domain) }, insight: current[entry.domain] || null, evidenceRank: evidenceRank(entry) }));
  return { status: 'ready', rows, truncated: !!ledger.truncated, readErrors: ledger.readErrors || [], insightsWrittenAt: lastInsightWrittenAt(db) };
}

/**
 * Pure page assembly over already-derived window rows (no database). Used by
 * readDaily and by the in-memory snapshot route so both answer identically.
 */
function assembleDaily(base, { from, to, tape = 'all', q = '', cursor = null } = {}) {
  const inTape = r => tape === 'all' || r.derived.tape === tape;
  const byDay = new Map();
  const allRows = [];
  for (const row of base.rows || []) {
    const day = String(row.reportDate).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
    allRows.push(row);
  }
  for (const rows of byDay.values()) rows.sort(compareFeedRows);
  const dayKeys = [...byDay.keys()].sort().reverse();
  const start = cursor ? decodeCursor(cursor) : null;
  const startDay = start ? start.day : null;
  const startOffset = start && Number.isInteger(start.offset) && start.offset > 0 ? start.offset : 0;
  const days = [];
  let shown = 0;
  let nextCursor = null;
  for (const day of dayKeys) {
    if (startDay && day > startDay) continue;
    if (shown >= DAILY_PAGE_ROWS) { nextCursor = encodeCursor({ v: 1, from, to, tape, q, day, offset: 0 }); break; }
    const rows = byDay.get(day);
    const visible = rows.filter(inTape);
    // A page never exceeds DAILY_PAGE_ROWS: a long day is paged by the feed
    // order and continues on the next page (continued: true). The day's counts
    // and breakdowns always cover the whole day, not the rows loaded.
    const offset = day === startDay ? startOffset : 0;
    const take = visible.slice(offset, offset + (DAILY_PAGE_ROWS - shown));
    shown += take.length;
    days.push({ day, continued: offset > 0, counts: tapeCounts(rows), probable: tapeCounts(rows.filter(isSold)), sold: tapeCounts(rows.filter(isSoldRow)), soldReasons: reasonCounts(visible), classes: classCounts(rows.filter(inTape)), ...breakdowns(visible), ...soldWords(visible, WORDS_DAY_MAX, 0), soldOnly: { ...breakdowns(visible.filter(isSoldRow)), ...soldWords(visible, WORDS_DAY_MAX, 0) }, rows: take });
    if (offset + take.length < visible.length) { nextCursor = encodeCursor({ v: 1, from, to, tape, q, day, offset: offset + take.length }); break; }
  }
  const out = {
    schema: DAILY_SCHEMA,
    from, to, tape, q,
    insights: { lastWrittenAt: base.insightsWrittenAt || null },
    diagnostics: { unknownVenues: unknownVenues(allRows), windowReadErrors: base.readErrors || [], registrationKnown: registrationKnown(allRows) },
    days,
    pagination: { nextCursor },
  };
  if (!cursor) out.window = windowSummary(allRows, { from, to, tape, truncated: !!base.truncated });
  return out;
}

function readDaily(db, { from, to, tape = 'all', q = '', cursor = null, now = null } = {}) {
  const base = readDailyRows(db, { from, to, q, now });
  if (base.status !== 'ready') return { schema: DAILY_SCHEMA, status: 'pending', days: [], pagination: { nextCursor: null } };
  return assembleDaily(base, { from, to, tape, q, cursor });
}

// ── slim feed row (2026-11-12 production OOM) ─────────────────────────────
// The snapshot (memory and file) and every daily page carry only what the
// collapsed row, the day/window breakdowns, the filters, the words and the
// search need. The evidence an expanded row shows (signals, counter-evidence,
// rationale, registrar/transfer facts, nameservers, timeline) is read on
// demand by primary key (readDailyEvidence, GET /api/sale-watch/daily/evidence).
const SLIM_TITLE_MAX = 120;
const SLIM_TEXT_MAX = 200;
const SLIM_SITE_WORDS = 24;
// Derived fields kept even when false (the sold/probably-sold tests read them as booleans).
const SLIM_KEEP_FALSE = Object.freeze(['sold', 'probablySold']);
// Repeated at row level (classification, tier) or only needed while building (segments, venueClass).
const SLIM_DROP_DERIVED = Object.freeze(['classification', 'tier', 'segments', 'venueClass']);
const EVIDENCE_KEYS = Object.freeze(['discovery', 'reconstruction', 'assessment', 'rationale', 'sellerNameservers', 'buyerNameservers', 'timeline']);
function capText(v, max) { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t ? t.slice(0, max) : null; }
function slimRow(row) {
  const { timeline: _timeline, ...full } = row.derived || {};
  const derived = {};
  for (const [k, v] of Object.entries(full)) {
    if (SLIM_DROP_DERIVED.includes(k)) continue;
    if (v === null || v === undefined || (v === false && !SLIM_KEEP_FALSE.includes(k)) || (Array.isArray(v) && !v.length)) continue;
    derived[k] = v;
  }
  // A known venue is the common case; only an unknown venue (diagnostics) is marked.
  if (derived.venueKnown === true) delete derived.venueKnown;
  else if (full.venue && full.venueKnown === false) derived.venueKnown = false;
  if (derived.buyerTitle) derived.buyerTitle = capText(derived.buyerTitle, SLIM_TITLE_MAX);
  if (derived.buyerUrl === `https://${row.domain}/`) delete derived.buyerUrl;
  const hp = (row.discovery && row.discovery.homepage) || {};
  const ok = !hp.error;
  let search = null;
  try {
    const doc = require('./sale-watch-search').buildSearchDocument(row.domain, row);
    search = { name: doc.name, site: String(doc.site || '').split(' ').slice(0, SLIM_SITE_WORDS).join(' '), theme: doc.theme, themeTerms: doc.themeTerms, kit: doc.kit, junk: doc.junk };
  } catch (_) { search = null; }
  const out = { domain: row.domain, reportDate: row.reportDate || null, classification: row.classification || null, tier: row.tier || null, evidenceRank: row.evidenceRank, derived, insight: row.insight || null, search,
    buyerTitle: capText(row.buyerTitle, SLIM_TITLE_MAX), siteTitle: ok ? capText(hp.title, SLIM_TITLE_MAX) : null,
    siteText: ok ? capText([hp.description, hp.brandText, hp.textSample].filter(Boolean).join(' '), SLIM_TEXT_MAX) : null };
  return out;
}

const EVIDENCE_SCHEMA = 'domainscout.sale-watch-daily-evidence/v1';
const EVIDENCE_SQL = Object.freeze({
  candidate: 'SELECT domain, state, next_probe_at, first_seen_day, updated_at, probe_count, outcome_tier, exit_observed_day, evidence_json FROM sale_watch_candidates WHERE domain = @domain',
  assessment: 'SELECT tier, classification, report_date, rationale, assessment_json, transfer_json FROM sale_watch_assessments WHERE domain = @domain',
  observations: 'SELECT observed_at, kind, evidence_json FROM sale_watch_observations WHERE domain = @domain ORDER BY observed_at DESC LIMIT 8',
});
const parseJsonSafe = (v, d) => { if (v == null) return d; try { return JSON.parse(v); } catch (_) { return d; } };
/** Expanded-row evidence for one domain, three primary-key reads. { found: false } when unknown. */
function readDailyEvidence(db, { domain } = {}) {
  if (!isDomain(domain)) throw new InsightQueryError('domain: must be a lowercase domain name');
  const c = db.prepare(EVIDENCE_SQL.candidate).get({ domain });
  if (!c) return { schema: EVIDENCE_SCHEMA, domain, found: false, evidence: null };
  const a = db.prepare(EVIDENCE_SQL.assessment).get({ domain }) || {};
  const ev = parseJsonSafe(c.evidence_json, {}) || {};
  const base = require('./sale-watch-assessments').candidateEntry(c, ev);
  const transfer = parseJsonSafe(a.transfer_json, null);
  const assessment = parseJsonSafe(a.assessment_json, null) || {};
  const obs = db.prepare(EVIDENCE_SQL.observations).all({ domain }).reverse().map(o => ({ at: o.observed_at, kind: o.kind, ...(parseJsonSafe(o.evidence_json, {}) || {}) }));
  const d = base.discovery || {};
  const rdap = d.rdap || {};
  const mv = d.movement || null;
  const list = v => (Array.isArray(v) ? v.map(String) : []);
  return { schema: EVIDENCE_SCHEMA, domain, found: true, evidence: {
    domain, classification: a.classification || null, reportDate: a.report_date || base.reportDate || null, rationale: a.rationale || base.rationale || '',
    assessment: { basis: assessment.basis || null, signals: list(assessment.signals), counterEvidence: list(assessment.counterEvidence), transfer: { transferAt: (assessment.transfer && assessment.transfer.transferAt) || null } },
    sellerNameservers: list(base.sellerNameservers), buyerNameservers: list(base.buyerNameservers),
    discovery: { movement: mv ? { prevDay: mv.prevDay || null, day: mv.day || null, previousProvider: mv.previousProvider || null } : null,
      rdap: { registrar: rdap.registrar || null, statuses: list(rdap.statuses), lastChangedAt: rdap.lastChangedAt || null, checkedAt: rdap.checkedAt || null },
      transferEvidence: transfer },
    reconstruction: { nextProbeAt: c.next_probe_at || null, observations: obs.map(o => ({ at: o.at || null, kind: o.kind || null, prevDay: o.prevDay || null, day: o.day || null,
      previousNameservers: list(o.previousNameservers), currentNameservers: list(o.currentNameservers), registrar: o.registrar || null,
      rdap: { statuses: list(o.rdap && o.rdap.statuses) }, homepage: { finalUrl: (o.homepage && o.homepage.finalUrl) || null }, classification: o.classification || null, tier: o.tier || null })) },
    lastObservedAt: base.lastObservedAt || null, observationCount: base.observationCount, observationStatus: base.observationStatus || null,
    buyerUrl: base.buyerUrl || null, buyerTitle: base.buyerTitle || null, buyer: base.buyer || null, sourceUrl: base.sourceUrl || null,
  } };
}

// ── snapshot ───────────────────────────────────────────────────────────────
const SNAPSHOT_SCHEMA = 'domainscout.sale-watch-daily-snapshot/v1';

/**
 * The complete default window (every row with derived fields and insight),
 * built in the Sale Watch read lane by the background producer only. The
 * ledgerVersion is a digest of the rows it was built from.
 */
function buildDailySnapshot(db, { now = null, days = DEFAULT_WINDOW_DAYS } = {}) {
  const windowDays = Number(days);
  if (!DAILY_WINDOWS.includes(windowDays)) throw new InsightQueryError(`days: must be one of ${DAILY_WINDOWS.join(', ')}`);
  const started = Date.now();
  const { from, to } = normalizeDailyQuery({ window: String(windowDays) }, { now });
  const base = readDailyRows(db, { from, to, q: '', now });
  if (base.status !== 'ready') return { schema: SNAPSHOT_SCHEMA, status: 'pending' };
  const hash = require('crypto').createHash('sha256');
  for (const r of base.rows) hash.update(`${r.domain}|${r.reportDate}|${r.classification || ''}|${r.tier || ''}|${r.derived.tape}|${r.derived.soldReason || ''}\n`);
  return { schema: SNAPSHOT_SCHEMA, status: 'ready', generatedAt: new Date(now || Date.now()).toISOString(), ledgerVersion: hash.digest('hex').slice(0, 16), windowDays, from, to, ...base, buildMs: Date.now() - started };
}

// In-memory name search over snapshot rows, with the database path's rule
// (sale-watch-assessments.viewSearchMatches): the row's search document
// matches q (sale-watch-search.matchDocument), or q is longer than 3
// characters and is a substring of the domain. Documents are built once per
// snapshot (kept beside the rows, never in the response).
function snapshotSearchDocs(snapshot) {
  if (snapshot._searchDocs) return snapshot._searchDocs;
  const search = require('./sale-watch-search');
  const docs = new Map();
  for (const r of snapshot.rows || []) { if (r.search) { docs.set(r.domain, r.search); continue; } try { docs.set(r.domain, search.buildSearchDocument(r.domain, r)); } catch (_) { docs.set(r.domain, null); } }
  Object.defineProperty(snapshot, '_searchDocs', { value: docs, enumerable: false, configurable: true });
  return docs;
}
function snapshotRowMatches(row, needle, docs = null) {
  if (!needle) return true;
  if (needle.length > 3 && String(row.domain).includes(needle)) return true;
  const search = require('./sale-watch-search');
  const doc = docs ? docs.get(row.domain) : (row.search || search.buildSearchDocument(row.domain, row));
  return !!(doc && search.matchDocument(doc, needle, row.domain));
}

/** Answers a normalized daily query from a snapshot, with no database access. */
// Search relevance over snapshot rows: a match is labelled and ranked
//   0 name       a segmented name word (derived.words / search-document name
//                terms), or, for terms longer than 3 characters, a label
//                prefix or suffix
//   1 theme      the search document's theme tag (sale-watch-search)
//   2 site title a whole word of the buyer / homepage title
//   3 site text  a whole word of the homepage description or page text
// Every query word must match (inflections only for words longer than 3
// characters). A term of 3 characters or fewer never matches inside a longer
// word: "ai" does not match chair.com or "chairs" in page text.
const SHORT_Q_MAX = 3;
const MATCH_KEYS = Object.freeze(['name', 'theme', 'site title', 'site text']);
function textWords(text) { return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []; }
function wordForms(w) {
  if (w.length <= SHORT_Q_MAX) return new Set([w]);
  const f = new Set([w, `${w}s`, `${w}es`, `${w}ed`, `${w}ing`]);
  if (w.endsWith('e')) { f.add(`${w}d`); f.add(`${w.slice(0, -1)}ing`); }
  if (/[^aeiou]y$/.test(w)) { f.add(`${w.slice(0, -1)}ies`); f.add(`${w.slice(0, -1)}ied`); }
  return f;
}
function snapshotMatch(row, needle, docs = null) {
  const qw = [...new Set(textWords(needle))];
  if (!qw.length) return null;
  const forms = qw.map(wordForms);
  const has = list => { const s = new Set(list); return forms.every(f => [...f].some(x => s.has(x))); };
  const d = row.derived || {};
  const label = String(row.domain || '').toLowerCase().split('.')[0] || '';
  const flat = qw.join('');
  const doc = docs ? docs.get(row.domain) : null;
  const nameTerms = [...(d.words || []), ...String((doc && doc.name) || '').split(' ').filter(Boolean)];
  const hit = (rank, term) => ({ matchedOn: MATCH_KEYS[rank], matchedTerm: term || needle, matchRank: rank });
  if (label === flat || has(nameTerms) || (flat.length > SHORT_Q_MAX && (label.startsWith(flat) || label.endsWith(flat)))) return hit(0);
  if (doc) {
    try {
      const m = require('./sale-watch-search').matchDocument(doc, needle, row.domain);
      if (m && m.matchedOn === 'theme') return hit(1, m.matchedTerm);
    } catch (_) { /* no theme */ }
  }
  // Slim rows carry siteTitle/siteText; older fat rows still read discovery.homepage.
  const slim = row.siteTitle !== undefined || row.siteText !== undefined;
  const hp = (row.discovery && row.discovery.homepage) || {};
  const ok = !hp.error;
  const title = slim ? row.siteTitle : (ok ? hp.title : '');
  const body = slim ? row.siteText : (ok ? [hp.description, hp.brandText, hp.textSample].join(' ') : '');
  if (has(textWords([d.buyerTitle, row.buyerTitle, title].join(' ')))) return hit(2);
  if (body && has(textWords(body))) return hit(3);
  return null;
}

function serveDailyFromSnapshot(snapshot, { from, to, tape = 'all', q = '', cursor = null, explicitWindow = false } = {}) {
  const win = explicitWindow ? { from, to } : { from: snapshot.from, to: snapshot.to };
  if (cursor) { const c = decodeCursor(cursor); win.from = c.from; win.to = c.to; }
  const needle = String(q || '').toLowerCase().trim();
  const docs = needle ? snapshotSearchDocs(snapshot) : null;
  const rows = [];
  const counts = [0, 0, 0, 0];
  for (const r of snapshot.rows || []) {
    const d = String(r.reportDate || '').slice(0, 10);
    if (d < win.from || d > win.to) continue;
    if (!needle) { rows.push(r); continue; }
    const m = snapshotMatch(r, needle, docs);
    if (!m) continue;
    rows.push({ ...r, ...m });
    if (tape === 'all' || (r.derived && r.derived.tape === tape)) counts[m.matchRank] += 1;
  }
  const page = assembleDaily({ ...snapshot, rows }, { ...win, tape, q: needle, cursor });
  if (needle) page.matchCounts = { name: counts[0], theme: counts[1], siteTitle: counts[2], siteText: counts[3], site: counts[2] + counts[3] };
  page.generatedAt = snapshot.generatedAt;
  page.ledgerVersion = snapshot.ledgerVersion;
  page.source = 'snapshot';
  return page;
}

// ── routes ─────────────────────────────────────────────────────────────────
const LIVE_BUCKET_MS = 30000;
const EVIDENCE_CACHE_MAX = 256;
const EVIDENCE_CACHE_MS = 5 * 60 * 1000;

function isPendingReadError(error) {
  if (!error) return false;
  if (error.code === 'DB_READ_LANE_BUSY' || error.code === 'SALE_WATCH_MIGRATION_PENDING') return true;
  return /db-read-worker-(timeout|retired)|Analysis is busy/i.test(String(error.message || error));
}

/**
 * Registers GET /api/sale-watch/insights/pending, GET /api/sale-watch/daily
 * and POST /api/sale-watch/insights. options.insightQueueLoader(query),
 * options.insightDailyLoader(query) run the reads in the Sale Watch read
 * lane; options.insightWriter({ source, rows }) runs the write off-main.
 */
function registerSaleWatchInsightRoutes(app, options = {}) {
  let generation = 0;
  // Busts the read lane's per-params cache after a write and every 30 s, so
  // new insights and ledger days reach the screen without a reload.
  const live = () => `${generation}:${Math.floor(Date.now() / LIVE_BUCKET_MS)}`;
  const unavailable = (res, schema, error) => {
    if (error instanceof InsightQueryError) return res.status(error.status || 400).json({ schema, error: 'Invalid Sale Watch insight request', detail: error.message });
    if (isPendingReadError(error)) {
      res.set('Retry-After', '5');
      return res.status(503).json({ schema, status: 'pending', error: 'Sale Watch insights are temporarily busy', detail: String(error.message || error), retryAfterMs: 5000 });
    }
    return res.status(503).json({ schema, error: 'Sale Watch insights are temporarily unavailable', detail: String((error && error.message) || error) });
  };
  const pendingReply = (res, schema) => {
    res.set('Retry-After', '5');
    return res.status(202).json({ schema, status: 'pending', detail: 'Stored Sale Watch ledger is being built; retry shortly', retryAfterMs: 5000 });
  };

  app.get('/api/sale-watch/insights/pending', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const query = normalizeQueueQuery(req.query || {});
      if (typeof options.insightQueueLoader !== 'function') throw new Error('Sale Watch insights are not configured on this deployment');
      const value = await options.insightQueueLoader({ ...query, live: live() });
      if (!value || typeof value !== 'object') throw new Error('Sale Watch insight queue returned nothing');
      if (value.status === 'pending') return pendingReply(res, QUEUE_SCHEMA);
      res.json(value);
    } catch (error) { unavailable(res, QUEUE_SCHEMA, error); }
  });

  app.get('/api/sale-watch/daily', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      // Snapshot serving (default): answered from main-process memory only,
      // never the database. Only before any snapshot ever existed is it 503 pending.
      if (options.dailySnapshot && typeof options.dailySnapshot.serve === 'function') {
        const page = options.dailySnapshot.serve(req.query || {});
        if (page && page.status === 'pending') { res.set('Retry-After', '5'); return res.status(503).json({ ...page, retryAfterMs: 5000 }); }
        if (page) return res.json(page);
      }
      const query = normalizeDailyQuery(req.query || {});
      if (typeof options.insightDailyLoader !== 'function') throw new Error('Sale Watch insights are not configured on this deployment');
      const value = await options.insightDailyLoader({ ...query, live: live() });
      if (!value || typeof value !== 'object') throw new Error('Sale Watch daily read returned nothing');
      if (value.status === 'pending') return pendingReply(res, DAILY_SCHEMA);
      res.json(value);
    } catch (error) { unavailable(res, DAILY_SCHEMA, error); }
  });

  // Expanded-row evidence, on demand: one primary-key read in the Sale Watch
  // read lane (options.dailyEvidenceLoader({ domain })), cached in a small LRU.
  const evidenceCache = new Map();
  app.get('/api/sale-watch/daily/evidence', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const domain = String((req.query && req.query.domain) || '').trim().toLowerCase();
      if (!isDomain(domain)) throw new InsightQueryError('domain: must be a lowercase domain name');
      const hit = evidenceCache.get(domain);
      if (hit && Date.now() - hit.at < EVIDENCE_CACHE_MS) { evidenceCache.delete(domain); evidenceCache.set(domain, hit); return res.json(hit.value); }
      if (typeof options.dailyEvidenceLoader !== 'function') throw new Error('Sale Watch evidence is not configured on this deployment');
      const value = await options.dailyEvidenceLoader({ domain });
      if (!value || typeof value !== 'object') throw new Error('Sale Watch evidence read returned nothing');
      if (!value.found) return res.status(404).json({ schema: EVIDENCE_SCHEMA, domain, found: false, error: 'No stored evidence for this name' });
      evidenceCache.set(domain, { at: Date.now(), value });
      while (evidenceCache.size > EVIDENCE_CACHE_MAX) evidenceCache.delete(evidenceCache.keys().next().value);
      res.json(value);
    } catch (error) { unavailable(res, EVIDENCE_SCHEMA, error); }
  });

  if (typeof app.post !== 'function') return;
  const parse = require('express').json({ limit: '1mb' });
  const parseBody = (req, res, next) => parse(req, res, err => (err
    ? res.status(err.status || 400).json({ schema: WRITE_SCHEMA, accepted: 0, rejected: [], error: 'Invalid JSON body', detail: err.message })
    : next()));
  app.post('/api/sale-watch/insights', parseBody, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    // Every reply keeps the { accepted, rejected: [{ domain, reason }] } shape.
    const rowsOf = () => (req.body && Array.isArray(req.body.rows) ? req.body.rows.slice(0, MAX_WRITE_ROWS) : []);
    const allRejected = reason => rowsOf().map(r => ({ domain: r && typeof r === 'object' && typeof r.domain === 'string' ? r.domain : null, reason }));
    let checked;
    try { checked = validateInsightPayload(req.body); } catch (error) {
      const reason = String((error && error.message) || error);
      return res.status(400).json({ schema: WRITE_SCHEMA, accepted: 0, rejected: allRejected(reason), error: 'Invalid Sale Watch insight request', detail: reason });
    }
    try {
      let written = { accepted: 0, rejected: [] };
      if (checked.valid.length) {
        if (typeof options.insightWriter !== 'function') throw new Error('Sale Watch insights are not configured on this deployment');
        written = await options.insightWriter({ source: checked.source, rows: checked.valid });
        if (!written || typeof written !== 'object') throw new Error('Sale Watch insight writer returned nothing');
        if (written.accepted > 0) generation += 1;
      }
      const rejected = [...checked.rejected, ...(written.rejected || [])].sort((a, b) => a.index - b.index)
        .map(r => ({ domain: r.domain, reason: r.reason }));
      res.json({ accepted: Number(written.accepted) || 0, rejected });
    } catch (error) {
      const detail = String((error && error.message) || error);
      if (isPendingReadError(error)) res.set('Retry-After', '5');
      res.status(503).json({ schema: WRITE_SCHEMA, accepted: 0, rejected: [], error: 'Sale Watch insights are temporarily unavailable; retry the same rows', detail, retryAfterMs: 5000 });
    }
  });
}

if (!isMainThread && workerData && workerData.insightsJob && parentPort) runWorkerJob();

module.exports = {
  QUEUE_SCHEMA, WRITE_SCHEMA, DAILY_SCHEMA, TABLE, HISTORY_TABLE, LEDGER_VIEW, LEDGER_VIEWS,
  TAPES, DAILY_TAPES, CONSTRUCTIONS, BUYER_TYPES, SIGNALS, MAX_WRITE_ROWS, DAILY_PAGE_ROWS, WINDOW_READ_LIMIT,
  DAILY_WINDOWS, DAILY_MAX_WINDOW_DAYS, READ_CHUNK_DAYS, windowChunks, soldWords, WORDS_WINDOW_MAX, WORD_PAIRS_MAX, WORDS_DAY_MAX,
  SQL, SCHEMA_DDL, InsightQueryError,
  validateInsightRow, validateInsightPayload, normalizeQueueQuery, normalizeDailyQuery,
  ensureInsightSchema, writeInsights, writeInsightsOffThread, readInsightHistory,
  insightTableExists, lastInsightWrittenAt, readCurrentInsights, readWindowLedger,
  readPendingQueue, readDaily, readDailyRows, slimRow, readDailyEvidence, EVIDENCE_SQL, EVIDENCE_SCHEMA, EVIDENCE_KEYS, EVIDENCE_CACHE_MAX, assembleDaily, buildDailySnapshot, serveDailyFromSnapshot, snapshotRowMatches, SNAPSHOT_SCHEMA, compareFeedRows, windowSummary, registerSaleWatchInsightRoutes,
  WORKER_FILE: path.resolve(__filename),
  _clearWindowCache: () => windowCache.clear(),
};
