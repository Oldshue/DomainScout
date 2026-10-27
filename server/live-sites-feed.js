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
const path = require('path');

const PATH = '/api/public/live-sites';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_Q = 100;
const MAX_ZONES = 50;

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const KIT_TITLE_REPEAT = 8;

function publicItem(record) {
  const domain = String(record.domain);
  let url = record.finalUrl || record.url || `https://${domain}/`;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) url = `https://${domain}/`;
  } catch { url = `https://${domain}/`; }
  return {
    domain,
    zone: domain.slice(domain.lastIndexOf('.') + 1),
    day: record.day,
    title: String(record.title),
    description: record.description ? String(record.description) : null,
    url,
    observedAt: record.observedAt || null,
  };
}

function isPublishable(record) {
  return !!record && record.class === 'built' && !record.kit && !record.spam && record.titleReal === true
    && typeof record.title === 'string' && record.title.trim().length > 0 && typeof record.domain === 'string';
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(raw) {
  try {
    const value = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || !DAY_PATTERN.test(String(value.d || '')) || typeof value.k !== 'string' || typeof value.h !== 'string') throw new Error('shape');
    return value;
  } catch { throw requestError('cursor is invalid'); }
}

const WINDOWS = { '1d': 1, '2d': 2, '7d': 7 };
const DEFAULT_WINDOW = '2d';

function queryDigest(q, zone, windowDays) {
  return crypto.createHash('sha1').update(`${q}\u0000${zone}\u0000${windowDays}`).digest('hex').slice(0, 12);
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
  const zone = String(one(query.zone) ?? '').trim().toLowerCase();
  if (zone && !ZONE_PATTERN.test(zone)) throw requestError('zone must be an extension without the dot');
  const windowKey = String(one(query.window) ?? '').trim().toLowerCase() || DEFAULT_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(WINDOWS, windowKey)) throw requestError('window must be 1d, 2d or 7d');
  const windowDays = WINDOWS[windowKey];
  const rawCursor = one(query.cursor);
  const cursor = rawCursor !== undefined && rawCursor !== '' ? decodeCursor(rawCursor) : null;
  const digest = queryDigest(q, zone, windowDays);
  if (cursor && cursor.h !== digest) throw requestError('cursor does not belong to this query');
  return { limit, q, zone, cursor, digest, windowDays };
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

async function readJsonSafe(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

const CT_JOURNAL = 'ct-launches.jsonl';

function createLiveSitesFeed({ universeDir, healthPath = null, maxDays = 14, cacheDays = 20, liveStatus = null } = {}) {
  if (!universeDir) throw new Error('universeDir is required');
  const cache = new Map(); // day -> { size, mtimeMs, items }

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

  async function loadDay(day) {
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
    if (stat) files.push([file, stat]);
    const ctFile = path.join(sitesDir, CT_JOURNAL);
    const ctStat = await statOrNull(ctFile);
    if (ctStat) files.push([ctFile, ctStat]);
    if (!files.length) return null;
    const signature = files.map(([f, s]) => `${f}:${s.size}:${s.mtimeMs}`).join('|');
    const cached = cache.get(day);
    if (cached && cached.signature === signature) {
      cache.delete(day); cache.set(day, cached);
      return cached.items;
    }
    const items = [];
    const seen = new Set();
    let readAny = false;
    for (const [name] of files) {
      let text;
      try { text = await fsp.readFile(name, 'utf8'); readAny = true; }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; } // torn last line of a growing journal
        if (!isPublishable(record) || seen.has(record.domain)) continue;
        seen.add(record.domain);
        items.push(publicItem({ ...record, day }));
      }
    }
    if (!readAny) return null;
    // A day still being observed has not had its end-of-day kit pass yet:
    // drop any title repeated KIT_TITLE_REPEAT+ times among its rows so far.
    const titleCounts = new Map();
    for (const item of items) {
      const key = item.title.trim().toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
    }
    const kept = items.filter(item => titleCounts.get(item.title.trim().toLowerCase()) < KIT_TITLE_REPEAT);
    items.length = 0;
    items.push(...kept);
    items.sort((a, b) => a.domain.localeCompare(b.domain));
    cache.set(day, { signature, items });
    while (cache.size > cacheDays) cache.delete(cache.keys().next().value);
    return items;
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

  async function query(rawQuery = {}) {
    const { limit, q, zone, cursor, digest, windowDays } = parseQuery(rawQuery);
    const days = await listDays();
    const windowed = days.slice(0, windowDays);
    const matchesQ = item => !q || item.domain.includes(q) || item.title.toLowerCase().includes(q);
    const zoneCounts = new Map();
    const items = [];
    let last = null;
    let more = false;
    let total = 0;
    for (const day of windowed) {
      const dayItems = (await loadDay(day)) || [];
      const dayQ = dayItems.filter(matchesQ);
      for (const item of dayQ) zoneCounts.set(item.zone, (zoneCounts.get(item.zone) || 0) + 1);
      const dayMatches = zone ? dayQ.filter(item => item.zone === zone) : dayQ;
      total += dayMatches.length;
      if (cursor && day > cursor.d) continue;
      for (const item of dayMatches) {
        if (cursor && day === cursor.d && item.domain <= cursor.k) continue;
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
    return { items, nextCursor: more && last ? encodeCursor({ d: last.day, k: last.domain, h: digest }) : null, total, zones, days, progress: await progress(), ...(live ? { live } : {}) };
  }

  return { query, listDays, progress };
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
      const body = await feed.query(req.query || {});
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

module.exports = { PATH, createLiveSitesFeed, createRateLimiter, registerLiveSitesFeedRoutes, parseQuery, isPublishable, publicItem };
