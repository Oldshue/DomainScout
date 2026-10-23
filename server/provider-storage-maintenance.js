'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GENERATION_RE = /^[a-f0-9]{24}$/;
const DEFAULT_RESERVE_BYTES = 256 * 1024 * 1024;

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let read = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function readVerifiedCurrentGeneration(dataDir, stream) {
  const root = path.join(dataDir, 'provider-snapshots', stream);
  const pointerPath = path.join(root, 'current.json');
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  if (pointer.version !== 1 || pointer.stream !== stream || !GENERATION_RE.test(pointer.generationId || '')) {
    throw new Error(`invalid current provider pointer for ${stream}`);
  }
  const generationDir = path.join(root, 'generations', pointer.generationId);
  const manifestPath = path.join(generationDir, 'manifest.json');
  const snapshotPath = path.join(generationDir, 'snapshot.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const snapshot = fs.lstatSync(snapshotPath);
  if (!snapshot.isFile() || snapshot.isSymbolicLink() || snapshot.nlink !== 1 ||
      manifest.version !== 1 || manifest.stream !== stream || manifest.generationId !== pointer.generationId ||
      manifest.validation?.ok !== true || snapshot.size !== manifest.snapshotBytes ||
      crypto.createHash('sha256').update(manifestText).digest('hex') !== pointer.manifestSha256 ||
      sha256File(snapshotPath) !== manifest.snapshotSha256) {
    throw new Error(`current provider generation failed integrity verification for ${stream}`);
  }
  return { stream, root, generationDir, generationId: pointer.generationId, manifest };
}

function removeFile(filePath, removed) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe maintenance file ${filePath}`);
    fs.unlinkSync(filePath);
    removed.push({ path: filePath, bytes: stat.size });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function pruneProviderStorage({ dataDir, providers }) {
  const verified = providers.map(provider => ({
    ...provider,
    current: readVerifiedCurrentGeneration(dataDir, provider.stream),
  }));
  const removed = [];
  for (const provider of verified) {
    if (provider.legacyFileStem) {
      const base = path.join(dataDir, `${provider.legacyFileStem}.json`);
      for (const suffix of ['', '.ui-index.json', '.meta.json']) removeFile(`${base}${suffix}`, removed);
    }
    const generationsDir = path.join(provider.current.root, 'generations');
    for (const entry of fs.readdirSync(generationsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !GENERATION_RE.test(entry.name) || entry.name === provider.current.generationId) continue;
      const target = path.join(generationsDir, entry.name);
      const bytes = fs.readdirSync(target).reduce((sum, name) => {
        try { return sum + fs.lstatSync(path.join(target, name)).size; } catch (_) { return sum; }
      }, 0);
      fs.rmSync(target, { recursive: true, force: true });
      removed.push({ path: target, bytes });
    }
  }
  return { verified: verified.map(item => ({ stream: item.stream, generationId: item.current.generationId, count: item.current.manifest.count })), removed };
}

function quoteSqlValues(values) {
  return values.map(value => `'${String(value).replaceAll("'", "''")}'`).join(',');
}

function pruneRedundantProviderRows(db, streams, { batchSize = 10_000 } = {}) {
  if (!streams.length) return { deleted: 0, retained: 0 };
  const streamSql = quoteSqlValues(streams);
  const removable = `stream IN (${streamSql})
    AND COALESCE(saved, 0) = 0
    AND COALESCE(seen, 0) = 0
    AND COALESCE(skipped, 0) = 0
    AND (notes IS NULL OR TRIM(notes) = '')
    AND COALESCE(wayback_snapshots, 0) = 0
    AND registration_available IS NULL`;
  const removeBatch = db.prepare(`DELETE FROM domains WHERE id IN (
    SELECT id FROM domains WHERE ${removable} LIMIT ?
  )`);
  let deleted = 0;
  while (true) {
    const result = removeBatch.run(batchSize);
    deleted += result.changes;
    db.pragma('wal_checkpoint(TRUNCATE)');
    if (result.changes < batchSize) break;
  }
  const retained = db.prepare(`SELECT COUNT(*) AS count FROM domains WHERE stream IN (${streamSql})`).get().count;
  try { db.exec("INSERT INTO domain_fts(domain_fts) VALUES('rebuild')"); } catch (_) { /* optional legacy FTS */ }
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { deleted, retained };
}

