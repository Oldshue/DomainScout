'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  evaluateSnapshotHealth,
  readRefreshJournal,
  validateSnapshotCandidate,
  writeRefreshEvent,
} = require('./snapshot-health');

const DATA_BASE_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const SNAPSHOT_ROOT = path.join(DATA_BASE_PATH, 'provider-snapshots');
const REFRESH_JOURNAL_PATH = path.join(DATA_BASE_PATH, 'external-snapshot-refresh.json');
const FORMAT = 'provider-compact-columns-v2';
const POINTER_VERSION = 1;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_RETENTION = 2;
const DEFAULT_MIN_FREE_BYTES = 256 * 1024 * 1024;

const descriptors = new Map();
const indexCache = new Map();
const payloadCache = new Map();
const domainMapCache = new Map();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertSafeSegment(value, label) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(value || ''))) {
    throw new Error(`${label} must be a bounded lowercase identifier`);
  }
  return String(value);
}

function assertPhysicalDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe snapshot directory: ${dirPath}`);
  try { fs.chmodSync(dirPath, 0o700); } catch (_) {}
}

function fsyncDirectory(dirPath) {
  let fd = null;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function registerLargeProviderStream(input) {
  if (!input || typeof input !== 'object') throw new Error('provider snapshot descriptor is required');
  const stream = assertSafeSegment(input.stream, 'stream');
  const columns = [...new Set((input.columns || []).map(String))];
  if (!columns.includes('domain') || !columns.includes('auction_end') || columns.length < 3) {
    throw new Error(`provider snapshot ${stream} requires domain and auction_end columns`);
  }
  const descriptor = Object.freeze({
    stream,
    columns: Object.freeze(columns),
    minCount: Math.max(1, Number(input.minCount) || 1),
    maxAgeMs: Math.max(60_000, Number(input.maxAgeMs) || 2 * 60 * 60 * 1000),
    maxDropFraction: Math.min(1, Math.max(0, Number(input.maxDropFraction) || 0.6)),
    minTimestampRatio: Math.min(1, Math.max(0, Number(input.minTimestampRatio) || 0.98)),
    identityField: String(input.identityField || 'domain'),
    timestampField: String(input.timestampField || 'auction_end'),
    excludeEnded: input.excludeEnded === true,
    maxSnapshotBytes: Math.max(1024, Number(input.maxSnapshotBytes) || DEFAULT_MAX_BYTES),
    retainGenerations: Math.max(1, Math.min(4, Number(input.retainGenerations) || DEFAULT_RETENTION)),
    legacyFileStem: input.legacyFileStem ? assertSafeSegment(input.legacyFileStem, 'legacyFileStem') : null,
  });
  const prior = descriptors.get(stream);
  if (prior && JSON.stringify(prior) !== JSON.stringify(descriptor)) {
    throw new Error(`provider snapshot descriptor already registered for ${stream}`);
  }
  descriptors.set(stream, descriptor);
  return descriptor;
}

function getLargeProviderDescriptor(stream) {
  return descriptors.get(String(stream || '')) || null;
}

function isLargeProviderStream(stream) {
  return descriptors.has(String(stream || ''));
}

function listLargeProviderStreams() {
  return [...descriptors.keys()];
}

function streamPaths(stream) {
  const descriptor = getLargeProviderDescriptor(stream);
  if (!descriptor) return null;
  const root = path.join(SNAPSHOT_ROOT, descriptor.stream);
  return {
    descriptor,
    root,
    generations: path.join(root, 'generations'),
    pointer: path.join(root, 'current.json'),
  };
}

function rowToTuple(row, columns) {
  return columns.map(column => row?.[column] ?? null);
}

function tupleToRow(tuple, columns) {
  const row = {};
  for (let index = 0; index < columns.length; index += 1) row[columns[index]] = tuple[index] ?? null;
  row.bid_count = row.bid_count ?? 0;
  row.has_numbers = row.has_numbers ? 1 : 0;
  row.has_hyphens = row.has_hyphens ? 1 : 0;
  return row;
}

function compareAuctionEnd(a, b) {
  const at = Date.parse(a?.auction_end || '');
  const bt = Date.parse(b?.auction_end || '');
  if (!Number.isFinite(at) && !Number.isFinite(bt)) return String(a?.domain || '').localeCompare(String(b?.domain || ''));
  if (!Number.isFinite(at)) return 1;
  if (!Number.isFinite(bt)) return -1;
  return (at - bt) || String(a?.domain || '').localeCompare(String(b?.domain || ''));
}

function estimateSnapshotBytes(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) return 1024;
  const sampleCount = Math.min(rows.length, 2_000);
  const stride = Math.max(1, Math.floor(rows.length / sampleCount));
  let sampled = 0;
  let bytes = 256;
  for (let index = 0; index < rows.length && sampled < sampleCount; index += stride) {
    bytes += Buffer.byteLength(JSON.stringify(rowToTuple(rows[index], columns))) + 1;
    sampled += 1;
  }
  return Math.ceil((bytes / Math.max(1, sampled)) * rows.length * 1.15) + 4096;
}

function publicationCapacity({ freeBytes, totalBytes, estimatedBytes, minFreeBytes = DEFAULT_MIN_FREE_BYTES }) {
  // A percentage protects small attached volumes; the 1 GiB ceiling prevents a
  // large host filesystem from turning the reserve into tens of idle gigabytes.
  const reserveBytes = Math.min(1024 * 1024 * 1024, Math.max(minFreeBytes, Math.ceil(totalBytes * 0.1)));
  const requiredBytes = Math.ceil(estimatedBytes) + reserveBytes;
  return {
    ok: freeBytes >= requiredBytes,
    freeBytes,
    totalBytes,
    estimatedBytes: Math.ceil(estimatedBytes),
    reserveBytes,
    requiredBytes,
  };
}

function assertPublicationCapacity(rows, descriptor) {
  if (!fs.statfsSync) return null;
  const stat = fs.statfsSync(DATA_BASE_PATH);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  const totalBytes = Number(stat.blocks) * Number(stat.bsize);
  const estimatedBytes = estimateSnapshotBytes(rows, descriptor.columns);
  const configuredReserve = Number(process.env.DOMAINSCOUT_SNAPSHOT_MIN_FREE_BYTES);
  const capacity = publicationCapacity({
    freeBytes,
    totalBytes,
    estimatedBytes,
    minFreeBytes: Number.isFinite(configuredReserve) && configuredReserve > 0
      ? configuredReserve
      : DEFAULT_MIN_FREE_BYTES,
  });
  if (!capacity.ok) {
    const mib = value => Math.ceil(value / (1024 * 1024));
    throw new Error(
      `provider snapshot publication deferred before write: ${mib(capacity.freeBytes)} MiB free, ` +
      `${mib(capacity.requiredBytes)} MiB required (${mib(capacity.estimatedBytes)} MiB estimated artifact + ` +
      `${mib(capacity.reserveBytes)} MiB safety reserve)`,
    );
  }
  return capacity;
}

function writeCompactArtifact(filePath, header, rows, columns, maxBytes) {
  const hash = crypto.createHash('sha256');
  let written = 0;
  const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    const write = chunk => {
      written += Buffer.byteLength(chunk);
      if (written > maxBytes) throw new Error(`provider snapshot exceeds bounded size ${maxBytes}`);
      fs.writeSync(fd, chunk);
      hash.update(chunk);
    };
    write(`${JSON.stringify({ ...header, format: FORMAT, columns }).slice(0, -1)},"domains":[`);
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
  } finally {
    fs.closeSync(fd);
  }
  return { bytes: written, sha256: hash.digest('hex') };
}

function readJsonPhysical(filePath, maxBytes = 8 * 1024 * 1024) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) {
    throw new Error(`unsafe snapshot metadata: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function currentGeneration(stream) {
  const paths = streamPaths(stream);
  if (!paths || !fs.existsSync(paths.pointer)) return null;
  const pointer = readJsonPhysical(paths.pointer);
  if (pointer.version !== POINTER_VERSION || pointer.stream !== stream || !/^[a-f0-9]{24}$/.test(pointer.generationId || '')) {
    throw new Error(`invalid provider snapshot pointer for ${stream}`);
  }
  const generationDir = path.join(paths.generations, pointer.generationId);
  const manifestPath = path.join(generationDir, 'manifest.json');
  const artifactPath = path.join(generationDir, 'snapshot.json');
  const manifest = readJsonPhysical(manifestPath);
  if (manifest.version !== POINTER_VERSION || manifest.format !== FORMAT || manifest.stream !== stream ||
      manifest.generationId !== pointer.generationId || sha256(JSON.stringify(manifest)) !== pointer.manifestSha256) {
    throw new Error(`provider snapshot pointer/manifest mismatch for ${stream}`);
  }
  const artifactStat = fs.lstatSync(artifactPath);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink() || artifactStat.nlink !== 1 || artifactStat.size !== manifest.snapshotBytes) {
    throw new Error(`invalid provider snapshot artifact for ${stream}`);
  }
  return { ...paths, pointer, manifest, artifactPath, artifactStat };
}

