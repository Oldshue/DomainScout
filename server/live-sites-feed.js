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
 *   ?limit=1..100 (default 50) &cursor=<opaque> &q=<text> &zone=<tld>
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
const MAX_LIMIT = 100;
const MAX_Q = 100;

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

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

function queryDigest(q, zone) {
  return crypto.createHash('sha1').update(`${q}\u0000${zone}`).digest('hex').slice(0, 12);
}

function parseQuery(query = {}) {
  const one = value => (Array.isArray(value) ? value[0] : value);
  let limit = DEFAULT_LIMIT;
  const rawLimit = one(query.limit);
  if (rawLimit !== undefined && rawLimit !== '') {
    if (!/^\d+$/.test(String(rawLimit))) throw requestError('limit must be an integer from 1 to 100');
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) throw requestError('limit must be an integer from 1 to 100');
  }
  const q = String(one(query.q) ?? '').trim().toLowerCase();
  if (q.length > MAX_Q) throw requestError(`q may not exceed ${MAX_Q} characters`);
  const zone = String(one(query.zone) ?? '').trim().toLowerCase();
  if (zone && !ZONE_PATTERN.test(zone)) throw requestError('zone must be an extension without the dot');
  const rawCursor = one(query.cursor);
  const cursor = rawCursor !== undefined && rawCursor !== '' ? decodeCursor(rawCursor) : null;
  const digest = queryDigest(q, zone);
  if (cursor && cursor.h !== digest) throw requestError('cursor does not belong to this query');
  return { limit, q, zone, cursor, digest };
}

function createLiveSitesFeed({ universeDir, maxDays = 14, cacheDays = 20 } = {}) {
  if (!universeDir) throw new Error('universeDir is required');
  const cache = new Map(); // day -> { size, mtimeMs, items }

  async function loadDay(day) {
    const file = path.join(universeDir, day, 'sites', 'observations.jsonl');
    let stat;
    try { stat = await fsp.stat(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const cached = cache.get(day);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      cache.delete(day); cache.set(day, cached);
      return cached.items;
    }
    const text = await fsp.readFile(file, 'utf8');
    const items = [];
    const seen = new Set();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!isPublishable(record) || seen.has(record.domain)) continue;
      seen.add(record.domain);
      items.push(publicItem({ ...record, day }));
    }
    items.sort((a, b) => a.domain.localeCompare(b.domain));
    cache.set(day, { size: stat.size, mtimeMs: stat.mtimeMs, items });
    while (cache.size > cacheDays) cache.delete(cache.keys().next().value);
    return items;
  }

  /** Days (newest first) whose site observation completed. */
  async function listDays() {
    let entries;
    try { entries = await fsp.readdir(universeDir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const days = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !DAY_PATTERN.test(entry.name)) continue;
      try {
        const summary = JSON.parse(await fsp.readFile(path.join(universeDir, entry.name, 'sites', 'summary.json'), 'utf8'));
        if (summary?.status === 'complete') days.push(entry.name);
      } catch { /* missing or unreadable summary: not a published day */ }
    }
    return days.sort((a, b) => b.localeCompare(a)).slice(0, maxDays);
  }

  async function query(rawQuery = {}) {
    const { limit, q, zone, cursor, digest } = parseQuery(rawQuery);
    const days = await listDays();
    const matches = item => (!zone || item.zone === zone)
      && (!q || item.domain.includes(q) || item.title.toLowerCase().includes(q));
    const items = [];
    let last = null;
    let more = false;
    for (const day of days) {
      if (cursor && day > cursor.d) continue;
      const dayItems = (await loadDay(day)) || [];
      for (const item of dayItems) {
        if (cursor && day === cursor.d && item.domain <= cursor.k) continue;
        if (!matches(item)) continue;
        if (items.length >= limit) { more = true; break; }
        items.push(item);
        last = item;
      }
      if (more) break;
    }
    return { items, nextCursor: more && last ? encodeCursor({ d: last.day, k: last.domain, h: digest }) : null, days };
  }

  return { query, listDays };
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