function compactDatabaseIfSafe(db, dataDir, { reserveBytes = DEFAULT_RESERVE_BYTES } = {}) {
  const pageSize = db.pragma('page_size', { simple: true });
  const pageCount = db.pragma('page_count', { simple: true });
  const freelist = db.pragma('freelist_count', { simple: true });
  const reclaimableRatio = pageCount > 0 ? freelist / pageCount : 0;
  if (reclaimableRatio < 0.2) return { compacted: false, reason: 'below-reclaim-threshold', reclaimableRatio };
  const stat = fs.statfsSync(dataDir);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  const liveBytes = Math.max(0, pageCount - freelist) * pageSize;
  const requiredBytes = Math.ceil(liveBytes * 1.25) + reserveBytes;
  if (freeBytes < requiredBytes) {
    return { compacted: false, reason: 'insufficient-temporary-space', freeBytes, requiredBytes, reclaimableRatio };
  }
  db.exec('VACUUM');
  return { compacted: true, reclaimedBytes: freelist * pageSize, reclaimableRatio };
}

module.exports = {
  compactDatabaseIfSafe,
  pruneProviderStorage,
  pruneRedundantProviderRows,
  readVerifiedCurrentGeneration,
  sha256File,
};
function rewriteProgressBatch(db, universeInput, { afterRowid = 0, batchSize = 250, apply = false, mode = 'compact' } = {}) {
  const { normalizeUniverse, decodeCheckedWaves } = require('./nameverse-coverage');
  const universe = normalizeUniverse(universeInput);
  if (!universe.authoritative || !universe.id || !universe.version || !universe.tlds.length) {
    throw new Error('an authoritative pinned extension universe is required');
  }
  if (!['compact', 'expand'].includes(mode) || !Number.isSafeInteger(batchSize) || batchSize < 1 ||
      !Number.isSafeInteger(afterRowid) || afterRowid < 0) throw new Error('invalid progress maintenance options');
  const rows = db.prepare(`
    SELECT rowid, checked_json, checked_waves_json FROM nameverse_check_progress
    WHERE rowid > ? AND universe_id = ? AND universe_version = ?
      AND checked_json ${mode === 'compact' ? '!=' : '='} '[]'
    ORDER BY rowid LIMIT ?
  `).all(afterRowid, universe.id, universe.version, batchSize);
  const membershipCache = new Map();
  const changes = [];
  let savedBytes = 0;
  for (const row of rows) {
    try {
      const legacy = JSON.parse(row.checked_json);
      const waves = JSON.parse(row.checked_waves_json);
      if (!Array.isArray(legacy) || !waves || Array.isArray(waves) || typeof waves !== 'object') continue;
      if (!Object.entries(waves).every(([at, bits]) => Number.isFinite(Number(at)) && typeof bits === 'string' &&
          Buffer.from(bits, 'base64').toString('base64') === bits)) continue;
      const signature = row.checked_json + '\n' + JSON.stringify(Object.values(waves).sort());
      let replacement = membershipCache.get(signature);
      if (replacement === undefined) {
        const members = [...decodeCheckedWaves(row.checked_waves_json, universe.tlds).keys()].sort();
        const same = legacy.length === members.length && new Set(legacy).size === legacy.length && [...new Set(legacy)].sort().every((name, i) => name === members[i]);
        replacement = mode === 'compact' ? (same && legacy.length ? '[]' : null)
          : (members.length ? JSON.stringify(members) : null);
        membershipCache.set(signature, replacement);
      }
      if (replacement === null) continue;
      savedBytes += Buffer.byteLength(row.checked_json) - Buffer.byteLength(replacement);
      changes.push({ ...row, replacement });
    } catch (_) { /* malformed or unverifiable legacy evidence remains untouched */ }
  }
  let changed = 0;
  let appliedBytesSaved = 0;
  if (apply && changes.length) {
    const update = db.prepare(`
      UPDATE nameverse_check_progress SET checked_json = ?
      WHERE rowid = ? AND universe_id = ? AND universe_version = ?
        AND checked_json = ? AND checked_waves_json = ?
    `);
    db.transaction(() => {
      for (const row of changes) {
        const count = update.run(row.replacement, row.rowid, universe.id, universe.version,
          row.checked_json, row.checked_waves_json).changes;
        changed += count;
        if (count) appliedBytesSaved += Buffer.byteLength(row.checked_json) - Buffer.byteLength(row.replacement);
      }
    })();
  }
  return { inspected: rows.length, eligible: changes.length, changed, logicalBytesSaved: apply ? appliedBytesSaved : savedBytes,
    afterRowid: rows.length ? rows[rows.length - 1].rowid : afterRowid, done: rows.length < batchSize };
}
module.exports.rewriteProgressBatch = rewriteProgressBatch;
