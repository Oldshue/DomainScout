'use strict';

/**
 * Reader snapshot of one day's public store.
 *
 * The public store (public-feed-v2.sqlite) is the certified record. Reading a
 * day back out of it means walking pages scattered through a large file, and
 * every search means reading index pages from disk. The feed reader instead
 * loads this flat, append-only copy of the published rows with a few
 * sequential reads and answers searches from memory.
 *
 * <day>/sites/public-feed-reader-v1/
 *   manifest.json                 certified sources and the byte length of each file
 *   <source>.<generation>.index   one fixed 32-byte record per row
 *   <source>.<generation>.public  one JSON line per row: exactly the public fields
 *   <source>.<generation>.lower   gzip members; inflated, each row's searchable text + 0xFF
 *   <source>.<generation>.body    each row's page text as captured, for snippets
 *
 * Files only grow. The manifest is replaced atomically after the bytes it
 * names are written, so a reader never sees a torn row and a crashed writer
 * leaves only an ignorable tail.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIR = 'public-feed-reader-v1';
const MANIFEST = 'manifest.json';
const LOCK = 'writer.lock';
const SCHEMA = 'domainscout.live-sites-reader-snapshot/v1';
const RECORD_BYTES = 32;
const ROW_END = 0xff; // never part of UTF-8, so no search can span two rows
const PARTS = ['index', 'public', 'lower', 'body'];
const BATCH_BYTES = 8 * 1024 * 1024;
const LOCK_STALE_MS = 2 * 60 * 1000;

function snapshotDir(sites) { return path.join(sites, DIR); }
function partPath(dir, source, part) { return path.join(dir, `${source.prefix}.${part}`); }

function readManifest(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return value && value.schema === SCHEMA && Array.isArray(value.sources) ? value : null;
  } catch { return null; }
}

/** The sources a day publishes: its final (else partial) observations, then the CT journal. */
function activeSources(stored) {
  const byName = new Map(stored.map(row => [row.name, row]));
  const observation = byName.get('observations.jsonl') || byName.get('observations.partial.jsonl') || null;
  return [observation, byName.get('ct-launches.jsonl') || null].filter(Boolean);
}

/**
 * One writer per day at a time. The lock names its holder and is refreshed
 * while a long copy runs, so a writer that was stopped mid-copy (a restart)
 * is recognised at once rather than waited out.
 */
function acquireLock(dir) {
  const file = path.join(dir, LOCK);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return { touch() { try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* lock taken over */ } },
        release() { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch { /* already gone */ } } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = 0, age = 0;
      try { holder = Number(fs.readFileSync(file, 'utf8')); age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      let alive = holder === process.pid;
      if (!alive && holder > 0) { try { process.kill(holder, 0); alive = true; } catch (probe) { alive = probe.code === 'EPERM'; } }
      if (alive && age < LOCK_STALE_MS) return null;
      try { fs.unlinkSync(file); } catch { /* raced with another writer */ }
    }
  }
  return null;
}

