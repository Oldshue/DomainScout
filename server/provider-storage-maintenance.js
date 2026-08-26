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