function legacyMeta(stream) {
  const descriptor = getLargeProviderDescriptor(stream);
  if (!descriptor?.legacyFileStem) return null;
  const artifactPath = path.join(DATA_BASE_PATH, `${descriptor.legacyFileStem}.json`);
  if (!fs.existsSync(artifactPath)) return null;
  const stat = fs.statSync(artifactPath);
  const metaPath = `${artifactPath}.meta.json`;
  let meta = {};
  try { meta = readJsonPhysical(metaPath); } catch (_) {}
  return {
    stream,
    generatedAt: meta.generatedAt || null,
    count: Number(meta.count) || 0,
    snapshotBytes: Number(meta.snapshotBytes) || stat.size,
    snapshotSha256: meta.snapshotSha256 || null,
    evidence: meta.evidence || null,
    validation: meta.validation || null,
    format: meta.snapshotFormat || 'legacy-object-v1',
    artifactPath,
    legacy: true,
  };
}

function readLargeProviderSnapshotMeta(stream) {
  const descriptor = getLargeProviderDescriptor(stream);
  if (!descriptor) return null;
  const lastAttempt = readRefreshJournal(REFRESH_JOURNAL_PATH)[stream] || null;
  let manifest = null;
  try { manifest = currentGeneration(stream)?.manifest || null; } catch (error) {
    return { stream, generatedAt: null, count: 0, ageMs: Infinity, lastAttempt, error: error.message };
  }
  const source = manifest || legacyMeta(stream);
  if (!source) return { stream, generatedAt: null, count: 0, ageMs: Infinity, lastAttempt };
  const generatedAtMs = Date.parse(source.generatedAt || '');
  return {
    stream,
    generationId: source.generationId || null,
    generatedAt: source.generatedAt || null,
    count: Number(source.count) || 0,
    ageMs: Number.isFinite(generatedAtMs) ? Math.max(0, Date.now() - generatedAtMs) : Infinity,
    evidence: source.evidence || null,
    validation: source.validation || null,
    snapshotFormat: source.format || FORMAT,
    snapshotBytes: Number(source.snapshotBytes) || 0,
    snapshotSha256: source.snapshotSha256 || null,
    lastAttempt,
    legacy: Boolean(source.legacy),
  };
}

