const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  readRefreshJournal,
  validateSnapshotCandidate,
  writeRefreshEvent,
} = require('./snapshot-health');

const DATA_BASE_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');

const GODADDY_CACHE_FILES = {
  'godaddy-auction': 'godaddy-auction-cache.json',
  'godaddy-closeout': 'godaddy-closeout-cache.json',
};

const SNAPSHOT_FORMAT = 'compact-columns-v1';
const FULL_COLUMNS = [
  'domain', 'tld', 'stream', 'source', 'auction_price', 'auction_end', 'auction_url',
  'age_years', 'bid_count', 'length', 'has_numbers', 'has_hyphens', 'tlds_taken',
  'source_feed', 'metrics',
];
const INDEX_COLUMNS = [
  'domain', 'tld', 'stream', 'source', 'auction_price', 'auction_end', 'auction_url',
  'age_years', 'bid_count', 'length', 'has_numbers', 'has_hyphens', 'tlds_taken',
];
const REFRESH_JOURNAL_PATH = path.join(DATA_BASE_PATH, 'external-snapshot-refresh.json');

const memoryCache = new Map();
const domainMapCache = new Map();
const inventoryIndexCache = new Map();

function isGoDaddyInventoryStream(stream) {
  return Object.prototype.hasOwnProperty.call(GODADDY_CACHE_FILES, stream);
}

function cachePathForStream(stream) {
  const file = GODADDY_CACHE_FILES[stream];
  if (!file) return null;
  return path.join(DATA_BASE_PATH, file);
}

function metaPathForStream(stream) {
  const cachePath = cachePathForStream(stream);
  return cachePath ? `${cachePath}.meta.json` : null;
}

function uiIndexPathForStream(stream) {
  const cachePath = cachePathForStream(stream);
  return cachePath ? `${cachePath}.ui-index.json` : null;
}

function cacheDomainRow(domain) {
  return {
    domain: domain.domain,
    tld: domain.tld,
    stream: domain.stream,
    source: domain.source,
    auction_price: domain.auction_price ?? null,
    auction_end: domain.auction_end ?? null,
    auction_url: domain.auction_url ?? null,
    age_years: domain.age_years ?? null,
    bid_count: domain.bid_count ?? 0,
    length: domain.length,
    has_numbers: domain.has_numbers ? 1 : 0,
    has_hyphens: domain.has_hyphens ? 1 : 0,
    expiry_date: null,
    drop_date: null,
    tlds_taken: domain.tlds_taken ?? null,
    wayback_snapshots: null,
    source_feed: domain.source_feed || null,
    metrics: domain.metrics || null,
  };
}

function cacheDomainIndexRow(domain) {
  return {
    domain: domain.domain,
    tld: domain.tld,
    stream: domain.stream,
    source: domain.source,
    auction_price: domain.auction_price ?? null,
    auction_end: domain.auction_end ?? null,
    auction_url: domain.auction_url ?? null,
    age_years: domain.age_years ?? null,
    bid_count: domain.bid_count ?? 0,
    length: domain.length,
    has_numbers: domain.has_numbers ? 1 : 0,
    has_hyphens: domain.has_hyphens ? 1 : 0,
    tlds_taken: domain.tlds_taken ?? null,
  };
}

function compareIndexRowsByAuctionEnd(a, b) {
  const at = new Date(a.auction_end || '').getTime();
  const bt = new Date(b.auction_end || '').getTime();
  const aMissing = !Number.isFinite(at);
  const bMissing = !Number.isFinite(bt);
  if (aMissing && bMissing) return String(a.domain || '').localeCompare(String(b.domain || ''));
  if (aMissing) return 1;
  if (bMissing) return -1;
  return (at - bt) || String(a.domain || '').localeCompare(String(b.domain || ''));
}

function rowToTuple(row, columns) {
  return columns.map(column => row[column] ?? null);
}

function tupleToRow(tuple, columns) {
  const row = {};
  for (let index = 0; index < columns.length; index += 1) row[columns[index]] = tuple[index] ?? null;
  row.bid_count = row.bid_count ?? 0;
  row.has_numbers = row.has_numbers ? 1 : 0;
  row.has_hyphens = row.has_hyphens ? 1 : 0;
  return row;
}

// Write the large snapshot incrementally. Repeating object keys made the old cache
// approach Node's maximum string length and JSON.stringify eventually failed before
// an atomic rename. Column tuples shrink the file substantially, while chunked writes
// ensure no feed size can require one giant JavaScript string during publication.
function writeCompactPayloadFile(filePath, header, rows, columns) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const hash = crypto.createHash('sha256');
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    const write = chunk => {
      fs.writeSync(fd, chunk);
      hash.update(chunk);
    };
    write(`${JSON.stringify({ ...header, format: SNAPSHOT_FORMAT, columns }).slice(0, -1)},"domains":[`);
    let chunk = '';
    for (let index = 0; index < rows.length; index += 1) {
      chunk += `${index ? ',' : ''}${JSON.stringify(rowToTuple(rows[index], columns))}`;
      if (chunk.length >= 2 * 1024 * 1024) {
        write(chunk);
        chunk = '';
      }
    }
    if (chunk) write(chunk);
    write(']}');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
    const stat = fs.statSync(filePath);
    return { bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: hash.digest('hex') };
  } catch (err) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) {}
    throw err;
  }
}

