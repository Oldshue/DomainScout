'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');
const { isPublishable, publicItem } = require('./live-sites-public-projection');

const DB_FILE = 'public-feed-v2.sqlite';
const SCHEMA = 'domainscout.live-sites-public-store/v4';
const SOURCE_NAMES = ['observations.jsonl', 'observations.partial.jsonl', 'ct-launches.jsonl'];
const CHECK_BYTES = 64 * 1024;

function dbPath(universeDir, day) { return path.join(universeDir, day, 'sites', DB_FILE); }
function openStore(file, { readonly = false } = {}) {
  const db = new Database(file, { readonly, fileMustExist: readonly });
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -16384');
  db.pragma('mmap_size = 67108864');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const priorSchema = db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('schema');
    if (priorSchema && priorSchema !== SCHEMA) db.exec(`
      DROP TRIGGER IF EXISTS projection_rows_ai;
      DROP TRIGGER IF EXISTS projection_rows_ad;
      DROP TABLE IF EXISTS projection_search;
      DROP TABLE IF EXISTS projection_rows;
      DROP TABLE IF EXISTS projection_sources;
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS projection_sources (
        name TEXT PRIMARY KEY, generation TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL, offset INTEGER NOT NULL,
        captured_size INTEGER NOT NULL, captured_mtime_ms REAL NOT NULL,
        head_hash TEXT NOT NULL, check_start INTEGER NOT NULL, check_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_rows (
        source TEXT NOT NULL, generation TEXT NOT NULL, end_offset INTEGER NOT NULL,
        domain TEXT NOT NULL, zone TEXT NOT NULL, day TEXT NOT NULL,
        title TEXT NOT NULL, description TEXT, url TEXT NOT NULL, observed_at TEXT,
        title_key TEXT NOT NULL, body TEXT, search_lower TEXT NOT NULL,
        PRIMARY KEY(source, generation, domain)
      );
      CREATE INDEX IF NOT EXISTS projection_rows_source_observed ON projection_rows(source, generation, observed_at DESC, domain);
      CREATE INDEX IF NOT EXISTS projection_rows_source_zone ON projection_rows(source, generation, zone);
      CREATE VIRTUAL TABLE IF NOT EXISTS projection_search USING fts5(
        search_lower, content='projection_rows', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS projection_rows_ai AFTER INSERT ON projection_rows BEGIN
        INSERT INTO projection_search(rowid,search_lower) VALUES(new.rowid,new.search_lower);
      END;
      CREATE TRIGGER IF NOT EXISTS projection_rows_ad AFTER DELETE ON projection_rows BEGIN
        INSERT INTO projection_search(projection_search,rowid,search_lower) VALUES('delete',old.rowid,old.search_lower);
      END;
    `);
    db.prepare('INSERT INTO projection_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema', SCHEMA);
  }
  return db;
}

async function hashRange(file, start, length) {
  if (length <= 0) return crypto.createHash('sha256').digest('hex');
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return crypto.createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  } finally { await handle.close(); }
}

async function identity(file, stat, offset = stat.size) {
  const certified = Math.max(0, Math.min(offset, stat.size));
  const headLength = Math.min(CHECK_BYTES, certified);
  const checkStart = Math.max(0, Math.min(offset, stat.size) - CHECK_BYTES);
  const checkLength = Math.max(0, Math.min(offset, stat.size) - checkStart);
  return {
    dev: String(stat.dev), ino: String(stat.ino),
    headHash: await hashRange(file, 0, headLength),
    checkStart, checkHash: await hashRange(file, checkStart, checkLength),
  };
}

async function stateStillMatches(file, stat, state) {
  if (!state || String(stat.dev) !== state.dev || String(stat.ino) !== state.ino || stat.size < state.offset) return false;
  const current = await identity(file, stat, state.offset);
  return current.headHash === state.head_hash && current.checkStart === state.check_start && current.checkHash === state.check_hash;
}

