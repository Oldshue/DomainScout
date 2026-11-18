'use strict';

const fs = require('node:fs');
const { openStore, dbPath, SCHEMA, asciiMasks } = require('./live-sites-public-store');

function makeSnippet(text, at, len) {
  const source = String(text || '');
  if (!source) return null;
  const start = Math.max(0, Math.min(at, source.length) - Math.floor((160 - len) / 2));
  const end = Math.min(source.length, start + 160);
  let value = source.slice(start, end).trim();
  if (start > 0) value = `…${value}`;
  if (end < source.length) value = `${value}…`;
  return value;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").pluck().get(name);
}

function shortSearch(db, value) {
  const length = [...value].length;
  if (length === 1) {
    const code = value.codePointAt(0);
    if (code < 32 || code > 126) return null;
    const ready = db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('ascii_masks_ready') === SCHEMA;
    const masks = asciiMasks(value);
    return { ready, column: code - 32 < 63 ? 'ascii_low' : 'ascii_high', mask: code - 32 < 63 ? masks.low : masks.high };
  }
  if (length !== 2 || !tableExists(db, 'projection_terms')) return null;
  const ready = db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('short_terms_ready') === SCHEMA;
  if (!ready) return { ready: false, expression: null };
  const terms = db.prepare(`SELECT term FROM projection_terms WHERE term>=? AND term<?
    UNION SELECT term FROM projection_terms WHERE substr(term,-2)=?`).pluck().all(value, `${value}\u{10ffff}`, value);
  const quote = term => `"${term.replaceAll('"', '""')}"`;
  return { ready: true, expression: terms.length && terms.length <= 4096 ? terms.map(quote).join(' OR ') : null, overflow: terms.length > 4096 };
}

const path = require('node:path');

// ── Reader state ────────────────────────────────────────────────────────────
// This process is long-lived, so the publishable rows of each day are held in
// memory and advanced from the store's certified offsets. A request then costs
// the rows it returns (plus one indexed text lookup per day when it searches),
// not a rescan of every day in its window. Three layers, each derived from the
// one before and keyed by it:
//   day    one entry per published domain, kept in feed order
//   view   a window of days with cross-day duplicates resolved
//   result a view narrowed by q/exclude, reused by every cursor page
const MAX_DAYS = 14, MAX_VIEWS = 4, MAX_RESULTS = 12;
const dayStates = new Map(), views = new Map(), results = new Map();
let nextVersion = 1;
const stats = { dayBuilds: 0, dayAdvances: 0, viewBuilds: 0, resultBuilds: 0, resultHits: 0 };

function remember(cache, key, value, max) {
  cache.delete(key); cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value);
  return value;
}
function recall(cache, key) {
  const value = cache.get(key);
  if (value !== undefined) { cache.delete(key); cache.set(key, value); }
  return value;
}
function toMs(observedAt) {
  if (!observedAt) return null;
  const value = Date.parse(observedAt);
  return Number.isFinite(value) ? value : null;
}
/** Feed order over { o: ms|null, domain }: newest first, undated last, then domain. */
function compareEntries(a, b) {
  if (a.o !== b.o) { if (a.o === null) return 1; if (b.o === null) return -1; return b.o - a.o; }
  return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
}

/**
 * Bring one day's in-memory rows up to the store's certified offsets. An
 * append reads only the new rows through the covering index; a replaced
 * source (new generation, final replacing partial, rebuilt store) starts over.
 */
function advanceDayState(db, day, file, active) {
  const stat = fs.statSync(file);
  const identity = `${stat.dev}:${stat.ino}|${active.map(source => `${source.name}:${source.generation}`).join('|')}`;
  let state = recall(dayStates, day);
  if (!state || state.identity !== identity || active.some(source => Number(source.offset) < (state.offsets.get(source.name) || 0))) {
    state = { identity, offsets: new Map(), byDomain: new Map(), titles: new Map(), zones: new Map(), all: [], good: [], version: 0 };
    stats.dayBuilds += 1;
  } else if (active.every(source => Number(source.offset) === state.offsets.get(source.name))) {
    return { state, built: false };
  } else stats.dayAdvances += 1;
  const read = db.prepare(`SELECT rowid AS rid,domain,zone,observed_at AS observedAt,title_key AS titleKey
    FROM projection_index WHERE source=? AND generation=? AND end_offset>? AND end_offset<=?`);
  const title = key => {
    let counter = state.titles.get(key);
    if (!counter) { counter = { n: 0 }; state.titles.set(key, counter); }
    return counter;
  };
  const zoneOf = value => {
    let zone = state.zones.get(value);
    if (zone === undefined) { zone = value; state.zones.set(value, zone); }
    return zone;
  };
  for (const source of active) {
    const from = state.offsets.get(source.name) || 0, to = Number(source.offset);
    if (to > from) {
      const ct = source.name === 'ct-launches.jsonl';
      for (const row of read.iterate(source.name, source.generation, from, to)) {
        const existing = state.byDomain.get(row.domain);
        // The daily stage's row owns a domain; the CT journal fills in the rest.
        if (existing && (ct || !existing.ct)) continue;
        const counter = title(row.titleKey);
        counter.n += 1;
        if (existing) {
          existing.t.n -= 1;
          Object.assign(existing, { rid: row.rid, zone: zoneOf(row.zone), o: toMs(row.observedAt), t: counter, ct });
        } else {
          const entry = { rid: row.rid, domain: row.domain, zone: zoneOf(row.zone), o: toMs(row.observedAt), t: counter, ct };
          state.byDomain.set(row.domain, entry); state.all.push(entry);
        }
      }
    }
    state.offsets.set(source.name, to);
  }
  state.all.sort(compareEntries);
  // A title repeated 8+ times among a day's rows is a kit and is not published.
  state.good = state.all.filter(entry => entry.t.n < 8);
  state.version = nextVersion++;
  remember(dayStates, day, state, MAX_DAYS);
  return { state, built: true };
}

