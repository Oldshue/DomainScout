'use strict';

/**
 * Public read-only live-sites feed: GET /api/public/live-sites.
 *
 * Reads <universeDir>/<day>/sites/observations.jsonl written by the
 * live-sites stage (server/live-sites.js) and serves ONLY built, non-kit,
 * non-spam observations with a real title, newest day first. Each item
 * exposes exactly { domain, zone, day, title, description, url, observedAt };
 * nameservers, providers, classes, reasons and every other DomainScout field
 * stay internal.
 *
 * Contract (FrontierUpdate builds against it):
 *   ?limit=1..1000 (default 50) &cursor=<opaque> &q=<text> &zone=<tld>
 *   200 { items, nextCursor|null, days }
 *   errors: non-200 { error }
 *
 * No authentication (server/index.js admits exactly this path), CORS *,
 * short public cache, per-client rate limit.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { fork } = require('node:child_process');
const { publicItem, isPublishable, validProjection } = require('./live-sites-public-projection');

const PATH = '/api/public/live-sites';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_Q = 100;
const MAX_ZONES = 50;
const SNIPPET_CHARS = 160;
const PUBLIC_STORE_WORKER = path.join(__dirname, 'live-sites-public-read-worker.js');

/** ~SNIPPET_CHARS of `text` centred on [at, at+len), with ellipses where cut. */
function makeSnippet(text, at, len) {
  const source = String(text || '');
  if (!source) return null;
  const start = Math.max(0, Math.min(at, source.length) - Math.floor((SNIPPET_CHARS - len) / 2));
  const end = Math.min(source.length, start + SNIPPET_CHARS);
  let value = source.slice(start, end).trim();
  if (start > 0) value = `…${value}`;
  if (end < source.length) value = `${value}…`;
  return value;
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const KIT_TITLE_REPEAT = 8;

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(raw) {
  try {
    const value = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || !DAY_PATTERN.test(String(value.d || '')) || typeof value.k !== 'string' || typeof value.h !== 'string'
      || !(value.o === null || (typeof value.o === 'number' && Number.isFinite(value.o)))) throw new Error('shape');
    return value;
  } catch { throw requestError('cursor is invalid'); }
}

