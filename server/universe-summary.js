'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const UNIVERSE_SUMMARY_DB_FILE = 'universe_summary.db';
const UNIVERSE_SUMMARY_DIR = 'universe-summary';
const UNIVERSE_SUMMARY_SCHEMA = 'domainscout.universe-summary/v1';
const META_TRAILER_PREFIX = '#meta\t';

function isValidLabel(label) {
  return label.length > 0 && !label.includes('.') && !/\s/.test(label);
}

function reverseString(s) {
  return s.split('').reverse().join('');
}

function deriveDayFromTapePath(tapePath) {
  const match = path.basename(tapePath).match(/universe-summary-(\d{4}-\d{2}-\d{2})\.tsv\.gz$/);
  return match ? match[1] : null;
}

class LineSource {
  constructor(filePath, tld) {
    this.filePath = filePath;
    this.tld = tld;
    this.queue = [];
    this.buffer = '';
    this.done = false;
    this.stream = null;
    this.iterator = null;
  }

  _ensureStream() {
    if (!this.stream) {
      this.stream = fs.createReadStream(this.filePath).pipe(zlib.createGunzip());
      this.stream.setEncoding('utf8');
      this.iterator = this.stream[Symbol.asyncIterator]();
    }
  }

  peek() {
    return this.queue.length ? this.queue[0] : null;
  }

  take() {
    return this.queue.shift();
  }

  async fill() {
    if (this.queue.length || this.done) return;
    this._ensureStream();
    while (!this.queue.length) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.done = true;
        if (this.buffer) {
          const remaining = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
          if (remaining) this.queue.push(remaining);
        }
        this.buffer = '';
        return;
      }
      this.buffer += value;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      for (const line of lines) {
        this.queue.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
    }
  }
}

