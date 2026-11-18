'use strict';

const fs = require('node:fs');
const { openStore, dbPath, SCHEMA, asciiMasks } = require('./live-sites-public-store');
const { Worker } = require('node:worker_threads');
const { snapshotDir, snapshotFiles, readManifest, activeSources, loadSegment, scanSegment, segmentPieces } = require('./live-sites-public-snapshot');
const { releaseOwnFileCache } = require('./file-cache-advice');

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
    if (code >= 32 && code <= 126) {
      const ready = db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('ascii_masks_ready') === SCHEMA;
      const masks = asciiMasks(value);
      return code - 32 < 63 ? { ready, column: 'ascii_low', field: 'lo', mask: masks.low } : { ready, column: 'ascii_high', field: 'hi', mask: masks.high };
    }
  }
  if (length > 2 || !tableExists(db, 'projection_terms')) return null;
  const ready = db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('short_terms_ready') === SCHEMA;
  if (!ready) return { ready: false };
  // Every row holding the literal has an indexed three-character term that
  // holds it too: a pair starts or ends one, a single character sits in one.
  const terms = length === 2
    ? db.prepare(`SELECT term FROM projection_terms WHERE term>=? AND term<?
      UNION SELECT term FROM projection_terms WHERE substr(term,-2)=?`).pluck().all(value, `${value}\u{10ffff}`, value)
    : db.prepare('SELECT term FROM projection_terms WHERE instr(term,?)>0').pluck().all(value);
  return { ready: true, terms };
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
const MAX_DAYS = 14, MAX_VIEWS = 4, MAX_RESULTS = 12, MAX_LOOKUPS = 32, TERM_BATCH = 400;
const dayStates = new Map(), views = new Map(), results = new Map(), lookups = new Map();
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
  const masks = db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('ascii_masks_ready') === SCHEMA;
  const identity = `${stat.dev}:${stat.ino}|${masks}|${active.map(source => `${source.name}:${source.generation}`).join('|')}`;
  let state = recall(dayStates, day);
  if (!state || state.identity !== identity || active.some(source => Number(source.offset) < (state.offsets.get(source.name) || 0))) {
    state = { identity, offsets: new Map(), byDomain: new Map(), titles: new Map(), zones: new Map(), all: [], good: [], version: 0 };
    stats.dayBuilds += 1;
  } else if (active.every(source => Number(source.offset) === state.offsets.get(source.name))) {
    return { state, built: false };
  } else stats.dayAdvances += 1;
  // A first load walks the narrow table once in storage order; an append
  // seeks just its new rows. Each row brings its character masks, so a
  // one-character search is answered from memory.
  const reader = plan => db.prepare(`SELECT rowid AS rid,domain,zone,observed_at AS observedAt,title_key AS titleKey,ascii_low AS lo,ascii_high AS hi
    FROM projection_index ${plan} WHERE source=? AND generation=? AND end_offset>? AND end_offset<=?`).safeIntegers(true);
  const readAll = reader('NOT INDEXED'), readNew = reader('');
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
      for (const row of (from ? readNew : readAll).iterate(source.name, source.generation, from, to)) {
        row.rid = Number(row.rid);
        const existing = state.byDomain.get(row.domain);
        // The daily stage's row owns a domain; the CT journal fills in the rest.
        if (existing && (ct || !existing.ct)) continue;
        const counter = title(row.titleKey);
        counter.n += 1;
        if (existing) {
          existing.t.n -= 1;
          Object.assign(existing, { rid: row.rid, zone: zoneOf(row.zone), o: toMs(row.observedAt), t: counter, ct, lo: row.lo, hi: row.hi });
        } else {
          const entry = { rid: row.rid, domain: row.domain, zone: zoneOf(row.zone), o: toMs(row.observedAt), t: counter, ct, lo: row.lo, hi: row.hi };
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

/**
 * Rowids whose searchable text contains `value`, and whether a short-literal
 * index was current. Kept per day state, so a window whose newest day has
 * advanced looks only that day up again.
 */
// ── Scan threads ────────────────────────────────────────────────────────────
// A first search of a window passes over all of its text. The text sits in
// shared memory, so a few threads in this process each take a run of rows.
const SCAN_THREADS = 4, PIECE_BYTES = 24 * 1024 * 1024, INLINE_BYTES = 1024 * 1024;
const scanPool = { threads: [], idle: [], queue: [], jobs: new Map(), nextId: 1, broken: false };
function scanThread() {
  const thread = new Worker(path.join(__dirname, 'live-sites-public-scan-thread.js'), { resourceLimits: { maxOldGenerationSizeMb: 64 } });
  thread.unref();
  thread.on('message', ({ id, rows }) => {
    const job = scanPool.jobs.get(id); scanPool.jobs.delete(id);
    scanPool.idle.push(thread); job?.resolve(rows); pumpScans();
  });
  const fail = () => {
    // Without its threads the reader scans on its own; slower, never wrong.
    scanPool.broken = true;
    for (const job of [...scanPool.jobs.values(), ...scanPool.queue]) job.resolve(null);
    scanPool.jobs.clear(); scanPool.queue.length = 0;
  };
  thread.on('error', fail); thread.on('exit', code => { if (code !== 0) fail(); });
  scanPool.threads.push(thread);
  return thread;
}
function pumpScans() {
  while (scanPool.queue.length) {
    const thread = scanPool.idle.pop() || (scanPool.threads.length < SCAN_THREADS ? scanThread() : null);
    if (!thread) return;
    const job = scanPool.queue.shift();
    scanPool.jobs.set(job.message.id, job);
    thread.postMessage(job.message);
  }
}
async function scanMemory(state, value) {
  const needle = Buffer.from(value, 'utf8'), rows = new Set(), pending = [];
  for (const segment of state.segments) {
    const inline = (from, to) => scanSegment(segment, needle, row => rows.add(segment.rids[row]), from, to);
    if (scanPool.broken || segment.lower.length <= INLINE_BYTES) { inline(0, segment.count); continue; }
    for (const [from, to] of segmentPieces(segment, PIECE_BYTES)) {
      pending.push(new Promise(resolve => {
        scanPool.queue.push({ resolve, message: { id: scanPool.nextId++, lower: segment.lower.buffer, lowerStart: segment.lowerStart.buffer, count: segment.count, needle, from, to } });
      }).then(found => { if (found) for (const row of found) rows.add(segment.rids[row]); else inline(from, to); }));
    }
  }
  pumpScans();
  await Promise.all(pending);
  return rows;
}

function matchingRows(opened, value, onProgress = null) {
  const key = `${opened.day}@${opened.state.version}\u0000${value}`;
  const cached = recall(lookups, key);
  if (cached) return cached;
  const db = opened.db;
  const quote = text => `"${text.replaceAll('"', '""')}"`;
  const found = rows => { const result = { rows, ready: true }; onProgress?.(); return remember(lookups, key, result, MAX_LOOKUPS); };
  // The day's searchable text is in memory: one pass finds every row, for any
  // literal of any length, without touching the disk.
  if (opened.memory) return scanMemory(opened.state, value).then(found);
  let sql, args, ready = true;
  if ([...value].length >= 3) {
    sql = 'SELECT rowid FROM projection_search WHERE projection_search MATCH ?'; args = [quote(value)];
  } else {
    const short = shortSearch(db, value);
    if (short) ready = short.ready;
    if (short?.ready && short.column) {
      const rows = new Set();
      for (const entry of opened.state.all) if ((entry[short.field] & short.mask) !== 0n) rows.add(entry.rid);
      return found(rows);
    }
    if (short?.ready) {
      // Printable ASCII is indexed exactly as stored, so those terms alone name
      // the matching rows and no page text is read back. Other characters may
      // be indexed under a folded form, so their candidates are confirmed
      // against the stored text. Terms go in batches, each a bounded step.
      const exact = /^[\x20-\x7e]+$/.test(value), rows = new Set();
      const match = db.prepare('SELECT rowid FROM projection_search WHERE projection_search MATCH ?').pluck();
      for (let at = 0; at < short.terms.length; at += TERM_BATCH) {
        for (const rowid of match.iterate(short.terms.slice(at, at + TERM_BATCH).map(quote).join(' OR '))) rows.add(rowid);
        if (at + TERM_BATCH < short.terms.length) onProgress?.();
      }
      if (exact) return found(rows);
      const confirm = db.prepare('SELECT 1 FROM projection_rows WHERE rowid=? AND instr(search_lower,?)>0').pluck();
      let checked = 0;
      for (const rowid of rows) {
        if (!confirm.get(rowid, value)) rows.delete(rowid);
        if (++checked % 2000 === 0) onProgress?.();
      }
      return found(rows);
    }
    sql = 'SELECT rowid FROM projection_rows WHERE instr(search_lower, ?) > 0'; args = [value];
  }
  const rows = new Set(db.prepare(sql).pluck().all(...args));
  // A store still building its short-literal index answers by scanning; keep
  // reporting that on every read until the index is current.
  if (!ready) { onProgress?.(); return { rows, ready }; }
  return found(rows);
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

async function resultFor(opened, view, q, exclude, onProgress = null) {
  const key = `${view.key}\u0000${q}\u0000${exclude}`;
  const cached = recall(results, key);
  if (cached) { stats.resultHits += 1; return cached; }
  stats.resultBuilds += 1;
  const zones = new Map(), days = [];
  let shortSearchReady = true;
  // Every day's lookups are started before any is awaited, so in-memory days share the scan threads.
  const found = opened.map(value => [q ? matchingRows(value, q, onProgress) : null, exclude ? matchingRows(value, exclude, onProgress) : null]);
  for (const [index, value] of opened.entries()) {
    let matches = view.days[index];
    if (q || exclude) {
      const [wanted, unwanted] = await Promise.all(found[index]);
      shortSearchReady = shortSearchReady && (wanted?.ready ?? true) && (unwanted?.ready ?? true);
      matches = matches.filter(entry => (!wanted || wanted.rows.has(entry.rid)) && !(unwanted && unwanted.rows.has(entry.rid)));
    }
    const dayZones = new Map();
    for (const entry of matches) dayZones.set(entry.zone, (dayZones.get(entry.zone) || 0) + 1);
    for (const [zone, count] of dayZones) zones.set(zone, (zones.get(zone) || 0) + count);
    days.push({ matches, zones: dayZones });
  }
  const result = { days, shortSearchReady,
    zones: [...zones].map(([z, count]) => ({ zone: z, count })).sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone)).slice(0, 50) };
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

// ── Days held in memory ─────────────────────────────────────────────────────
// The store's writer keeps a flat reader snapshot beside each day's store. A
// day with a snapshot is loaded whole (a few sequential reads) and from then
// on is searched and paged from memory; only snippets read the disk, one small
// read per row. A day without one yet is read from the store as above.
const MEMORY_DAYS = Number.isFinite(Number(process.env.DOMAINSCOUT_LIVE_FEED_MEMORY_DAYS)) && process.env.DOMAINSCOUT_LIVE_FEED_MEMORY_DAYS !== ''
  ? Math.max(0, Math.trunc(Number(process.env.DOMAINSCOUT_LIVE_FEED_MEMORY_DAYS))) : 7;
const memoryStates = new Map(), memoryLoads = new Map();
const MARK = ['rows', 'index', 'public', 'lower', 'body'];

// Inflating a source briefly holds two copies of its text. Two at a time keeps
// a cold start's peak small; requests are served newest day first.
const loadGate = { running: 0, waiting: [] };
async function gated(task) {
  if (loadGate.running >= 2) await new Promise(resolve => loadGate.waiting.push(resolve));
  loadGate.running += 1;
  try { return await task(); }
  finally { loadGate.running -= 1; loadGate.waiting.shift()?.(); }
}

async function advanceMemoryState(day, dir, manifest) {
  let state = memoryStates.get(day);
  const reusable = state && state.sources.size === manifest.sources.length && manifest.sources.every(source => {
    const held = state.sources.get(source.name);
    return held && held.generation === source.generation && held.offset <= source.offset && MARK.every(field => held[field] <= source[field]);
  });
  const fresh = !reusable;
  if (fresh) state = { sources: new Map(), segments: [], byDomain: new Map(), titles: new Map(), zones: new Map(), all: [], good: [], version: 0 };
  else if (manifest.sources.every(source => state.sources.get(source.name).offset === source.offset)) return { state, built: false };
  // Read everything first; the state then changes in one step.
  const started = Date.now();
  const loaded = await Promise.all(manifest.sources.map(source => {
    const held = state.sources.get(source.name) || null;
    return source.rows > (held?.rows || 0) ? gated(() => loadSegment(dir, source, held)) : null;
  }));
  if (fresh) stats.dayBuilds += 1; else stats.dayAdvances += 1;
  manifest.sources.forEach((source, at) => {
    const segment = loaded[at], ct = source.name === 'ct-launches.jsonl';
    state.sources.set(source.name, { generation: source.generation, offset: source.offset, ...Object.fromEntries(MARK.map(field => [field, source[field]])) });
    if (!segment) return;
    state.segments.push(segment);
    for (let row = 0; row < segment.count; row += 1) {
      const item = JSON.parse(segment.public.toString('utf8', segment.publicStart[row], segment.publicStart[row + 1]));
      const existing = state.byDomain.get(item.domain);
      // The daily stage's row owns a domain; the CT journal fills in the rest.
      if (existing && (ct || !existing.ct)) continue;
      const titleKey = item.title.trim().toLowerCase();
      let counter = state.titles.get(titleKey);
      if (!counter) { counter = { n: 0 }; state.titles.set(titleKey, counter); }
      counter.n += 1;
      let zone = state.zones.get(item.zone);
      if (zone === undefined) { zone = item.zone; state.zones.set(zone, zone); }
      if (existing) {
        existing.t.n -= 1;
        Object.assign(existing, { rid: segment.rids[row], zone, o: toMs(item.observedAt), t: counter, ct, segment, row });
      } else {
        const entry = { rid: segment.rids[row], domain: item.domain, zone, o: toMs(item.observedAt), t: counter, ct, segment, row };
        state.byDomain.set(item.domain, entry); state.all.push(entry);
      }
    }
  });
  state.all.sort(compareEntries);
  state.good = state.all.filter(entry => entry.t.n < 8);
  state.version = nextVersion++;
  memoryStates.set(day, state);
  // Hold the newest days only; an older day falls back to the store.
  for (const held of [...memoryStates.keys()].sort().reverse().slice(MEMORY_DAYS + 1)) memoryStates.delete(held);
  if (fresh) {
    releaseOwnFileCache(snapshotFiles(path.dirname(dir))).catch(() => {});
    const megabytes = Math.round(state.segments.reduce((sum, segment) => sum + segment.lower.length, 0) / 1048576);
    process.send?.({ log: `reader holds ${day} in memory: ${state.all.length} rows, ${megabytes} MB of text, loaded in ${Date.now() - started} ms` });
  }
  return { state, built: true };
}

function memoryState(day, dir, manifest) {
  // One load per day at a time; a later caller sees the earlier one's result.
  const next = (memoryLoads.get(day) || Promise.resolve()).catch(() => {}).then(() => advanceMemoryState(day, dir, manifest));
  memoryLoads.set(day, next);
  return next.finally(() => { if (memoryLoads.get(day) === next) memoryLoads.delete(day); });
}

/**
 * True when the snapshot is not a prefix of what the store now certifies (a
 * replaced source, a completed day). A snapshot that is merely a step behind
 * is still served, and reported as refreshing, until its writer catches up.
 */
function storeDiverged(universeDir, day, manifest) {
  const file = dbPath(universeDir, day);
  if (!fs.existsSync(file)) return true;
  const db = openStore(file, { readonly: true });
  try {
    if (db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('schema') !== SCHEMA) return true;
    const active = activeSources(db.prepare('SELECT name,generation,offset FROM projection_sources').all());
    return active.length !== manifest.sources.length || active.some(source => {
      const held = manifest.sources.find(candidate => candidate.name === source.name);
      return !held || held.generation !== source.generation || held.offset > Number(source.offset);
    });
  } finally { db.close(); }
}

async function prepareDay(universeDir, day, eligible) {
  if (eligible) {
    const file = dbPath(universeDir, day), dir = snapshotDir(path.dirname(file));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const manifest = readManifest(dir);
      if (!manifest || !manifest.sources.length) break;
      const sources = manifest.sources.map(({ name, dev, ino, offset, size, updatedAt }) => ({ name, dev, ino, offset, size, updatedAt }));
      const level = freshnessFor({ file, sources }, true);
      const current = level.length === sources.length && level.every(source => source.currentIdentity && source.verifiedBytes === source.sourceBytes);
      if (!current && storeDiverged(universeDir, day, manifest)) {
        const value = openDay(universeDir, day);
        return value && { ...value, snapshotLag: true };
      }
      try {
        const { state, built } = await memoryState(day, dir, manifest);
        dayStates.delete(day); // the store-read copy of this day is no longer needed
        return { day, memory: true, file, state, built, sources };
      } catch { /* the writer replaced a source mid-read: look again, then use the store */ }
    }
    // No usable snapshot: serve from the store and ask for the copy to be made.
    const value = openDay(universeDir, day);
    return value && { ...value, snapshotLag: true };
  }
  return openDay(universeDir, day);
}

async function readBodies(wanted) {
  const handles = new Map(), bodies = new Map();
  try {
    await Promise.all(wanted.map(async entry => {
      const { segment, row } = entry, from = segment.bodyStart[row], length = segment.bodyStart[row + 1] - from;
      if (!length) return;
      if (!handles.has(segment.bodyFile)) handles.set(segment.bodyFile, fs.promises.open(segment.bodyFile, 'r'));
      const handle = await handles.get(segment.bodyFile);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      bodies.set(entry, buffer.toString('utf8', 0, bytesRead));
    }));
  } finally {
    await Promise.all([...handles.values()].map(pending => pending.then(handle => handle.close(), () => {})));
  }
  return bodies;
}

async function run({ universeDir, days, q = '', exclude = '', zone = '', cursor = null, limit = 50 }, { onProgress = null } = {}) {
  const opened = [], stores = [];
  let missing = 0;
  try {
    const prepared = await Promise.all(days.map((day, at) => prepareDay(universeDir, day, at < MEMORY_DAYS).then(value => {
      if (value?.db) stores.push(value.db);
      // A cold reader loads one day at a time, and a new search looks each day
      // up in turn; say so after each, so a first read of a long window is
      // judged per day rather than as one silence.
      if (value?.built) onProgress?.();
      return value;
    })));
    for (const value of prepared) { if (value) opened.push(value); else missing += 1; }
    const result = await resultFor(opened, viewFor(opened), q, exclude, onProgress);
    const page = [], sourceStatus = [];
    let total = 0, more = false;
    const cursorKey = cursor ? { domain: cursor.k, o: cursor.o === null ? null : Number(cursor.o) } : null;
    opened.forEach((value, index) => {
      const { day } = value, { matches, zones } = result.days[index];
      sourceStatus.push({ day, sources: value.sources, freshness: freshnessFor(value, result.shortSearchReady) });
      total += zone ? (zones.get(zone) || 0) : matches.length;
      if (more || (cursor && day > cursor.d)) return;
      const hydrate = value.memory ? null : value.db.prepare(`SELECT domain,zone,day,title,description,url,observed_at AS observedAt,${q ? 'body' : 'NULL AS body'}
        FROM projection_rows WHERE rowid=?`);
      for (let at = cursor && day === cursor.d ? firstAfter(matches, cursorKey) : 0; at < matches.length; at += 1) {
        const entry = matches[at];
        if (zone && entry.zone !== zone) continue;
        if (page.length >= limit) { more = true; break; }
        const row = value.memory
          ? JSON.parse(entry.segment.public.toString('utf8', entry.segment.publicStart[entry.row], entry.segment.publicStart[entry.row + 1]))
          : hydrate.get(entry.rid);
        if (!row) continue;
        const item = { domain: row.domain, zone: row.zone, day: row.day, title: row.title, description: row.description, url: row.url, observedAt: row.observedAt };
        // Page text matters only when the query is not already in the name, title or description.
        const snippet = !!q && !`${row.domain}\n${row.title}\n${row.description || ''}`.toLowerCase().includes(q);
        page.push({ item, entry: value.memory && snippet ? entry : null, body: !value.memory && snippet ? row.body : null });
      }
    });
    const bodies = await readBodies(page.map(slot => slot.entry).filter(Boolean));
    const items = page.map(({ item, entry, body }) => {
      const text = entry ? bodies.get(entry) : body;
      if (text) {
        const found = String(text).toLowerCase().indexOf(q);
        if (found >= 0) item.snippet = makeSnippet(text, found, q.length);
      }
      return item;
    });
    return { items, total, more, last: items.at(-1) || null, missing, sourceStatus, zones: result.zones,
      snapshotLag: opened.some(value => value.snapshotLag) };
  } finally { for (const db of stores) db.close(); }
}

/** Load the given days ahead of any request for them. Never competes with a query for the reader's turn. */
async function warm({ universeDir, days = [] }) {
  await Promise.all(days.slice(0, MEMORY_DAYS).map(async day => {
    const dir = snapshotDir(path.dirname(dbPath(universeDir, day))), manifest = readManifest(dir);
    if (manifest?.sources.length) await memoryState(day, dir, manifest).catch(() => {});
  }));
}

process.on('message', async message => {
  if (message?.type === 'warm') { warm(message.payload).catch(() => {}); return; }
  if (!message || message.type !== 'query') return;
  try { process.send?.({ id: message.id, ok: true, value: await run(message.payload, { onProgress: () => process.send?.({ id: message.id, progress: true }) }) }); }
  catch (error) { process.send?.({ id: message.id, ok: false, error: error.message }); }
});