function openDay(universeDir, day) {
  const file = dbPath(universeDir, day);
  if (!fs.existsSync(file)) return null;
  const db = openStore(file, { readonly: true });
  try {
    if (db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('schema') !== SCHEMA) {
      db.close();
      return null;
    }
    const stored = db.prepare('SELECT name,generation,dev,ino,offset,captured_size AS size,updated_at AS updatedAt FROM projection_sources').all();
    const names = new Set(stored.map(row => row.name));
    const observation = names.has('observations.jsonl') ? 'observations.jsonl' : names.has('observations.partial.jsonl') ? 'observations.partial.jsonl' : null;
    const activeNames = [observation, names.has('ct-launches.jsonl') ? 'ct-launches.jsonl' : null].filter(Boolean);
    if (!activeNames.length) {
      db.close();
      return null;
    }
    const active = activeNames.map(name => stored.find(row => row.name === name));
    const { state, built } = advanceDayState(db, day, file, active);
    const sources = stored.map(({ generation, ...row }) => row);
    return { day, db, file, state, built, sources };
  } catch (error) { db.close(); throw error; }
}

/** Rowids whose searchable text contains `value`, and whether a short-literal index was current. */
function matchingRows(db, value) {
  const quote = text => `"${text.replaceAll('"', '""')}"`;
  let sql, args, ready = true;
  if ([...value].length >= 3) {
    sql = 'SELECT rowid FROM projection_search WHERE projection_search MATCH ?'; args = [quote(value)];
  } else {
    const short = shortSearch(db, value);
    if (short) ready = short.ready;
    if (short?.ready && short.column) {
      sql = `SELECT rowid FROM projection_index WHERE (${short.column} & ?) != 0`; args = [short.mask];
    } else if (short?.ready && !short.overflow) {
      if (!short.expression) return { rows: new Set(), ready };
      sql = `SELECT projection_search.rowid FROM projection_search
        JOIN projection_rows p ON p.rowid=projection_search.rowid
        WHERE projection_search MATCH ? AND instr(p.search_lower,?)>0`;
      args = [short.expression, value];
    } else {
      sql = 'SELECT rowid FROM projection_rows WHERE instr(search_lower, ?) > 0'; args = [value];
    }
  }
  return { rows: new Set(db.prepare(sql).pluck().all(...args)), ready };
}

/** The window's rows per day after the newest source day claims each domain. */
function viewFor(opened) {
  const key = opened.map(value => `${value.day}@${value.state.version}`).join(',');
  const cached = recall(views, key);
  if (cached) return cached;
  stats.viewBuilds += 1;
  const seen = new Set(), days = [];
  for (const value of opened) {
    const rows = [];
    for (const entry of value.state.good) {
      if (seen.has(entry.domain)) continue;
      seen.add(entry.domain); rows.push(entry);
    }
    days.push(rows);
  }
  return remember(views, key, { key, days }, MAX_VIEWS);
}