function inflatePayload(payload) {
  if (!payload || !Array.isArray(payload.domains)) return payload;
  if (payload.format !== SNAPSHOT_FORMAT || !Array.isArray(payload.columns)) return payload;
  return {
    ...payload,
    domains: payload.domains.map(tuple => tupleToRow(tuple, payload.columns)),
  };
}

function writeGoDaddyInventoryUiIndex(stream, domains, generatedAt) {
  const indexPath = uiIndexPathForStream(stream);
  if (!indexPath) return null;
  const rows = domains.map(cacheDomainIndexRow).sort(compareIndexRowsByAuctionEnd);
  return writeCompactPayloadFile(indexPath, {
    stream,
    generatedAt,
    count: rows.length,
    sortedBy: 'auction_end_asc',
  }, rows, INDEX_COLUMNS);
}

function writeGoDaddyInventoryCache(stream, domains, options = {}) {
  const cachePath = cachePathForStream(stream);
  if (!cachePath) return null;
  fs.mkdirSync(DATA_BASE_PATH, { recursive: true });
  const generatedAt = options.generatedAt || new Date().toISOString();
  const rows = domains.map(cacheDomainRow);
  const cacheFile = writeCompactPayloadFile(cachePath, {
    stream,
    generatedAt,
    count: rows.length,
  }, rows, FULL_COLUMNS);
  const indexFile = writeGoDaddyInventoryUiIndex(stream, domains, generatedAt);
  const metaPath = metaPathForStream(stream);
  if (metaPath) {
    const metaTmpPath = `${metaPath}.${process.pid}.tmp`;
    fs.writeFileSync(metaTmpPath, JSON.stringify({
      stream,
      generatedAt,
      count: domains.length,
      mtimeMs: cacheFile.mtimeMs,
      snapshotFormat: SNAPSHOT_FORMAT,
      snapshotBytes: cacheFile.bytes,
      snapshotSha256: cacheFile.sha256,
      indexBytes: indexFile?.bytes || null,
      indexSha256: indexFile?.sha256 || null,
      evidence: options.evidence || null,
      validation: options.validation || null,
    }, null, 2));
    fs.renameSync(metaTmpPath, metaPath);
  }
  memoryCache.delete(stream);
  domainMapCache.delete(stream);
  inventoryIndexCache.delete(stream);
  return cachePath;
}