async function advanceSource(db, sourcePath, day) {
  const name = path.basename(sourcePath);
  const stat = await fsp.stat(sourcePath);
  const state = db.prepare('SELECT * FROM projection_sources WHERE name=?').get(name);
  const incremental = await stateStillMatches(sourcePath, stat, state);
  const generation = incremental ? state.generation : crypto.randomUUID();
  let offset = incremental ? Number(state.offset) : 0;
  const startOffset = offset;
  const capturedSize = stat.size;
  const capturedIdentity = await identity(sourcePath, stat, capturedSize);
  if (capturedSize > offset) {
    const insert = db.prepare(`INSERT OR IGNORE INTO projection_rows
      (source,generation,end_offset,domain,zone,day,title,description,url,observed_at,title_key,body,search_lower)
      VALUES (@source,@generation,@endOffset,@domain,@zone,@day,@title,@description,@url,@observedAt,@titleKey,@body,@searchLower)`);
    const input = fs.createReadStream(sourcePath, { start: offset, end: capturedSize - 1 });
    let batch = [], consumed = offset;
    const flush = rows => db.transaction(values => { for (const row of values) insert.run(row); })(rows);
    let pending = Buffer.alloc(0);
    for await (const chunk of input) {
      const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0, end;
      while ((end = buffer.indexOf(10, start)) !== -1) {
        let lineBytes = buffer.subarray(start, end);
        if (lineBytes.at(-1) === 13) lineBytes = lineBytes.subarray(0, -1);
        consumed += end - start + 1;
        const line = lineBytes.toString('utf8');
        start = end + 1;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!isPublishable(record)) continue;
      const item = publicItem({ ...record, day: record.day || day });
      const body = typeof record.text === 'string' && record.text ? record.text : null;
      batch.push({ source: name, generation, endOffset: consumed, ...item, observedAt: item.observedAt,
        titleKey: item.title.trim().toLowerCase(), body,
        searchLower: `${item.domain}\n${item.title}\n${item.description || ''}\n${body || ''}`.toLowerCase() });
      if (batch.length >= 1000) { flush(batch); batch = []; await new Promise(resolve => setImmediate(resolve)); }
      }
      pending = Buffer.from(buffer.subarray(start));
    }
    if (batch.length) flush(batch);
    offset = consumed;
  }
  const after = await fsp.stat(sourcePath);
  const afterCapturedIdentity = await identity(sourcePath, after, capturedSize);
  if (capturedIdentity.dev !== afterCapturedIdentity.dev || capturedIdentity.ino !== afterCapturedIdentity.ino
    || capturedIdentity.headHash !== afterCapturedIdentity.headHash || capturedIdentity.checkHash !== afterCapturedIdentity.checkHash) {
    db.prepare('DELETE FROM projection_rows WHERE source=? AND generation=? AND end_offset>?').run(name, generation, startOffset);
    return { name, offset: startOffset, size: after.size, caughtUp: false, replacedDuringBuild: true, incremental };
  }
  const id = await identity(sourcePath, after, offset);
  const publish = db.prepare(`INSERT INTO projection_sources(name,generation,dev,ino,offset,captured_size,captured_mtime_ms,head_hash,check_start,check_hash,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET
    generation=excluded.generation,dev=excluded.dev,ino=excluded.ino,offset=excluded.offset,captured_size=excluded.captured_size,
    captured_mtime_ms=excluded.captured_mtime_ms,head_hash=excluded.head_hash,
    check_start=excluded.check_start,check_hash=excluded.check_hash,updated_at=excluded.updated_at
    WHERE excluded.dev != projection_sources.dev OR excluded.ino != projection_sources.ino
      OR excluded.offset > projection_sources.offset
      OR (excluded.offset = projection_sources.offset AND
        (excluded.head_hash != projection_sources.head_hash OR excluded.check_hash != projection_sources.check_hash))`);
  const published = db.transaction(() => {
    const result = publish.run(name, generation, id.dev, id.ino, offset, after.size, after.mtimeMs, id.headHash, id.checkStart, id.checkHash, new Date().toISOString());
    if (result.changes) db.prepare('DELETE FROM projection_rows WHERE source=? AND generation!=?').run(name, generation);
    return result.changes > 0;
  })();
  return { name, offset, size: after.size, caughtUp: offset === after.size, incremental, published };
}

async function advanceDay({ universeDir, day }) {
  const sites = path.join(universeDir, day, 'sites');
  await fsp.mkdir(sites, { recursive: true });
  const db = openStore(dbPath(universeDir, day));
  try {
    let observation = 'observations.jsonl';
    try { await fsp.access(path.join(sites, observation)); }
    catch { observation = 'observations.partial.jsonl'; }
    const wanted = [observation, 'ct-launches.jsonl'];
    const results = [];
    for (const name of wanted) {
      try { results.push(await advanceSource(db, path.join(sites, name), day)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (observation === 'observations.jsonl') db.transaction(() => {
      db.prepare('DELETE FROM projection_rows WHERE source=?').run('observations.partial.jsonl');
      db.prepare('DELETE FROM projection_sources WHERE name=?').run('observations.partial.jsonl');
    })();
    return { day, results };
  } finally { db.close(); }
}

module.exports = { DB_FILE, SCHEMA, SOURCE_NAMES, dbPath, openStore, advanceSource, advanceDay, identity, stateStillMatches };