function appendRows(db, dir, source, toOffset, lock) {
  const fresh = source.offset === 0 && source.rows === 0;
  const handles = Object.fromEntries(PARTS.map(part => [part, fs.openSync(partPath(dir, source, part), fresh ? 'w' : 'r+')]));
  try {
    // Drop anything a crashed writer left past the certified lengths.
    for (const part of PARTS) fs.ftruncateSync(handles[part], source[part]);
    const columns = 'rowid AS rid,end_offset AS endOffset,domain,zone,day,title,description,url,observed_at AS observedAt,body,search_lower AS lower';
    // A first copy walks the table once in storage order; an append seeks its new rows.
    const rows = (fresh
      ? db.prepare(`SELECT ${columns} FROM projection_rows NOT INDEXED WHERE source=? AND generation=? AND end_offset>? AND end_offset<=?`)
      : db.prepare(`SELECT ${columns} FROM projection_rows WHERE rowid IN (
          SELECT rowid FROM projection_index WHERE source=? AND generation=? AND end_offset>? AND end_offset<=?)`))
      .iterate(source.name, source.generation, source.offset, toOffset);
    let pending = { index: [], public: [], lower: [], body: [] }, bytes = 0;
    const flush = () => {
      if (!pending.index.length) return;
      for (const part of PARTS) {
        let chunk = Buffer.concat(pending[part]);
        if (part === 'lower') chunk = zlib.gzipSync(chunk, { level: 3 });
        if (chunk.length) fs.writeSync(handles[part], chunk, 0, chunk.length, source[part]);
        source[part] += chunk.length;
      }
      pending = { index: [], public: [], lower: [], body: [] }; bytes = 0;
      lock.touch();
    };
    for (const row of rows) {
      const lower = Buffer.from(row.lower, 'utf8');
      const body = row.body ? Buffer.from(row.body, 'utf8') : Buffer.alloc(0);
      const item = Buffer.from(`${JSON.stringify({ domain: row.domain, zone: row.zone, day: row.day, title: row.title,
        description: row.description, url: row.url, observedAt: row.observedAt })}\n`, 'utf8');
      const record = Buffer.alloc(RECORD_BYTES);
      record.writeDoubleLE(row.rid, 0); record.writeDoubleLE(row.endOffset, 8);
      record.writeUInt32LE(lower.length, 16); record.writeUInt32LE(item.length, 20); record.writeUInt32LE(body.length, 24);
      pending.index.push(record); pending.public.push(item); pending.lower.push(lower, Buffer.from([ROW_END])); pending.body.push(body);
      source.rows += 1; source.lowerBytes += lower.length + 1;
      bytes += lower.length + body.length + item.length;
      if (bytes >= BATCH_BYTES) flush();
    }
    flush();
    for (const part of PARTS) fs.fsyncSync(handles[part]);
  } finally { for (const part of PARTS) fs.closeSync(handles[part]); }
  source.offset = toOffset;
}

/**
 * Bring the day's reader snapshot up to the store's certified offsets. Called
 * by the store's writer after each advance; safe to repeat and to interrupt.
 */
function syncSnapshot(db, sites) {
  const dir = snapshotDir(sites);
  fs.mkdirSync(dir, { recursive: true });
  const lock = acquireLock(dir);
  if (!lock) return { skipped: 'locked' };
  try {
    const stored = db.prepare('SELECT name,generation,dev,ino,offset,captured_size AS size,updated_at AS updatedAt FROM projection_sources').all();
    const manifest = readManifest(dir);
    const next = { schema: SCHEMA, sources: [] };
    let appended = 0;
    for (const state of activeSources(stored)) {
      const prior = manifest?.sources.find(source => source.name === state.name && source.generation === state.generation && source.offset <= state.offset);
      const source = prior ? { ...prior } : { name: state.name, generation: state.generation, prefix: `${state.name}.${state.generation}`,
        offset: 0, rows: 0, lowerBytes: 0, index: 0, public: 0, lower: 0, body: 0 };
      const before = source.rows;
      if (Number(state.offset) > source.offset || !prior) appendRows(db, dir, source, Number(state.offset), lock);
      appended += source.rows - before;
      Object.assign(source, { dev: String(state.dev), ino: String(state.ino), size: Number(state.size), updatedAt: state.updatedAt });
      next.sources.push(source);
    }
    const body = JSON.stringify(next);
    if (!manifest || JSON.stringify(manifest) !== body) {
      const temporary = path.join(dir, `${MANIFEST}.${process.pid}.tmp`);
      fs.writeFileSync(temporary, body);
      fs.renameSync(temporary, path.join(dir, MANIFEST));
    }
    // Files of replaced generations and of a partial journal its final file superseded.
    const keep = new Set([MANIFEST, LOCK, ...next.sources.flatMap(source => PARTS.map(part => `${source.prefix}.${part}`))]);
    for (const name of fs.readdirSync(dir)) {
      if (keep.has(name)) continue;
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* another writer removed it */ }
    }
    return { sources: next.sources.length, appended };
  } finally { lock.release(); }
}

