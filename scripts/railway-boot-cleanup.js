#!/usr/bin/env node
// One-time boot cleanup for the Railway deploy. The 5GB volume filled up
// (domains.db ~3.7GB + regenerable GoDaddy cache JSONs ~0.8GB + an unbounded WAL),
// causing "disk I/O error" on every write → failed healthcheck → crash-loop → 502.
// This frees space BEFORE the server starts: delete the regenerable GoDaddy cache
// files, then checkpoint+truncate the WAL. No-op off Railway (guarded on the volume
// env), so it never touches the Mac's data.
const fs = require('fs');
const path = require('path');

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
    // Remove ONLY genuine junk: zone_index.db (the ~57GB CZDS zone universe can never
    // fit the 4.6GB volume — it only lands here as a broken partial + a giant orphaned
    // WAL that fills the disk) and orphaned .tmp files from interrupted cache writes.
    // PRESERVE the GoDaddy cache .json / .ui-index.json — they fit (the WAL cap +
    // disabled zone sync keep the volume well under quota) and deleting them on every
    // boot would blank godaddy-auction (which is served only from that cache) after
    // each deploy until the live refresh rebuilds it.
    if (
      /\.tmp$/i.test(f) ||
      /^zone_index\.db(-wal|-shm)?$/i.test(f)
    ) del(f);
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