function largeProviderSnapshotHealth(stream, nowMs = Date.now()) {
  const descriptor = getLargeProviderDescriptor(stream);
  if (!descriptor) return null;
  return evaluateSnapshotHealth(readLargeProviderSnapshotMeta(stream), {
    maxAgeMs: descriptor.maxAgeMs,
    minCount: descriptor.minCount,
  }, nowMs);
}

function validateLargeProviderSnapshot(stream, rows, options = {}) {
  const descriptor = getLargeProviderDescriptor(stream);
  if (!descriptor) throw new Error(`unknown provider stream ${stream}`);
  const previous = readLargeProviderSnapshotMeta(stream);
  return validateSnapshotCandidate(rows, {
    minCount: options.minCount || descriptor.minCount,
    previousCount: previous?.count || 0,
    maxDropFraction: options.maxDropFraction ?? descriptor.maxDropFraction,
    identityField: descriptor.identityField,
    timestampField: descriptor.timestampField,
    minTimestampRatio: options.minTimestampRatio ?? descriptor.minTimestampRatio,
  });
}

function cleanupGenerations(paths, keep) {
  let entries = [];
  try { entries = fs.readdirSync(paths.generations, { withFileTypes: true }); } catch (_) { return; }
  const generationNames = entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name))
    .map(entry => entry.name).sort().reverse();
  const protectedNames = new Set([paths.pointer && fs.existsSync(paths.pointer)
    ? (() => { try { return readJsonPhysical(paths.pointer).generationId; } catch (_) { return null; } })()
    : null]);
  let retained = 0;
  for (const name of generationNames) {
    if (protectedNames.has(name) || retained < keep) { retained += 1; continue; }
    fs.rmSync(path.join(paths.generations, name), { recursive: true, force: true });
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('.staging-')) {
      const candidate = path.join(paths.generations, entry.name);
      try {
        const pidMatch = /^\.staging-(\d+)-/.exec(entry.name);
        let ownerAlive = false;
        if (pidMatch) {
          try { process.kill(Number(pidMatch[1]), 0); ownerAlive = true; } catch (err) { ownerAlive = err?.code === 'EPERM'; }
        }
        const expired = Date.now() - fs.statSync(candidate).mtimeMs > 60 * 60 * 1000;
        if (!ownerAlive || expired) fs.rmSync(candidate, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

function publishLargeProviderSnapshot(stream, rows, options = {}) {
  const paths = streamPaths(stream);
  if (!paths) throw new Error(`unknown provider stream ${stream}`);
  if (!Array.isArray(rows)) throw new Error('provider snapshot rows must be an array');
  const validation = validateLargeProviderSnapshot(stream, rows, options);
  if (options.validation && options.validation.ok !== true) {
    throw new Error('provider adapter supplied a failed validation receipt');
  }
  if (!validation.ok) throw new Error(`provider snapshot validation failed: ${validation.errors.join('; ')}`);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const sorted = rows.slice().sort(compareAuctionEnd);
  const nonce = crypto.randomBytes(12).toString('hex');
  // The retention walk is lexical and must be chronological. Prefix the random
  // collision guard with a fixed-width millisecond clock so newest generations sort
  // first across crashes/restarts without consulting mutable directory mtimes.
  const generationId = `${Date.now().toString(16).padStart(12, '0').slice(-12)}${crypto.randomBytes(6).toString('hex')}`;
  assertPhysicalDirectory(SNAPSHOT_ROOT);
  assertPhysicalDirectory(paths.root);
  assertPhysicalDirectory(paths.generations);
  cleanupGenerations(paths, paths.descriptor.retainGenerations);
  assertPublicationCapacity(sorted, paths.descriptor);
  const stagingDir = path.join(paths.generations, `.staging-${process.pid}-${nonce}`);
  fs.mkdirSync(stagingDir, { mode: 0o700 });
  try {
    const artifactPath = path.join(stagingDir, 'snapshot.json');
    const artifact = writeCompactArtifact(artifactPath, {
      version: POINTER_VERSION,
      stream,
      generationId,
      generatedAt,
      count: sorted.length,
      sortedBy: 'auction_end_asc',
    }, sorted, paths.descriptor.columns, paths.descriptor.maxSnapshotBytes);
    const manifest = {
      version: POINTER_VERSION,
      format: FORMAT,
      stream,
      generationId,
      generatedAt,
      count: sorted.length,
      sortedBy: 'auction_end_asc',
      snapshotBytes: artifact.bytes,
      snapshotSha256: artifact.sha256,
      evidence: options.evidence || null,
      validation,
    };
    const manifestText = JSON.stringify(manifest);
    const manifestPath = path.join(stagingDir, 'manifest.json');
    fs.writeFileSync(manifestPath, manifestText, { mode: 0o600, flag: 'wx' });
    const manifestFd = fs.openSync(manifestPath, 'r');
    try { fs.fsyncSync(manifestFd); } finally { fs.closeSync(manifestFd); }
    fsyncDirectory(stagingDir);
    const finalDir = path.join(paths.generations, generationId);
    fs.renameSync(stagingDir, finalDir);
    fsyncDirectory(paths.generations);
    const pointer = {
      version: POINTER_VERSION,
      stream,
      generationId,
      manifestSha256: sha256(manifestText),
    };
    const pointerTmp = `${paths.pointer}.${process.pid}.${nonce}.tmp`;
    fs.writeFileSync(pointerTmp, JSON.stringify(pointer), { mode: 0o600, flag: 'wx' });
    const pointerFd = fs.openSync(pointerTmp, 'r');
    try { fs.fsyncSync(pointerFd); } finally { fs.closeSync(pointerFd); }
    fs.renameSync(pointerTmp, paths.pointer);
    fsyncDirectory(paths.root);
    indexCache.delete(stream);
    payloadCache.delete(stream);
    domainMapCache.delete(stream);
    cleanupGenerations(paths, paths.descriptor.retainGenerations);
    return manifest;
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

function readSnapshotPayload(stream) {
  const generation = currentGeneration(stream);
  if (generation) {
    const cacheKey = `${generation.pointer.generationId}:${generation.artifactStat.mtimeMs}`;
    const cached = payloadCache.get(stream);
    if (cached?.cacheKey === cacheKey) return cached.payload;
    const raw = JSON.parse(fs.readFileSync(generation.artifactPath, 'utf8'));
    if (raw.format !== FORMAT || raw.stream !== stream || raw.generationId !== generation.pointer.generationId || !Array.isArray(raw.domains)) {
      throw new Error(`invalid provider snapshot payload for ${stream}`);
    }
    const payload = { ...raw, domains: raw.domains.map(tuple => tupleToRow(tuple, raw.columns)) };
    payloadCache.set(stream, { cacheKey, payload });
    return payload;
  }
  const legacy = legacyMeta(stream);
  if (!legacy) return null;
  const stat = fs.statSync(legacy.artifactPath);
  const cacheKey = `legacy:${stat.mtimeMs}`;
  const cached = payloadCache.get(stream);
  if (cached?.cacheKey === cacheKey) return cached.payload;
  const raw = JSON.parse(fs.readFileSync(legacy.artifactPath, 'utf8'));
  const payload = raw.format === 'compact-columns-v1' && Array.isArray(raw.columns)
    ? { ...raw, domains: raw.domains.map(tuple => tupleToRow(tuple, raw.columns)) }
    : raw;
  payloadCache.set(stream, { cacheKey, payload });
  return payload;
}

function readLargeProviderSnapshotIndex(stream) {
  const descriptor = getLargeProviderDescriptor(stream);
  if (!descriptor) return null;
  const generation = currentGeneration(stream);
  let raw;
  let cacheKey;
  if (generation) {
    cacheKey = `${generation.pointer.generationId}:${generation.artifactStat.mtimeMs}`;
    if (indexCache.get(stream)?.cacheKey === cacheKey) return indexCache.get(stream).index;
    raw = JSON.parse(fs.readFileSync(generation.artifactPath, 'utf8'));
  } else {
    if (!descriptor.legacyFileStem) return null;
    const indexPath = path.join(DATA_BASE_PATH, `${descriptor.legacyFileStem}.json.ui-index.json`);
    if (!fs.existsSync(indexPath)) return null;
    const stat = fs.statSync(indexPath);
    cacheKey = `legacy:${stat.mtimeMs}`;
    if (indexCache.get(stream)?.cacheKey === cacheKey) return indexCache.get(stream).index;
    raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }
  if (!raw || raw.stream !== stream || !Array.isArray(raw.domains)) return null;
  if ((raw.format !== FORMAT && raw.format !== 'compact-columns-v1') || !Array.isArray(raw.columns)) {
    const rows = raw.domains.slice().sort(compareAuctionEnd);
    const index = {
      stream,
      generatedAt: raw.generatedAt || null,
      count: rows.length,
      excludeEnded: descriptor.excludeEnded,
      rows,
    };
    indexCache.set(stream, { cacheKey, index });
    return index;
  }
  const compactRows = raw.domains;
  const compactColumns = raw.columns;
  const compactColumnIndex = Object.fromEntries(compactColumns.map((column, position) => [column, position]));
  let materializedRows = null;
  const index = {
    stream,
    generatedAt: raw.generatedAt || null,
    count: compactRows.length,
    excludeEnded: descriptor.excludeEnded,
    compactRows,
    compactColumns,
    compactColumnIndex,
    sortedBy: 'auction_end_asc',
  };
  Object.defineProperty(index, 'rows', {
    enumerable: false,
    get() {
      if (!materializedRows) materializedRows = compactRows.map(tuple => tupleToRow(tuple, compactColumns));
      return materializedRows;
    },
  });
  indexCache.set(stream, { cacheKey, index });
  return index;
}

function readLargeProviderDomainMap(stream) {
  const meta = readLargeProviderSnapshotMeta(stream);
  const cacheKey = `${meta?.generationId || 'legacy'}:${meta?.snapshotSha256 || meta?.generatedAt || ''}`;
  const cached = domainMapCache.get(stream);
  if (cached?.cacheKey === cacheKey) return cached.map;
  const payload = readSnapshotPayload(stream);
  if (!payload?.domains) return null;
  const map = new Map(payload.domains.map(row => [row.domain, row]));
  domainMapCache.set(stream, { cacheKey, map });
  return map;
}

function recordLargeProviderRefreshEvent(stream, event) {
  if (!isLargeProviderStream(stream)) throw new Error(`unknown provider stream ${stream}`);
  assertPhysicalDirectory(DATA_BASE_PATH);
  return writeRefreshEvent(REFRESH_JOURNAL_PATH, stream, event);
}

module.exports = {
  FORMAT,
  largeProviderSnapshotHealth,
  getLargeProviderDescriptor,
  isLargeProviderStream,
  listLargeProviderStreams,
  publishLargeProviderSnapshot,
  readLargeProviderDomainMap,
  readLargeProviderSnapshotIndex,
  readLargeProviderSnapshotMeta,
  readSnapshotPayload,
  recordLargeProviderRefreshEvent,
  registerLargeProviderStream,
  validateLargeProviderSnapshot,
  _test: { compareAuctionEnd, estimateSnapshotBytes, publicationCapacity, rowToTuple, streamPaths, tupleToRow },
};