/** Drop a day's reader snapshot (a day that has left the reader's window). The store is untouched. */
function removeSnapshot(sites) {
  const dir = snapshotDir(sites);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function snapshotFiles(sites) {
  const dir = snapshotDir(sites);
  const manifest = readManifest(dir);
  return manifest ? manifest.sources.flatMap(source => PARTS.map(part => partPath(dir, source, part))) : [];
}

async function readRange(file, from, to) {
  const length = to - from;
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await handle.read(buffer, done, length - done, from + done);
      if (!bytesRead) throw new Error(`reader snapshot ${path.basename(file)} is shorter than its manifest`);
      done += bytesRead;
    }
    return buffer;
  } finally { await handle.close(); }
}

function gunzip(buffer) {
  if (!buffer.length) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => zlib.gunzip(buffer, (error, value) => (error ? reject(error) : resolve(value))));
}

/**
 * Rows a source gained between two manifest states (`from` null for a first
 * load), as one segment: the searchable text, the public lines, and where
 * each row's parts start.
 */
async function loadSegment(dir, source, from = null) {
  const start = from || { rows: 0, index: 0, public: 0, lower: 0, body: 0 };
  const [index, publicBytes, packed] = await Promise.all([
    readRange(partPath(dir, source, 'index'), start.index, source.index),
    readRange(partPath(dir, source, 'public'), start.public, source.public),
    readRange(partPath(dir, source, 'lower'), start.lower, source.lower),
  ]);
  // The text and its row starts live in shared memory so scan threads read them in place.
  const inflated = await gunzip(packed);
  const lower = Buffer.from(new SharedArrayBuffer(inflated.length));
  inflated.copy(lower);
  const count = source.rows - start.rows;
  if (index.length !== count * RECORD_BYTES) throw new Error('reader snapshot index does not match its manifest');
  const rids = new Float64Array(count), lowerStart = new Uint32Array(new SharedArrayBuffer(4 * (count + 1))), publicStart = new Uint32Array(count + 1), bodyStart = new Float64Array(count + 1);
  let lowerAt = 0, publicAt = 0, bodyAt = start.body;
  for (let row = 0; row < count; row += 1) {
    const at = row * RECORD_BYTES;
    rids[row] = index.readDoubleLE(at);
    lowerStart[row] = lowerAt; publicStart[row] = publicAt; bodyStart[row] = bodyAt;
    lowerAt += index.readUInt32LE(at + 16) + 1; publicAt += index.readUInt32LE(at + 20); bodyAt += index.readUInt32LE(at + 24);
  }
  lowerStart[count] = lowerAt; publicStart[count] = publicAt; bodyStart[count] = bodyAt;
  if (lowerAt !== lower.length || publicAt !== publicBytes.length || bodyAt !== source.body) throw new Error('reader snapshot rows do not match its manifest');
  return { count, rids, lower, lowerStart, public: publicBytes, publicStart, bodyStart, bodyFile: partPath(dir, source, 'body') };
}

/** Row numbers in [from, to) of the segment whose searchable text contains `needle`. */
function scanSegment(segment, needle, onRow, from = 0, to = segment.count) {
  const { lowerStart } = segment;
  const base = lowerStart[from], text = segment.lower.subarray(base, lowerStart[to]);
  let at = 0, row = from;
  while (row < to) {
    const found = text.indexOf(needle, at);
    if (found === -1) return;
    const hit = found + base;
    // Rows only move forward; find the one holding this byte.
    let low = row, high = to - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (lowerStart[middle] <= hit) low = middle; else high = middle - 1;
    }
    onRow(low);
    row = low + 1; at = lowerStart[row] - base;
  }
}

/** Cut a segment's rows into runs of about `bytes` of text, for side-by-side scanning. */
function segmentPieces(segment, bytes) {
  const pieces = [];
  for (let from = 0; from < segment.count;) {
    const limit = segment.lowerStart[from] + bytes;
    let low = from + 1, high = segment.count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (segment.lowerStart[middle] < limit) low = middle + 1; else high = middle;
    }
    pieces.push([from, low]); from = low;
  }
  return pieces;
}

module.exports = { DIR, SCHEMA, RECORD_BYTES, ROW_END, snapshotDir, readManifest, activeSources, syncSnapshot, removeSnapshot, snapshotFiles, loadSegment, scanSegment, segmentPieces, readRange };