function resultFor(opened, view, q, exclude, onProgress = null) {
  const key = `${view.key}\u0000${q}\u0000${exclude}`;
  const cached = recall(results, key);
  if (cached) { stats.resultHits += 1; return cached; }
  stats.resultBuilds += 1;
  const zones = new Map(), days = [];
  let shortSearchReady = true;
  opened.forEach((value, index) => {
    let matches = view.days[index];
    if (q || exclude) {
      const wanted = q ? matchingRows(value.db, q) : null;
      const unwanted = exclude ? matchingRows(value.db, exclude) : null;
      shortSearchReady = shortSearchReady && (wanted?.ready ?? true) && (unwanted?.ready ?? true);
      matches = matches.filter(entry => (!wanted || wanted.rows.has(entry.rid)) && !(unwanted && unwanted.rows.has(entry.rid)));
      onProgress?.();
    }
    const dayZones = new Map();
    for (const entry of matches) dayZones.set(entry.zone, (dayZones.get(entry.zone) || 0) + 1);
    for (const [zone, count] of dayZones) zones.set(zone, (zones.get(zone) || 0) + count);
    days.push({ matches, zones: dayZones });
  });
  const result = { days, shortSearchReady,
    zones: [...zones].map(([z, count]) => ({ zone: z, count })).sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone)).slice(0, 50) };
  // A store still building its short-literal index answers by scanning; keep
  // reporting that on every read until the index is current.
  return shortSearchReady ? remember(results, key, result, MAX_RESULTS) : result;
}

/** Index of the first entry that sorts strictly after `key`. */
function firstAfter(entries, key) {
  let low = 0, high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareEntries(entries[middle], key) <= 0) low = middle + 1; else high = middle;
  }
  return low;
}

function freshnessFor(value, shortSearchReady) {
  const sourceByName = new Map(value.sources.map(row => [row.name, row]));
  const sites = path.dirname(value.file);
  const final = path.join(sites, 'observations.jsonl');
  const partial = path.join(sites, 'observations.partial.jsonl');
  const ct = path.join(sites, 'ct-launches.jsonl');
  const expected = [fs.existsSync(final) ? final : partial, ct].filter(fs.existsSync);
  return expected.map(sourcePath => {
    const name = path.basename(sourcePath), state = sourceByName.get(name), stat = fs.statSync(sourcePath);
    return { name, verifiedBytes: Number(state?.offset || 0), sourceBytes: stat.size,
      currentIdentity: !!state && String(stat.dev) === String(state.dev) && String(stat.ino) === String(state.ino),
      shortSearchReady,
      updatedAt: state?.updatedAt || null };
  });
}

function run({ universeDir, days, q = '', exclude = '', zone = '', cursor = null, limit = 50 }, { onProgress = null } = {}) {
  const opened = [];
  let missing = 0;
  try {
    for (const day of days) {
      const value = openDay(universeDir, day);
      if (!value) { missing += 1; continue; }
      opened.push(value);
      // A cold reader loads one day at a time, and a new search looks each day
      // up in turn; say so after each, so a first read of a long window is
      // judged per day rather than as one silence.
      if (value.built) onProgress?.();
    }
    const result = resultFor(opened, viewFor(opened), q, exclude, onProgress);
    const items = [], sourceStatus = [];
    let total = 0, more = false, last = null;
    const cursorKey = cursor ? { domain: cursor.k, o: cursor.o === null ? null : Number(cursor.o) } : null;
    opened.forEach((value, index) => {
      const { day, db } = value, { matches, zones } = result.days[index];
      sourceStatus.push({ day, sources: value.sources, freshness: freshnessFor(value, result.shortSearchReady) });
      total += zone ? (zones.get(zone) || 0) : matches.length;
      if (more || (cursor && day > cursor.d)) return;
      const hydrate = db.prepare(`SELECT domain,zone,day,title,description,url,observed_at AS observedAt,${q ? 'body' : 'NULL AS body'}
        FROM projection_rows WHERE rowid=?`);
      for (let at = cursor && day === cursor.d ? firstAfter(matches, cursorKey) : 0; at < matches.length; at += 1) {
        const item = matches[at];
        if (zone && item.zone !== zone) continue;
        if (items.length >= limit) { more = true; break; }
        const row = hydrate.get(item.rid);
        if (!row) continue;
        const hydrated = { domain: row.domain, zone: row.zone, day: row.day, title: row.title, description: row.description, url: row.url, observedAt: row.observedAt };
        if (q) {
          const base = `${row.domain}\n${row.title}\n${row.description || ''}`.toLowerCase();
          if (!base.includes(q)) {
            const found = String(row.body || '').toLowerCase().indexOf(q);
            if (found >= 0) hydrated.snippet = makeSnippet(row.body, found, q.length);
          }
        }
        items.push(hydrated); last = hydrated;
      }
    });
    return { items, total, more, last, missing, sourceStatus, zones: result.zones };
  } finally { for (const value of opened) value.db.close(); }
}

process.on('message', message => {
  if (!message || message.type !== 'query') return;
  try { process.send?.({ id: message.id, ok: true, value: run(message.payload, { onProgress: () => process.send?.({ id: message.id, progress: true }) }) }); }
  catch (error) { process.send?.({ id: message.id, ok: false, error: error.message }); }
});
