'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IMPORT_BYTES = 300 * 1024 * 1024;

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function zoneOf(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

function validDay(day) {
  const value = String(day || '');
  if (!DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function tokenMatches(actual, expected) {
  const digest = value => crypto.createHash('sha256').update(String(value || '')).digest();
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}

function seededRandom(seedText) {
  let state = 2166136261;
  for (const character of seedText) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function createUniverseLane(options = {}) {
  const directory = options.directory || options.dir || process.env.DOMAINSCOUT_UNIVERSE_DIR
    || path.join(os.homedir(), 'DomainScout', 'universe', 'work');
  const statCache = new Map();
  const dayCache = new Map();
  const nsDayCache = new Map();

  function tapePath(day, file) {
    if (!DAY_PATTERN.test(String(day || ''))) throw requestError(`Unknown universe day: ${day || ''}`, 404);
    return path.join(directory, day, 'tape', file);
  }

  function nsPath(day, file) {
    if (!DAY_PATTERN.test(String(day || ''))) throw requestError(`Unknown universe day: ${day || ''}`, 404);
    return path.join(directory, day, 'ns', file);
  }

  async function inspectDay(day) {
    const addsPath = tapePath(day, 'adds.tsv');
    const stat = await fsp.stat(addsPath);
    const cached = statCache.get(day);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
    const text = await fsp.readFile(addsPath, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const zoneNames = new Set();
    for (const line of lines) {
      const fields = line.split('\t');
      if (fields[1]) zoneNames.add(fields[1].toLowerCase().replace(/^\./, ''));
    }
    try {
      const raw = JSON.parse(await fsp.readFile(tapePath(day, 'zones.json'), 'utf8'));
      const zones = Array.isArray(raw) ? raw : Array.isArray(raw?.zones) ? raw.zones : Object.keys(raw || {});
      for (const zone of zones) zoneNames.add(String(zone?.zone || zone).toLowerCase().replace(/^\./, ''));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const value = { day, adds: lines.length, zones: zoneNames.size };
    statCache.set(day, { size: stat.size, mtimeMs: stat.mtimeMs, value });
    return value;
  }

  async function hasNsMovementDay(day) {
    try { await fsp.access(path.join(directory, day, 'ns', 'summary.json'), fs.constants.R_OK); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  }

  async function listDays() {
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const days = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !DAY_PATTERN.test(entry.name)) continue;
      try {
        const info = await inspectDay(entry.name);
        const nsMovement = await hasNsMovementDay(entry.name);
        days.push({ ...info, nsMovement });
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return days.sort((left, right) => left.day.localeCompare(right.day));
  }

  async function resolveDay(day) {
    if (day) {
      try { await fsp.access(tapePath(day, 'adds.tsv'), fs.constants.R_OK); return day; }
      catch (error) {
        if (error.statusCode) throw error;
        if (error.code === 'ENOENT') throw requestError(`Unknown universe day: ${day}`, 404);
        throw error;
      }
    }
    const days = await listDays();
    if (!days.length) throw requestError('No universe days are available', 404);
    return days.at(-1).day;
  }

  async function loadDay(requestedDay) {
    const day = await resolveDay(requestedDay);
    if (dayCache.has(day)) {
      const cached = dayCache.get(day);
      dayCache.delete(day);
      dayCache.set(day, cached);
      return cached;
    }
    const text = await fsp.readFile(tapePath(day, 'adds.tsv'), 'utf8');
    const names = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const [label, rawZone] = line.split('\t');
      const zone = String(rawZone || '').toLowerCase().replace(/^\./, '');
      const name = `${String(label || '').toLowerCase()}.${zone}`;
      if (/^[a-z0-9.-]+$/.test(name) && label && zone) names.push(name);
    }
    const uniqueNames = [...new Set(names)].sort();
    const zoneCounts = {};
    for (const name of uniqueNames) zoneCounts[zoneOf(name)] = (zoneCounts[zoneOf(name)] || 0) + 1;
    const loaded = { day, names: uniqueNames, zoneCounts };
    dayCache.set(day, loaded);
    while (dayCache.size > 3) dayCache.delete(dayCache.keys().next().value);
    return loaded;
  }

  function normalizedQuery(value) {
    const query = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9.-]*$/.test(query)) throw requestError('q may contain only a-z, 0-9, dot, and hyphen');
    return query;
  }

  async function search(input = {}) {
    const started = Date.now();
    const loaded = await loadDay(input.day);
    const mode = String(input.mode || 'contains').toLowerCase();
    if (!['contains', 'prefix', 'suffix', 'exact', 'regex'].includes(mode)) throw requestError(`Unknown search mode: ${mode}`);
    const query = mode === 'regex' ? String(input.q || '').trim() : normalizedQuery(input.q);
    if (mode === 'regex' && query.length > 200) throw requestError('Regex may not exceed 200 characters');
    let regex;
    try { if (mode === 'regex') regex = new RegExp(query, 'i'); }
    catch (error) { throw requestError(`Invalid regex: ${error.message}`); }
    const wantedZone = String(input.zone || '').trim().toLowerCase().replace(/^\./, '');
    if (wantedZone && !/^[a-z0-9-]+$/.test(wantedZone)) throw requestError('zone is invalid');
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(input.limit)) || 100));
    const cursor = Math.max(0, Math.trunc(Number(input.cursor)) || 0);
    const matches = name => mode === 'contains' ? name.includes(query)
      : mode === 'prefix' ? name.startsWith(query) : mode === 'suffix' ? name.slice(0, name.lastIndexOf('.')).endsWith(query)
        : mode === 'exact' ? (name === query || name.slice(0, name.lastIndexOf('.')) === query) : regex.test(name);
    const items = [];
    let total = 0;
    let nextCursor = null;
    let partial = false;
    for (let index = 0; index < loaded.names.length; index += 1) {
      if (mode === 'regex' && Date.now() - started >= 2000) { partial = true; break; }
      const name = loaded.names[index];
      if ((wantedZone && zoneOf(name) !== wantedZone) || !matches(name)) continue;
      total += 1;
      if (index < cursor) continue;
      if (items.length < limit) { items.push(name); nextCursor = index + 1; }
    }
    if (!partial && nextCursor !== null) {
      const more = loaded.names.slice(nextCursor).some(name => (!wantedZone || zoneOf(name) === wantedZone) && matches(name));
      if (!more) nextCursor = null;
    }
    return { day: loaded.day, total, items, nextCursor, partial, tookMs: Date.now() - started };
  }

  async function sample(input = {}) {
    const loaded = await loadDay(input.day);
    const wantedZone = String(input.zone || '').trim().toLowerCase().replace(/^\./, '');
    if (wantedZone && !/^[a-z0-9-]+$/.test(wantedZone)) throw requestError('zone is invalid');
    const count = Math.max(1, Math.min(500, Math.trunc(Number(input.n)) || 10));
    const pool = loaded.names.filter(name => !wantedZone || zoneOf(name) === wantedZone).slice();
    const random = seededRandom(loaded.day);
    for (let index = 0; index < Math.min(count, pool.length); index += 1) {
      const selected = index + Math.floor(random() * (pool.length - index));
      [pool[index], pool[selected]] = [pool[selected], pool[index]];
    }
    return { day: loaded.day, items: pool.slice(0, count) };
  }

  async function exportDay(input = {}) {
    const loaded = await loadDay(input.day);
    const zone = String(input.zone || '').trim().toLowerCase().replace(/^\./, '');
    if (zone && !/^[a-z0-9-]+$/.test(zone)) throw requestError('zone is invalid');
    const names = zone ? loaded.names.filter(name => zoneOf(name) === zone) : loaded.names;
    const stream = Readable.from(names.map(name => `${name}\n`));
    stream.day = loaded.day;
    stream.zone = zone;
    return stream;
  }

  async function importDay(input = {}) {
    const day = String(input.day || '');
    if (!validDay(day)) throw requestError('day must be a valid YYYY-MM-DD date');
    if (!input.stream || typeof input.stream.pipe !== 'function') throw requestError('Import body stream is required');

    const tape = path.join(directory, day, 'tape');
    const partPath = path.join(tape, 'adds.tsv.part');
    const addsPath = path.join(tape, 'adds.tsv');
    let bytes = 0;
    let lines = 0;
    let pending = '';
    const validateLine = rawLine => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const fields = line.split('\t');
      if (fields.length !== 3 || fields.some(field => !field)) {
        throw requestError(`Malformed adds.tsv line ${lines + 1}: expected 3 non-empty tab-separated fields`);
      }
      lines += 1;
    };
    const validator = new Transform({
      transform(chunk, encoding, callback) {
        try {
          bytes += chunk.length;
          if (bytes > MAX_IMPORT_BYTES) throw requestError('Universe import exceeds 300 MB', 413);
          pending += chunk.toString('utf8');
          const parts = pending.split('\n');
          pending = parts.pop();
          for (const line of parts) validateLine(line);
          callback(null, chunk);
        } catch (error) { callback(error); }
      },
      flush(callback) {
        try {
          if (pending) validateLine(pending);
          if (lines < 1000) throw requestError('Universe import must contain at least 1000 valid lines');
          callback();
        } catch (error) { callback(error); }
      },
    });

    await fsp.mkdir(tape, { recursive: true });
    try {
      await pipeline(input.stream, validator, fs.createWriteStream(partPath, { flags: 'w' }));
      await fsp.rename(partPath, addsPath);
    } catch (error) {
      await fsp.rm(partPath, { force: true }).catch(() => {});
      throw error;
    }
    dayCache.delete(day);
    statCache.delete(day);
    return { day, lines, bytes };
  }

  // ── Zone nameserver-movement tape (server/zone-ns-movement.js output, pushed
  // by the MacBook lane the same way adds.tsv is pushed): <dir>/<day>/ns/
  // movement.jsonl (one JSON row per movement, TAPE_COLUMNS-shaped plus a
  // selection tag) and ns/summary.json (the day's ns/summary.json totals).

  async function resolveNsDay(day) {
    if (day) {
      if (!validDay(day)) throw requestError('day must be a valid YYYY-MM-DD date');
      const found = await hasNsMovementDay(day);
      if (!found) throw requestError(`No NS movement data for day: ${day}`, 404);
      return day;
    }
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') throw requestError('No NS movement days are available', 404);
      throw error;
    }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !DAY_PATTERN.test(entry.name)) continue;
      if (await hasNsMovementDay(entry.name)) candidates.push(entry.name);
    }
    if (!candidates.length) throw requestError('No NS movement days are available', 404);
    return candidates.sort().at(-1);
  }

  async function nsMovementSummary(input = {}) {
    const day = await resolveNsDay(input.day);
    const text = await fsp.readFile(nsPath(day, 'summary.json'), 'utf8');
    return JSON.parse(text);
  }

  async function loadNsMovementDay(requestedDay) {
    const day = await resolveNsDay(requestedDay);
    if (nsDayCache.has(day)) {
      const cached = nsDayCache.get(day);
      nsDayCache.delete(day);
      nsDayCache.set(day, cached);
      return cached;
    }
    const text = await fsp.readFile(nsPath(day, 'movement.jsonl'), 'utf8');
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      rows.push(JSON.parse(line));
    }
    const loaded = { day, rows };
    nsDayCache.set(day, loaded);
    while (nsDayCache.size > 3) nsDayCache.delete(nsDayCache.keys().next().value);
    return loaded;
  }

  function csvSet(value) {
    return new Set(String(value || '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean));
  }

  async function queryNsMovement(input = {}) {
    const loaded = await loadNsMovementDay(input.day);
    const selection = String(input.selection || '').trim().toLowerCase();
    if (selection && !['departures', 'went-live', 'listed'].includes(selection)) {
      throw requestError(`Unknown selection: ${selection}`);
    }
    const fromSet = csvSet(input.from);
    const toSet = csvSet(input.to);
    const stateFilter = String(input.state || '').trim().toLowerCase();
    const query = String(input.q || '').trim().toLowerCase();
    if (query && !/^[a-z0-9.-]*$/.test(query)) throw requestError('q may contain only a-z, 0-9, dot, and hyphen');
    const wantedZone = String(input.zone || '').trim().toLowerCase().replace(/^\./, '');
    if (wantedZone && !/^[a-z0-9-]+$/.test(wantedZone)) throw requestError('zone is invalid');
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(input.limit)) || 200));
    const cursor = Math.max(0, Math.trunc(Number(input.cursor)) || 0);

    const matches = row => {
      if (selection && row.selection !== selection) return false;
      if (fromSet.size && !fromSet.has(String(row.prev_class || '').toLowerCase())) return false;
      if (toSet.size && !toSet.has(String(row.today_class || '').toLowerCase())) return false;
      if (stateFilter && String(row.probe?.state || '').toLowerCase() !== stateFilter) return false;
      if (query && !String(row.domain || '').toLowerCase().includes(query)) return false;
      if (wantedZone && zoneOf(String(row.domain || '')) !== wantedZone) return false;
      return true;
    };

    const items = [];
    let total = 0;
    let nextCursor = null;
    for (let index = 0; index < loaded.rows.length; index += 1) {
      const row = loaded.rows[index];
      if (!matches(row)) continue;
      total += 1;
      if (index < cursor) continue;
      if (items.length < limit) { items.push(row); nextCursor = index + 1; }
    }
    if (nextCursor !== null) {
      const more = loaded.rows.slice(nextCursor).some(matches);
      if (!more) nextCursor = null;
    }
    return { day: loaded.day, selection: selection || null, total, items, nextCursor };
  }

  async function importNsMovement(input = {}) {
    const day = String(input.day || '');
    if (!validDay(day)) throw requestError('day must be a valid YYYY-MM-DD date');
    if (!input.stream || typeof input.stream.pipe !== 'function') throw requestError('Import body stream is required');

    const nsDir = path.join(directory, day, 'ns');
    const partPath = path.join(nsDir, 'movement.jsonl.part');
    const movementPath = path.join(nsDir, 'movement.jsonl');
    const summaryPartPath = path.join(nsDir, 'summary.json.part');
    const summaryPath = path.join(nsDir, 'summary.json');

    let bytes = 0;
    let rows = 0;
    let pending = '';
    let firstLineSeen = false;
    let summary = null;

    const handleLine = rawLine => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) return null;
      if (!firstLineSeen) {
        firstLineSeen = true;
        let parsed;
        try { parsed = JSON.parse(line); }
        catch (error) { throw requestError(`Malformed ns-movement summary line: ${error.message}`); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || !parsed.summary || typeof parsed.summary !== 'object' || Array.isArray(parsed.summary)) {
          throw requestError('First ns-movement import line must be {"summary": {...}}');
        }
        summary = parsed.summary;
        return null;
      }
      try { JSON.parse(line); }
      catch (error) { throw requestError(`Malformed ns-movement row ${rows + 1}: ${error.message}`); }
      rows += 1;
      return line;
    };

    const validator = new Transform({
      transform(chunk, encoding, callback) {
        try {
          bytes += chunk.length;
          if (bytes > MAX_IMPORT_BYTES) throw requestError('Universe import exceeds 300 MB', 413);
          pending += chunk.toString('utf8');
          const parts = pending.split('\n');
          pending = parts.pop();
          const outLines = [];
          for (const line of parts) {
            const handled = handleLine(line);
            if (handled !== null) outLines.push(handled);
          }
          callback(null, outLines.length ? `${outLines.join('\n')}\n` : '');
        } catch (error) { callback(error); }
      },
      flush(callback) {
        try {
          let final = '';
          if (pending) {
            const handled = handleLine(pending);
            if (handled !== null) final = `${handled}\n`;
          }
          if (!firstLineSeen) throw requestError('ns-movement import must include a summary line as the first line');
          callback(null, final);
        } catch (error) { callback(error); }
      },
    });

    await fsp.mkdir(nsDir, { recursive: true });
    try {
      await pipeline(input.stream, validator, fs.createWriteStream(partPath, { flags: 'w' }));
      await fsp.rename(partPath, movementPath);
      await fsp.writeFile(summaryPartPath, JSON.stringify(summary));
      await fsp.rename(summaryPartPath, summaryPath);
    } catch (error) {
      await fsp.rm(partPath, { force: true }).catch(() => {});
      await fsp.rm(summaryPartPath, { force: true }).catch(() => {});
      throw error;
    }
    nsDayCache.delete(day);
    return { day, rows, bytes, summary };
  }

  return {
    directory, listDays, loadDay, search, sample, exportDay, importDay,
    nsMovementSummary, queryNsMovement, importNsMovement,
  };
}