/** observedAt as epoch ms, or null when absent/unparseable. */
function observedMs(item) {
  if (!item || !item.observedAt) return null;
  const ms = Date.parse(item.observedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Within-day order: newest observedAt first, rows without observedAt after
 * rows with it, then domain ascending (code-unit order) as the total-order
 * tiebreak. a/b are { o: ms|null, k: domain }.
 */
function compareKeys(a, b) {
  if (a.o !== b.o) {
    if (a.o === null) return 1;
    if (b.o === null) return -1;
    return b.o - a.o;
  }
  return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
}

function itemKey(item) { return { o: observedMs(item), k: item.domain }; }

const WINDOWS = { '1d': 1, '2d': 2, '7d': 7 };
const DEFAULT_WINDOW = '2d';

function queryDigest(q, zone, windowDays, exclude = '') {
  return crypto.createHash('sha1').update(`${q}\u0000${zone}\u0000${windowDays}${exclude ? `\u0000${exclude}` : ''}`).digest('hex').slice(0, 12);
}

function parseQuery(query = {}) {
  const one = value => (Array.isArray(value) ? value[0] : value);
  let limit = DEFAULT_LIMIT;
  const rawLimit = one(query.limit);
  if (rawLimit !== undefined && rawLimit !== '') {
    if (!/^\d+$/.test(String(rawLimit))) throw requestError('limit must be an integer from 1 to 1000');
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) throw requestError('limit must be an integer from 1 to 1000');
  }
  const q = String(one(query.q) ?? '').trim().toLowerCase();
  if (q.length > MAX_Q) throw requestError(`q may not exceed ${MAX_Q} characters`);
  const exclude = String(one(query.exclude) ?? '').trim().toLowerCase();
  if (exclude.length > MAX_Q) throw requestError(`exclude may not exceed ${MAX_Q} characters`);
  const zone = String(one(query.zone) ?? '').trim().toLowerCase();
  if (zone && !ZONE_PATTERN.test(zone)) throw requestError('zone must be an extension without the dot');
  const windowKey = String(one(query.window) ?? '').trim().toLowerCase() || DEFAULT_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(WINDOWS, windowKey)) throw requestError('window must be 1d, 2d or 7d');
  const windowDays = WINDOWS[windowKey];
  const rawCursor = one(query.cursor);
  const cursor = rawCursor !== undefined && rawCursor !== '' ? decodeCursor(rawCursor) : null;
  const digest = queryDigest(q, zone, windowDays, exclude);
  if (cursor && cursor.h !== digest) throw requestError('cursor does not belong to this query');
  return { limit, q, exclude, zone, cursor, digest, windowDays };
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

async function readJsonSafe(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

const CT_JOURNAL = 'ct-launches.jsonl';

function createPublicStoreReader({ universeDir, deadlineMs = 12_000, maxQueue = 32 } = {}) {
  let child = null, nextId = 1, active = null;
  const queue = [], coalesced = new Map();
  const spawn = () => {
    if (child?.connected) return child;
    const worker = fork(PUBLIC_STORE_WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=256'] });
    child = worker;
    worker.on('message', reply => {
      if (!active || reply?.id !== active.id) return;
      const current = active; active = null; clearTimeout(current.timer);
      coalesced.delete(current.key);
      settle(current, reply.ok ? null : requestError(reply.error || 'public feed reader failed', 503), reply.value);
      dispatch();
    });
    worker.on('exit', () => {
      if (child === worker) child = null;
      if (active?.worker === worker) {
        const current = active; active = null; clearTimeout(current.timer); coalesced.delete(current.key);
        settle(current, requestError('public feed reader exited', 503));
      }
      dispatch();
    });
    worker.on('error', () => {});
    return worker;
  };
  const settle = (entry, error, value) => {
    for (const consumer of entry.consumers) {
      consumer.cleanup?.();
      error ? consumer.reject(error) : consumer.resolve(value);
    }
    entry.consumers.clear();
  };
  const dispatch = () => {
    if (active || !queue.length) return;
    active = queue.shift();
    const worker = spawn();
    active.worker = worker;
    active.timer = setTimeout(() => {
      const current = active; active = null; coalesced.delete(current.key);
      settle(current, requestError('public feed read exceeded its deadline', 503));
      worker.kill('SIGTERM');
    }, deadlineMs);
    active.timer.unref?.();
    worker.send({ type: 'query', id: active.id, payload: active.payload });
  };
  return {
    query(payload, signal = null) {
      const key = JSON.stringify(payload);
      let entry = coalesced.get(key);
      if (!entry) {
        if (queue.length >= maxQueue) return Promise.reject(requestError('public feed reader is busy', 503));
        entry = { id: nextId++, key, payload: { ...payload, universeDir }, consumers: new Set(), timer: null, worker: null };
        coalesced.set(key, entry); queue.push(entry);
      }
      const promise = new Promise((resolve, reject) => {
        const consumer = { resolve, reject, cleanup: null };
        const cancel = () => {
          if (!entry.consumers.delete(consumer)) return;
          const error = new Error('public feed request cancelled'); error.name = 'AbortError'; reject(error);
          if (entry.consumers.size) return;
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          if (active === entry) {
            active = null; clearTimeout(entry.timer);
            if (child === entry.worker) child = null;
            entry.worker?.kill('SIGTERM');
          }
          coalesced.delete(key); dispatch();
        };
        consumer.cleanup = () => signal?.removeEventListener('abort', cancel);
        entry.consumers.add(consumer);
        if (signal) { if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); }
      });
      dispatch(); return promise;
    },
    status: () => ({ active: active ? 1 : 0, queued: queue.length, coalesced: coalesced.size, workerPid: child?.pid || null }),
    close() { child?.kill('SIGTERM'); child = null; },
  };
}

function createLiveSitesFeed({ universeDir, healthPath = null, maxDays = 14, cacheDays = WINDOWS['7d'], liveStatus = null, publicStore = null, projectionRepair = null } = {}) {
  if (!universeDir) throw new Error('universeDir is required');
  const cache = new Map(); // day -> { size, mtimeMs, items }
  const pendingDays = new Map();
  const stats = { loads: 0, haystacks: 0, bytesRead: 0 };

  /**
   * Per-day stage progress (newest first), derived from the small summary.json,
   * the tape's presence and the health file. Never reads the journal or
   * observations, is bounded to maxDays and never throws.
   */
  async function progress() {
    try {
      let entries;
      try { entries = await fsp.readdir(universeDir, { withFileTypes: true }); } catch { return []; }
      const dayNames = entries.filter(e => e.isDirectory() && DAY_PATTERN.test(e.name)).map(e => e.name)
        .sort((a, b) => b.localeCompare(a));
      const health = healthPath ? await readJsonSafe(healthPath) : null;
      const failures = health && typeof health.failures === 'object' && health.failures ? health.failures : {};
      const rows = [];
      for (const day of dayNames) {
        if (rows.length >= maxDays) break;
        const summary = await readJsonSafe(path.join(universeDir, day, 'sites', 'summary.json'));
        const failure = Object.prototype.hasOwnProperty.call(failures, day) ? failures[day] : null;
        let hasTape = false;
        if (!summary && !failure) {
          try { await fsp.stat(path.join(universeDir, day, 'ns', 'movement.jsonl')); hasTape = true; } catch { /* no tape */ }
        }
        if (!summary && !failure && !hasTape) continue;
        const state = summary && typeof summary.status === 'string' ? summary.status : null;
        let status;
        if (state === 'complete') status = 'complete';
        else if (failure || state === 'interrupted' || state === 'failed') status = 'failed';
        else if (state === 'running') status = 'running';
        else status = 'queued';
        const observed = count(summary?.observed);
        const total = Math.max(count(summary?.total), status === 'complete' ? observed : 0);
        // error/timeout outcomes (class 'error'): final counts once complete, running count before.
        const errors = summary?.counts && summary.counts.error !== undefined ? count(summary.counts.error) : count(summary?.errorsObserved);
        rows.push({
          day,
          status,
          checked: total ? Math.min(observed, total) : observed,
          total,
          kept: status === 'complete' ? count(summary?.built?.publishable) : 0,
          errors,
          updatedAt: (status === 'failed' && failure?.at) || summary?.finishedAt || summary?.updatedAt || failure?.at || null,
        });
      }
      return rows;
    } catch { return []; }
  }

  function loadDay(day, search = false) {
    const key = `${day}:${search ? 'search' : 'compact'}`;
    if (pendingDays.has(key)) return pendingDays.get(key);
    const pending = readDay(day, search).finally(() => pendingDays.delete(key));
    pendingDays.set(key, pending);
    return pending;
  }

  async function readDay(day, search = false) {
    const sitesDir = path.join(universeDir, day, 'sites');
    // The final file exists once the day completes; until then the resume
    // journal (observations.partial.jsonl) holds the rows checked so far.
    // The near-live CT detector appends to its own ct-launches.jsonl (its only
    // writer), which is merged after the daily stage's rows (daily rows win).
    const statOrNull = async file => {
      try { return await fsp.stat(file); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const files = [];
    let file = path.join(sitesDir, 'observations.jsonl');
    let stat = await statOrNull(file);
    if (!stat) { file = path.join(sitesDir, 'observations.partial.jsonl'); stat = await statOrNull(file); }
    if (stat) {
      const projected = !search && path.basename(file) === 'observations.jsonl' ? await validProjection(file, stat) : null;
      files.push(projected ? [projected.projection, projected.stat, true, stat] : [file, stat, false, stat]);
    }
    const ctFile = path.join(sitesDir, CT_JOURNAL);
    const ctStat = await statOrNull(ctFile);
    if (ctStat) files.push([ctFile, ctStat, false, ctStat]);
    if (!files.length) return null;
    const signature = files.map(([f, s, projected, raw]) => `${f}:${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${projected ? `${raw.size}:${raw.mtimeMs}` : ''}`).join('|');
    // A raw load already carries body text and can satisfy both landing and
    // search requests. Keep a distinct compact entry only when an immutable
    // projection actually avoided the private source.
    const cacheKey = `${day}:${files.some(([, , projected]) => projected) ? 'compact' : 'raw'}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.signature === signature) {
      cache.delete(cacheKey); cache.set(cacheKey, cached);
      return cached.entries;
    }
    stats.loads += 1;
    // Each entry keeps the compact public projection and exact optional body text.
    // The larger lowercase body projection is built only if a search needs it.
    const items = [];
    const seen = new Set();
    const sources = new Map();
    for (const [name, stat, projected] of files) {
      const previous = cached?.sources?.get(name);
      // Appends reuse the parsed public rows. Replacement, truncation, or an
      // in-place same-size rewrite invalidates the source; final replaces partial.
      const reusable = previous && previous.ino === stat.ino && previous.dev === stat.dev
        && stat.size >= previous.size
        && (stat.size > previous.size || stat.mtimeMs === previous.mtimeMs);
      const source = reusable ? previous : { offset: 0, entries: new Map() };
      Object.assign(source, { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs });
      let processed = 0;
      const consume = line => {
        let record;
        try { record = JSON.parse(line); } catch { return; }
        if ((!projected && !isPublishable(record)) || source.entries.has(record.domain)) return;
        const item = projected ? record : publicItem({ ...record, day });
        const text = !projected && typeof record.text === 'string' && record.text ? record.text : null;
        source.entries.set(record.domain, {
          item,
          base: `${item.domain}\n${item.title}\n${item.description || ''}`.toLowerCase(),
          // The default public page never searches body text. Retain the exact
          // text for snippets, but build its lowercase search projection only
          // if a q/exclude request actually needs it.
          text, textLower: undefined,
        });
      };
      if (stat.size > source.offset) {
        const input = fs.createReadStream(name, { start: source.offset, end: stat.size - 1 });
        let pending = Buffer.alloc(0);
        try {
          for await (const chunk of input) {
            stats.bytesRead += chunk.length;
            const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            let start = 0, end;
            while ((end = buffer.indexOf(10, start)) !== -1) {
              consume(buffer.subarray(start, end).toString('utf8'));
              source.offset += end - start + 1;
              start = end + 1;
              if (++processed % 1000 === 0) await new Promise(resolve => setImmediate(resolve));
            }
            pending = Buffer.from(buffer.subarray(start));
          }
          // Growing journals may end mid-record. Leave that tail unconsumed so
          // the next append can complete it, including split UTF-8 characters.
          if (pending.length && (path.basename(name) === 'observations.jsonl' || projected)) {
            consume(pending.toString('utf8')); source.offset += pending.length;
          }
        } finally { input.destroy(); }
      }
      sources.set(name, source);
      for (const entry of source.entries.values()) {
        if (seen.has(entry.item.domain)) continue;
        seen.add(entry.item.domain); items.push(entry);
      }
    }
    // A day still being observed has not had its end-of-day kit pass yet:
    // drop any title repeated KIT_TITLE_REPEAT+ times among its rows so far.
    const titleCounts = new Map();
    for (const entry of items) {
      const key = entry.item.title.trim().toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
    }
    const entries = items.filter(entry => titleCounts.get(entry.item.title.trim().toLowerCase()) < KIT_TITLE_REPEAT);
    entries.sort((a, b) => compareKeys(itemKey(a.item), itemKey(b.item)));
    cache.set(cacheKey, { signature, sources, entries });
    while (new Set([...cache.keys()].map(key => key.split(':')[0])).size > cacheDays) {
      const oldestDay = cache.keys().next().value.split(':')[0];
      for (const key of [...cache.keys()]) if (key.startsWith(`${oldestDay}:`)) cache.delete(key);
    }
    return entries;
  }

  /** Days (newest first) with site observations on disk, complete or still running. */
  async function listDays() {
    let entries;
    try { entries = await fsp.readdir(universeDir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const days = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !DAY_PATTERN.test(entry.name)) continue;
      const sitesDir = path.join(universeDir, entry.name, 'sites');
      const summary = await readJsonSafe(path.join(sitesDir, 'summary.json'));
      let observed = false;
      for (const name of ['observations.jsonl', 'observations.partial.jsonl', CT_JOURNAL]) {
        try { await fsp.access(path.join(sitesDir, name)); observed = true; break; } catch { /* not present */ }
      }
      if (summary?.status === 'complete' || observed) days.push(entry.name);
    }
    return days.sort((a, b) => b.localeCompare(a)).slice(0, maxDays);
  }

  async function query(rawQuery = {}, { signal = null } = {}) {
    const { limit, q, exclude, zone, cursor, digest, windowDays } = parseQuery(rawQuery);
    const days = await listDays();
    const windowed = days.slice(0, windowDays);
    if (publicStore) {
      const value = await publicStore.query({ days: windowed, q, exclude, zone, cursor, limit }, signal);
      if (value.missing && !value.sourceStatus.length) {
        projectionRepair?.({ reason: 'missing' });
        throw requestError('public feed projection is preparing', 503);
      }
      const last = value.last;
      let live = null;
      if (liveStatus) { try { live = await liveStatus(); } catch { live = { status: 'unknown', lastLaunchAt: null, launchesLastHour: 0, warmingUp: false }; } }
      const refreshing = value.missing || value.sourceStatus.some(day => day.freshness.some(source => !source.currentIdentity || source.verifiedBytes < source.sourceBytes));
      if (refreshing) projectionRepair?.({ reason: 'catch-up' });
      const verifiedAt = value.sourceStatus.flatMap(day => day.freshness.map(source => source.updatedAt)).filter(Boolean).sort().at(0) || null;
      return { items: value.items, nextCursor: value.more && last ? encodeCursor({ d: last.day, o: observedMs(last), k: last.domain, h: digest }) : null, total: value.total, zones: value.zones, days, progress: await progress(), projection: { status: refreshing ? 'refreshing' : 'verified', verifiedAt }, ...(live ? { live } : {}) };
    }
    // Domain, title and description match first; the stored page text (absent on
    // older rows) matches only otherwise and then carries a snippet.
    const textLower = entry => {
      if (entry.textLower === undefined) {
        entry.textLower = entry.text ? entry.text.toLowerCase() : '';
        stats.haystacks += 1;
      }
      return entry.textLower;
    };
    const matchQ = entry => {
      let at = -1;
      if (q && !entry.base.includes(q)) {
        const body = textLower(entry);
        at = body ? body.indexOf(q) : -1;
        if (at === -1) return null;
      }
      // Only scan exclusions for positive matches; reuse the existing text index.
      if (exclude && (entry.base.includes(exclude) || textLower(entry).includes(exclude))) return null;
      return at === -1 ? entry.item : { ...entry.item, snippet: makeSnippet(entry.text, at, q.length) };
    };
    const zoneCounts = new Map();
    const items = [];
    let last = null;
    let more = false;
    let total = 0;
    // A CT observation and a later daily-tape observation can put the same
    // domain in different source days. The newest source-day record owns the
    // identity across this window, including when its title no longer matches
    // a query. Deduplicate before matching, counting and applying the cursor so
    // an older name/description cannot resurface or inflate totals on later pages.
    const seenDomains = new Set();
    for (const day of windowed) {
      const dayEntries = (await loadDay(day, !!(q || exclude))) || [];
      const dayQ = [];
      for (const entry of dayEntries) {
        if (seenDomains.has(entry.item.domain)) continue;
        seenDomains.add(entry.item.domain);
        const hit = matchQ(entry);
        if (hit) dayQ.push(hit);
      }
      for (const item of dayQ) zoneCounts.set(item.zone, (zoneCounts.get(item.zone) || 0) + 1);
      const dayMatches = zone ? dayQ.filter(item => item.zone === zone) : dayQ;
      total += dayMatches.length;
      if (cursor && day > cursor.d) continue;
      for (const item of dayMatches) {
        // Resume strictly after the cursor's (observedAt, domain) position, so rows
        // appended meanwhile (newer ones sort before it) never shift or repeat a page.
        if (cursor && day === cursor.d && compareKeys(itemKey(item), { o: cursor.o, k: cursor.k }) <= 0) continue;
        if (more) break;
        if (items.length >= limit) { more = true; break; }
        items.push(item);
        last = item;
      }
    }
    const zones = [...zoneCounts].map(([z, n]) => ({ zone: z, count: n }))
      .sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone)).slice(0, MAX_ZONES);
    let live = null;
    if (liveStatus) { try { live = await liveStatus(); } catch { live = { status: 'unknown', lastLaunchAt: null, launchesLastHour: 0, warmingUp: false }; } }
    return { items, nextCursor: more && last ? encodeCursor({ d: last.day, o: observedMs(last), k: last.domain, h: digest }) : null, total, zones, days, progress: await progress(), ...(live ? { live } : {}) };
  }

  return {
    query, listDays, progress,
    cacheStats: () => ({ ...stats, days: new Set([...cache.keys()].map(key => key.split(':')[0])).size }),
  };
}

/** Fixed-window per-client limiter with a bounded client table. */
function createRateLimiter({ windowMs = 60000, max = 120, maxClients = 50000, now = () => Date.now() } = {}) {
  const clients = new Map();
  return function take(key) {
    const t = now();
    let entry = clients.get(key);
    if (!entry || t - entry.start >= windowMs) {
      if (!entry && clients.size >= maxClients) {
        for (const [k, v] of clients) { if (t - v.start >= windowMs) clients.delete(k); }
        if (clients.size >= maxClients) clients.delete(clients.keys().next().value);
      }
      entry = { start: t, count: 0 };
      clients.delete(key);
      clients.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= max, remaining: Math.max(0, max - entry.count), retryAfterSeconds: Math.max(1, Math.ceil((entry.start + windowMs - t) / 1000)) };
  };
}

function clientKey(req) {
  // X-Real-IP is overwritten by Railway's edge with the connecting client's address.
  // X-Forwarded-For is caller-suppliable and must never be read for this decision.
  const realIp = String(req.headers?.['x-real-ip'] || '').trim();
  return realIp || String(req.socket?.remoteAddress || 'unknown');
}

function registerLiveSitesFeedRoutes(app, feed, { env = process.env, limiter, maxAgeSeconds } = {}) {
  const max = Number(env.DOMAINSCOUT_LIVE_SITES_RATE_LIMIT) > 0 ? Math.trunc(Number(env.DOMAINSCOUT_LIVE_SITES_RATE_LIMIT)) : 120;
  const take = limiter || createRateLimiter({ windowMs: 60000, max });
  const maxAge = Number.isFinite(maxAgeSeconds) ? maxAgeSeconds : 60;
  const cors = res => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Vary', 'Accept-Encoding');
  };
  app.options(PATH, (req, res) => { cors(res); res.set('Access-Control-Max-Age', '600'); res.status(204).end(); });
  app.get(PATH, async (req, res) => {
    cors(res);
    const verdict = take(clientKey(req));
    if (!verdict.allowed) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    try {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      req.once?.('aborted', cancel);
      res.once?.('close', () => { if (!res.writableEnded) cancel(); });
      const body = await feed.query(req.query || {}, { signal: controller.signal });
      res.set('Cache-Control', `public, max-age=${maxAge}`);
      return res.status(200).json(body);
    } catch (error) {
      const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
      res.set('Cache-Control', 'no-store');
      if (status === 503) console.error(`[LiveSitesFeed] read failed: ${error.message}`);
      return res.status(status).json({ error: status === 503 ? 'live sites feed unavailable' : error.message });
    }
  });
}

module.exports = { PATH, SNIPPET_CHARS, createLiveSitesFeed, createPublicStoreReader, createRateLimiter, registerLiveSitesFeedRoutes, parseQuery, isPublishable, publicItem, makeSnippet, clientKey };