class MinHeap {
  constructor(compare) {
    this.compare = compare;
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(items[i], items[parent]) < 0) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else break;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && this.compare(items[l], items[smallest]) < 0) smallest = l;
        if (r < n && this.compare(items[r], items[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

async function buildUniverseSummaryTape({ namesDir, day, outDir, minZones = 2, log = console }) {
  const files = fs.readdirSync(namesDir).filter(f => f.endsWith('.names.gz'));
  const sources = files.map(f => new LineSource(path.join(namesDir, f), f.slice(0, -'.names.gz'.length)));
  const zoneLabelCounts = {};
  for (const s of sources) zoneLabelCounts[s.tld] = 0;

  await fs.promises.mkdir(outDir, { recursive: true });
  const tapePath = path.join(outDir, `universe-summary-${day}.tsv.gz`);
  const metaPath = path.join(outDir, `universe-summary-${day}.meta.json`);

  const writeStream = fs.createWriteStream(tapePath);
  const gzip = zlib.createGzip();
  gzip.pipe(writeStream);

  async function writeLine(line) {
    if (!gzip.write(line)) {
      await new Promise(resolve => gzip.once('drain', resolve));
    }
  }

  for (const s of sources) await s.fill();

  const heap = new MinHeap((a, b) => {
    const lineCmp = a.peek() < b.peek() ? -1 : a.peek() > b.peek() ? 1 : 0;
    if (lineCmp !== 0) return lineCmp;
    return a.tld < b.tld ? -1 : a.tld > b.tld ? 1 : 0;
  });
  for (const s of sources) {
    if (s.peek() !== null) heap.push(s);
  }

  let namesTotal = 0;
  let namesMulti = 0;

  while (heap.size) {
    const first = heap.pop();
    const label = first.peek();
    const group = [first];
    while (heap.size && heap.items[0].peek() === label) {
      group.push(heap.pop());
    }

    if (isValidLabel(label)) {
      namesTotal += 1;
      for (const s of group) zoneLabelCounts[s.tld] += 1;
      if (group.length >= minZones) {
        namesMulti += 1;
        const tlds = group.map(s => `.${s.tld}`).sort();
        await writeLine(`${label}\t${group.length}\t${tlds.join(',')}\n`);
      }
    }

    for (const s of group) {
      s.take();
      if (s.peek() === null) await s.fill();
      if (s.peek() !== null) heap.push(s);
    }
  }

  const meta = {
    schema: UNIVERSE_SUMMARY_SCHEMA,
    day,
    minZones,
    zones: sources.length,
    namesTotal,
    namesMulti,
    zoneLabelCounts,
    builtAt: new Date().toISOString(),
  };
  // The tape describes itself: a trailer line carries the meta so an importer
  // that only receives the tape (HTTP import, S3 copy) still learns every zone.
  await writeLine(`${META_TRAILER_PREFIX}${JSON.stringify(meta)}\n`);
  gzip.end();
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));

  if (log && typeof log.log === 'function') {
    log.log(`universe-summary: built tape for ${day} (${sources.length} zones, ${namesMulti} names)`);
  }

  return { ...meta, tapePath, metaPath };
}

function rmIfExists(...paths) {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

async function importUniverseSummaryTape({ tapePath, dataDir, log = console }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const buildingPath = path.join(dataDir, `${UNIVERSE_SUMMARY_DB_FILE}.building`);
  const finalPath = path.join(dataDir, UNIVERSE_SUMMARY_DB_FILE);
  rmIfExists(buildingPath, `${buildingPath}-wal`, `${buildingPath}-shm`);

  const sidecarPath = tapePath.replace(/\.tsv\.gz$/, '.meta.json');
  const sidecarMeta = fs.existsSync(sidecarPath) ? JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) : null;

  const db = new Database(buildingPath);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -1000000');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE zones (tld TEXT PRIMARY KEY, label_count INTEGER);
    CREATE TABLE name_summary (
      base_name TEXT PRIMARY KEY,
      base_name_rev TEXT NOT NULL,
      tld_count INTEGER NOT NULL,
      tld_list TEXT NOT NULL
    ) WITHOUT ROWID;
  `);

  const insertRow = db.prepare('INSERT INTO name_summary (base_name, base_name_rev, tld_count, tld_list) VALUES (?, ?, ?, ?)');
  const insertBatch = db.transaction(rows => {
    for (const row of rows) insertRow.run(row[0], row[1], row[2], row[3]);
  });

  // Stream the tape: a production tape decodes to ~700 MB of text, past V8's
  // single-string ceiling, so it is never materialized whole.
  let batch = [];
  let namesMulti = 0;
  let embeddedMeta = null;
  const pushLine = line => {
    if (!line) return;
    if (line.charCodeAt(0) === 35) { // '#'
      if (line.startsWith(META_TRAILER_PREFIX)) {
        try { embeddedMeta = JSON.parse(line.slice(META_TRAILER_PREFIX.length)); } catch (_) { embeddedMeta = null; }
      }
      return;
    }
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab1 <= 0 || tab2 <= tab1) return;
    const label = line.slice(0, tab1);
    const count = Number(line.slice(tab1 + 1, tab2));
    const tldList = line.slice(tab2 + 1);
    batch.push([label, reverseString(label), count, tldList]);
    namesMulti += 1;
    if (batch.length >= 50000) {
      insertBatch(batch);
      batch = [];
    }
  };
  const input = fs.createReadStream(tapePath).pipe(zlib.createGunzip());
  input.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk;
    let start = 0;
    for (;;) {
      const end = buffer.indexOf('\n', start);
      if (end === -1) break;
      pushLine(buffer.slice(start, end));
      start = end + 1;
    }
    buffer = buffer.slice(start);
  }
  pushLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
  if (batch.length) insertBatch(batch);

  db.exec('CREATE INDEX idx_us_rev ON name_summary(base_name_rev)');
  db.exec('CREATE INDEX idx_us_count ON name_summary(tld_count DESC, base_name)');
  db.exec('CREATE INDEX idx_us_rev_count ON name_summary(base_name_rev, tld_count)');

  const tapeMeta = embeddedMeta || sidecarMeta;
  const zonesCount = tapeMeta ? tapeMeta.zones : 0;
  if (tapeMeta && tapeMeta.zoneLabelCounts) {
    const insertZone = db.prepare('INSERT INTO zones (tld, label_count) VALUES (?, ?)');
    const insertZones = db.transaction(entries => {
      for (const [tld, count] of entries) insertZone.run(tld.startsWith('.') ? tld : `.${tld}`, count);
    });
    insertZones(Object.entries(tapeMeta.zoneLabelCounts));
  }

  const day = tapeMeta ? tapeMeta.day : deriveDayFromTapePath(tapePath);
  const minZones = tapeMeta ? tapeMeta.minZones : null;
  const namesTotal = tapeMeta ? tapeMeta.namesTotal : null;
  const importedAt = new Date().toISOString();
  const builtAt = tapeMeta ? tapeMeta.builtAt : importedAt;

  const metaRows = [
    ['day', day],
    ['min_zones', String(minZones)],
    ['zones', String(zonesCount)],
    ['names_total', String(namesTotal)],
    ['names_multi', String(namesMulti)],
    ['built_at', builtAt],
    ['imported_at', importedAt],
    ['schema', UNIVERSE_SUMMARY_SCHEMA],
    ['status', 'ready'],
  ];
  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  const insertMetaAll = db.transaction(rows => { for (const r of rows) insertMeta.run(r[0], r[1]); });
  insertMetaAll(metaRows);

  db.pragma('journal_mode = WAL');
  db.close();

  rmIfExists(finalPath, `${finalPath}-wal`, `${finalPath}-shm`);
  fs.renameSync(buildingPath, finalPath);
  rmIfExists(`${buildingPath}-wal`, `${buildingPath}-shm`);

  if (log && typeof log.log === 'function') {
    log.log(`universe-summary: imported ${namesMulti} names into ${finalPath}`);
  }

  return { day, minZones, zones: zonesCount, namesTotal, namesMulti, builtAt, importedAt, path: finalPath };
}

function spawnUniverseSummaryImport({ tapePath, dataDir, log = console }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'universe-summary.js');
    const child = spawn(process.execPath, [scriptPath, 'import', tapePath, dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => {
      stderr += d;
      if (log && typeof log.error === 'function') log.error(d.toString());
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`universe-summary import failed (exit ${code}): ${(stderr || stdout).trim()}`));
        return;
      }
      const lines = stdout.trim().split('\n');
      const last = lines[lines.length - 1];
      try {
        resolve(JSON.parse(last));
      } catch (err) {
        reject(new Error(`universe-summary import: could not parse output: ${last}`));
      }
    });
  });
}

const summaryCache = new Map();

function openUniverseSummary(dataDir) {
  const dbPath = path.join(dataDir, UNIVERSE_SUMMARY_DB_FILE);
  let stat;
  try {
    stat = fs.statSync(dbPath);
  } catch (err) {
    summaryCache.delete(dataDir);
    return null;
  }

  const cached = summaryCache.get(dataDir);
  if (cached && cached.ino === stat.ino && cached.mtimeMs === stat.mtimeMs) {
    return cached.handle;
  }
  if (cached && cached.rawDb) {
    try { cached.rawDb.close(); } catch (err) { /* ignore */ }
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const metaMap = {};
  for (const row of db.prepare('SELECT key, value FROM meta').all()) metaMap[row.key] = row.value;
  if (metaMap.status !== 'ready') {
    db.close();
    summaryCache.delete(dataDir);
    return null;
  }

  const statusObj = {
    source: 'universe-summary',
    day: metaMap.day,
    minZones: metaMap.min_zones !== undefined ? Number(metaMap.min_zones) : null,
    zones: Number(metaMap.zones),
    namesTotal: metaMap.names_total !== undefined ? Number(metaMap.names_total) : null,
    namesMulti: Number(metaMap.names_multi),
    builtAt: metaMap.built_at,
    importedAt: metaMap.imported_at,
    path: dbPath,
  };

  let zoneSet = null;

  function runQuery(term, mode, opts = {}) {
    const { limit, includeTldList = true } = opts;
    const cols = 'base_name, tld_count, tld_list';
    let sql;
    let params;
    if (mode === 'prefix') {
      sql = 'SELECT ' + cols + ' FROM name_summary WHERE base_name >= ? AND base_name < ? ORDER BY tld_count DESC, base_name ASC';
      params = [term, term + '￿'];
    } else if (mode === 'suffix') {
      const rev = reverseString(term);
      sql = 'SELECT ' + cols + ' FROM name_summary WHERE base_name_rev >= ? AND base_name_rev < ? ORDER BY tld_count DESC, base_name ASC';
      params = [rev, rev + '￿'];
    } else if (mode === 'contains') {
      sql = 'SELECT ' + cols + ' FROM name_summary WHERE base_name LIKE ? ORDER BY tld_count DESC, base_name ASC';
      params = ['%' + term + '%'];
    } else {
      throw new Error(`Unknown query mode: ${mode}`);
    }
    if (limit) {
      sql += ' LIMIT ?';
      params.push(Math.min(Number(limit), 100000));
    }
    const rows = db.prepare(sql).all(...params);
    if (!includeTldList) return rows.map(r => ({ base_name: r.base_name, tld_count: r.tld_count, tld_list: null }));
    return rows;
  }

  const handle = {
    status() { return statusObj; },
    zoneTldSet() {
      if (!zoneSet) zoneSet = new Set(db.prepare('SELECT tld FROM zones').all().map(r => r.tld));
      return zoneSet;
    },
    query: runQuery,
    count(term, mode) {
      if (mode === 'prefix') {
        return db.prepare('SELECT COUNT(*) AS n FROM name_summary WHERE base_name >= ? AND base_name < ?').get(term, term + '￿').n;
      }
      if (mode === 'suffix') {
        const rev = reverseString(term);
        return db.prepare('SELECT COUNT(*) AS n FROM name_summary WHERE base_name_rev >= ? AND base_name_rev < ?').get(rev, rev + '￿').n;
      }
      return null;
    },
    nameZones(baseName) {
      const row = db.prepare('SELECT tld_list FROM name_summary WHERE base_name = ?').get(baseName);
      if (!row) return { exact: false, tlds: [] };
      return { exact: true, tlds: row.tld_list.split(',') };
    },
    lookupMany(baseNames) {
      const result = new Map();
      const names = Array.from(baseNames);
      for (let i = 0; i < names.length; i += 900) {
        const batch = names.slice(i, i + 900);
        const placeholders = batch.map(() => '?').join(',');
        const rows = db.prepare(`SELECT base_name, tld_count, tld_list FROM name_summary WHERE base_name IN (${placeholders})`).all(...batch);
        for (const row of rows) result.set(row.base_name, { tld_count: row.tld_count, tld_list: row.tld_list });
      }
      return result;
    },
    close() {
      db.close();
      summaryCache.delete(dataDir);
    },
  };

  summaryCache.set(dataDir, { handle, ino: stat.ino, mtimeMs: stat.mtimeMs, rawDb: db });
  return handle;
}

module.exports = {
  META_TRAILER_PREFIX,
  UNIVERSE_SUMMARY_DB_FILE,
  UNIVERSE_SUMMARY_DIR,
  UNIVERSE_SUMMARY_SCHEMA,
  buildUniverseSummaryTape,
  importUniverseSummaryTape,
  spawnUniverseSummaryImport,
  openUniverseSummary,
};