function importAuthorized(req) {
  const configured = [
    process.env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN,
    process.env.DOMAINSCOUT_AGENT_TOKEN,
  ].filter(value => String(value || '').length > 0);
  if (!configured.length) throw requestError('Universe import token is not configured', 503);
  const supplied = [
    req.query?.token,
    req.get?.('X-DomainScout-Token') || req.headers?.['x-domainscout-token'],
  ].filter(value => value !== undefined && value !== null);
  let authorized = 0;
  for (const candidate of supplied) {
    for (const expected of configured) authorized |= Number(tokenMatches(candidate, expected));
  }
  return !!authorized;
}

function importBodyStream(req) {
  const encoding = String(req.get?.('Content-Encoding') || req.headers?.['content-encoding'] || '')
    .trim().toLowerCase();
  if (encoding && encoding !== 'gzip') throw requestError(`Unsupported Content-Encoding: ${encoding}`, 415);
  return encoding === 'gzip' ? req.pipe(zlib.createGunzip()) : req;
}

function registerUniverseRoutes(app, lane) {
  const route = handler => async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(await handler(req.query || {})); }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.message || 'Universe query failed' }); }
  };
  app.get('/api/universe/days', route(async () => ({ days: await lane.listDays() })));
  app.get('/api/universe/search', route(query => lane.search(query)));
  app.get('/api/universe/sample', route(query => lane.sample(query)));
  app.get('/api/universe/ns-movement/summary', route(query => lane.nsMovementSummary(query)));
  app.get('/api/universe/ns-movement', route(query => lane.queryNsMovement(query)));
  app.post('/api/universe/import', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      if (!importAuthorized(req)) throw requestError('Unauthorized universe import', 401);
      const stream = importBodyStream(req);
      res.json(await lane.importDay({ day: req.query?.day, stream }));
    } catch (error) {
      const badGzip = error?.code === 'Z_DATA_ERROR' || error?.code === 'Z_BUF_ERROR';
      res.status(badGzip ? 400 : error.statusCode || 500).json({
        error: badGzip ? 'Invalid gzip import body' : error.message || 'Universe import failed',
      });
    }
  });
  app.post('/api/universe/ns-movement/import', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      if (!importAuthorized(req)) throw requestError('Unauthorized universe ns-movement import', 401);
      const stream = importBodyStream(req);
      res.json(await lane.importNsMovement({ day: req.query?.day, stream }));
    } catch (error) {
      const badGzip = error?.code === 'Z_DATA_ERROR' || error?.code === 'Z_BUF_ERROR';
      res.status(badGzip ? 400 : error.statusCode || 500).json({
        error: badGzip ? 'Invalid gzip import body' : error.message || 'Universe ns-movement import failed',
      });
    }
  });
  app.get('/api/universe/export', async (req, res) => {
    try {
      const stream = await lane.exportDay(req.query || {});
      const suffix = stream.zone ? `-${stream.zone}` : '';
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="universe-${stream.day}${suffix}.txt"`);
      const encoding = String(req.get?.('Accept-Encoding') || req.headers?.['accept-encoding'] || '');
      if (/\bgzip\b/i.test(encoding)) {
        res.set('Content-Encoding', 'gzip');
        stream.pipe(zlib.createGzip()).pipe(res);
      } else {
        stream.pipe(res);
      }
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || 'Universe export failed' });
    }
  });
}

module.exports = { createUniverseLane, registerUniverseRoutes };
