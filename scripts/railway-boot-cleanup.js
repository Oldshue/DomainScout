#!/usr/bin/env node
// Bounded preflight maintenance for the Railway query volume. Large provider feeds
// have one verified atomic hot generation; superseded generations and legacy cache
// formats are removed only after the current payload passes a full hash check. The
// Boot work is intentionally limited to bounded file operations. Row reclamation
// and VACUUM must never delay the HTTP health boundary on a volume-mounted deploy.
const fs = require('fs');
const path = require('path');
const {
  pruneProviderStorage,
} = require('../server/provider-storage-maintenance');

const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (!dir) { console.log('[boot-cleanup] no RAILWAY_VOLUME_MOUNT_PATH — skip (local)'); process.exit(0); }

function freeMB() {
  try { const s = fs.statfsSync(dir); return (s.bavail * s.bsize) / 1e6; } catch { return NaN; }
}

try {
  console.log(`[boot-cleanup] free before: ${freeMB().toFixed(0)}MB`);
  let freed = 0;
  const del = (f) => {
    try {
      const p = path.join(dir, f);
      const sz = fs.statSync(p).size;
      fs.unlinkSync(p);
      freed += sz;
      console.log(`[boot-cleanup] deleted ${f} (${(sz / 1e6).toFixed(0)}MB)`);
    } catch (e) { if (e.code !== 'ENOENT') console.warn(`[boot-cleanup] could not delete ${f}: ${e.message}`); }
  };
  for (const f of fs.readdirSync(dir)) {
    // Remove only abandoned partials and the forbidden local all-zone index. Provider
    // artifacts are handled below by their verified-generation lifecycle.
    if (
      /\.tmp$/i.test(f) ||
      /^zone_index\.db(-wal|-shm)?$/i.test(f)
    ) del(f);
  }
  const providers = [
    { stream: 'godaddy-auction', legacyFileStem: 'godaddy-auction-cache' },
    { stream: 'godaddy-closeout', legacyFileStem: 'godaddy-closeout-cache' },
  ];
  let providerMaintenance = null;
  try {
    providerMaintenance = pruneProviderStorage({ dataDir: dir, providers });
    freed += providerMaintenance.removed.reduce((sum, item) => sum + item.bytes, 0);
    console.log(`[boot-cleanup] verified providers: ${JSON.stringify(providerMaintenance.verified)}`);
    console.log(`[boot-cleanup] removed superseded provider bytes: ${providerMaintenance.removed.reduce((sum, item) => sum + item.bytes, 0)}`);
  } catch (error) {
    console.warn(`[boot-cleanup] provider pruning skipped closed: ${error.message}`);
  }
  // 2) checkpoint + truncate the WAL now that there is headroom
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(dir, 'domains.db');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath);
      db.pragma('busy_timeout = 30000');
      const r = db.pragma('wal_checkpoint(TRUNCATE)');
      db.pragma('journal_size_limit = 67108864');
      db.close();
      console.log(`[boot-cleanup] wal_checkpoint(TRUNCATE): ${JSON.stringify(r)}`);
    }
  } catch (e) { console.warn(`[boot-cleanup] WAL checkpoint skipped: ${e.message}`); }
  console.log(`[boot-cleanup] freed ~${(freed / 1e6).toFixed(0)}MB; free after: ${freeMB().toFixed(0)}MB`);
} catch (e) {
  console.warn(`[boot-cleanup] error (continuing to start anyway): ${e.message}`);
}
process.exit(0);