function readGoDaddyInventoryCache(stream) {
  const cachePath = cachePathForStream(stream);
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  const stat = fs.statSync(cachePath);
  const cached = memoryCache.get(stream);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.payload;
  const payload = inflatePayload(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
  memoryCache.set(stream, { mtimeMs: stat.mtimeMs, payload });
  return payload;
}

function readGoDaddyInventoryDomainMap(stream) {
  const cachePath = cachePathForStream(stream);
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  const stat = fs.statSync(cachePath);
  const cached = domainMapCache.get(stream);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.map;

  const payload = readGoDaddyInventoryCache(stream);
  if (!payload || !Array.isArray(payload.domains)) return null;
  const map = new Map(payload.domains.map(row => [row.domain, row]));
  domainMapCache.set(stream, { mtimeMs: stat.mtimeMs, map });
  return map;
}

function readGoDaddyInventoryIndex(stream) {
  const cachePath = cachePathForStream(stream);
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  const stat = fs.statSync(cachePath);
  const indexPath = uiIndexPathForStream(stream);
  const cached = inventoryIndexCache.get(stream);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.index;

  let generatedAt = null;
  let rows = null;
  let compactRows = null;
  let compactColumns = null;
  if (indexPath && fs.existsSync(indexPath)) {
    const indexStat = fs.statSync(indexPath);
    if (indexStat.mtimeMs >= stat.mtimeMs) {
      const indexPayload = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (indexPayload && Array.isArray(indexPayload.domains)) {
        generatedAt = indexPayload.generatedAt || null;
        if (indexPayload.format === SNAPSHOT_FORMAT && Array.isArray(indexPayload.columns)) {
          // Keep the production index in its compact tuple representation. Expanding
          // ~600k tuples into property-heavy objects made a cold desktop start spend
          // minutes in allocation/GC before it could answer even a health request.
          // The query layer materializes only the page rows it returns.
          compactRows = indexPayload.domains;
          compactColumns = indexPayload.columns;
        } else {
          rows = indexPayload.domains;
        }
      }
    }
  }

  if (!rows && !compactRows) {
    const rawPayload = readGoDaddyInventoryCache(stream);
    if (!rawPayload || !Array.isArray(rawPayload.domains)) return null;
    generatedAt = rawPayload.generatedAt || null;
    rows = rawPayload.domains.map(cacheDomainIndexRow).sort(compareIndexRowsByAuctionEnd);
    if (indexPath) {
      try {
        const tmpPath = `${indexPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify({
          stream,
          generatedAt,
          count: rows.length,
          sortedBy: 'auction_end_asc',
          domains: rows,
        }));
        fs.renameSync(tmpPath, indexPath);
      } catch (_) {}
    }
  }

  const index = {
    stream,
    generatedAt,
    count: compactRows ? compactRows.length : rows.length,
  };

  if (compactRows) {
    const compactColumnIndex = Object.fromEntries(compactColumns.map((column, position) => [column, position]));
    let materializedRows = null;
    let materializedEndIndex = null;
    Object.assign(index, {
      compactRows,
      compactColumns,
      compactColumnIndex,
      sortedBy: 'auction_end_asc',
    });
    // Compatibility accessors preserve every non-default query path. The hot desktop
    // auction path in godaddy-query.js deliberately never touches these getters.
    Object.defineProperty(index, 'rows', {
      enumerable: false,
      get() {
        if (!materializedRows) materializedRows = compactRows.map(tuple => tupleToRow(tuple, compactColumns));
        return materializedRows;
      },
    });
    Object.defineProperty(index, 'byAuctionEndAsc', {
      enumerable: false,
      get() {
        if (!materializedEndIndex) {
          materializedEndIndex = [];
          index.rows.forEach((row, position) => {
            const endMs = new Date(row.auction_end || '').getTime();
            if (Number.isFinite(endMs)) materializedEndIndex.push({ row, index: position, endMs });
          });
        }
        return materializedEndIndex;
      },
    });
  } else {
    const byAuctionEndAsc = [];
    rows.forEach((row, position) => {
      const endMs = new Date(row.auction_end || '').getTime();
      if (Number.isFinite(endMs)) byAuctionEndAsc.push({ row, index: position, endMs });
    });
    Object.assign(index, { rows, byAuctionEndAsc });
  }
  inventoryIndexCache.set(stream, { mtimeMs: stat.mtimeMs, index });
  return index;
}

function getGoDaddyInventoryCacheMeta(stream) {
  const cachePath = cachePathForStream(stream);
  if (!cachePath) return null;
  const lastAttempt = readRefreshJournal(REFRESH_JOURNAL_PATH)[stream] || null;
  if (!fs.existsSync(cachePath)) {
    return {
      stream,
      generatedAt: null,
      count: 0,
      mtimeMs: null,
      ageMs: Infinity,
      evidence: null,
      validation: null,
      snapshotFormat: null,
      snapshotBytes: 0,
      snapshotSha256: null,
      lastAttempt,
    };
  }
  const stat = fs.statSync(cachePath);
  let meta = null;
  const metaPath = metaPathForStream(stream);
  if (metaPath && fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
  }
  const generatedAt = meta?.generatedAt || null;
  const generatedAtMs = generatedAt ? new Date(generatedAt).getTime() : NaN;
  const ageMs = Number.isFinite(generatedAtMs) ? Date.now() - generatedAtMs : Date.now() - stat.mtimeMs;
  return {
    stream,
    generatedAt,
    count: meta?.count || 0,
    mtimeMs: stat.mtimeMs,
    ageMs,
    evidence: meta?.evidence || null,
    validation: meta?.validation || null,
    snapshotFormat: meta?.snapshotFormat || 'legacy-object-v1',
    snapshotBytes: meta?.snapshotBytes || stat.size,
    snapshotSha256: meta?.snapshotSha256 || null,
    lastAttempt,
  };
}

function validateGoDaddyInventorySnapshot(stream, domains, options = {}) {
  const previous = getGoDaddyInventoryCacheMeta(stream);
  return validateSnapshotCandidate(domains, {
    minCount: options.minCount || (stream === 'godaddy-auction' ? 10000 : 1000),
    previousCount: previous?.count || 0,
    maxDropFraction: options.maxDropFraction ?? 0.6,
    identityField: 'domain',
    timestampField: 'auction_end',
    minTimestampRatio: options.minTimestampRatio ?? 0.98,
  });
}

function recordGoDaddyRefreshEvent(stream, event) {
  fs.mkdirSync(DATA_BASE_PATH, { recursive: true });
  return writeRefreshEvent(REFRESH_JOURNAL_PATH, stream, event);
}

module.exports = {
  isGoDaddyInventoryStream,
  getGoDaddyInventoryCacheMeta,
  readGoDaddyInventoryDomainMap,
  readGoDaddyInventoryCache,
  readGoDaddyInventoryIndex,
  recordGoDaddyRefreshEvent,
  validateGoDaddyInventorySnapshot,
  writeGoDaddyInventoryCache,
  _test: {
    FULL_COLUMNS,
    INDEX_COLUMNS,
    SNAPSHOT_FORMAT,
    inflatePayload,
    rowToTuple,
    tupleToRow,
    writeCompactPayloadFile,
  },
};
