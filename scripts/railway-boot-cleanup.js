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

// zone_index.db is the writer target for DomainLab's cloud NRD lane (see
// server/nrd-importer.js). It used to be unconditionally deleted on every boot,
// which permanently discarded the only writable cloud DomainLab data. The real
// hazard this guarded against was a broken 57GB partial CZDS build (which can
// never legitimately occur on Railway -- startCzdsSync's Railway fence already
// prevents it). Delete only when the file(s) exceed a generous size ceiling.
const ZONE_DB_MAX_MB_DEFAULT = 2000;

// Pure, testable: given the combined size (bytes) of zone_index.db(+-wal/-shm)
// and a max-MB threshold, decide whether deletion is warranted.
function shouldDeleteZoneDb(totalBytes, maxMb) {
  const bytes = Number(totalBytes) || 0;
  const max = Number(maxMb);
  const maxBytes = (Number.isFinite(max) && max > 0 ? max : ZONE_DB_MAX_MB_DEFAULT) * 1e6;
  return bytes > maxBytes;
}

function runBootCleanup() {
  const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!dir) { console.log('[boot-cleanup] no RAILWAY_VOLUME_MOUNT_PATH — skip (local)'); return; }

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

    // 1) Root *.tmp cleanup — unchanged, always removed (abandoned partials).
    for (const f of fs.readdirSync(dir)) {
      if (/\.tmp$/i.test(f)) del(f);
    }

    // 2) zone_index.db(+-wal/-shm): size-guarded. This is now the sole writer
    // target for the cloud NRD DomainLab lane, so it must survive normal boots.
    const zoneDbFiles = ['zone_index.db', 'zone_index.db-wal', 'zone_index.db-shm']
      .filter(f => fs.existsSync(path.join(dir, f)));
    if (zoneDbFiles.length) {
      const totalBytes = zoneDbFiles.reduce((sum, f) => {
        try { return sum + fs.statSync(path.join(dir, f)).size; } catch { return sum; }
      }, 0);
      const maxMb = process.env.DOMAINSCOUT_ZONE_DB_MAX_MB;
      if (shouldDeleteZoneDb(totalBytes, maxMb)) {
        console.log(`[boot-cleanup] zone_index.db(+wal/shm) is ${(totalBytes / 1e6).toFixed(0)}MB, exceeds threshold — deleting`);
        for (const f of zoneDbFiles) del(f);
      } else {
        console.log(`[boot-cleanup] kept zone_index.db(+wal/shm): ${(totalBytes / 1e6).toFixed(0)}MB (under threshold)`);
      }
    }

    // 3) Stale CZDS leftovers under <volume>/zones/: regenerable junk from the
    // disabled Railway CZDS lane (startCzdsSync refuses to run on Railway — see
    // server/index.js). Only remove files old enough that nothing could still be
    // actively writing them.
    try {
      const zonesDir = path.join(dir, 'zones');
      if (fs.existsSync(zonesDir)) {
        const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let zonesFreed = 0;
        let zonesDeleted = 0;
        for (const f of fs.readdirSync(zonesDir)) {
          if (!/\.(part|zone|zone\.gz)$/i.test(f)) continue;
          const p = path.join(zonesDir, f);
          try {
            const stat = fs.statSync(p);
            if (stat.mtimeMs >= cutoffMs) continue;
            fs.unlinkSync(p);
            zonesFreed += stat.size;
            zonesDeleted += 1;
          } catch (e) { if (e.code !== 'ENOENT') console.warn(`[boot-cleanup] could not delete zones/${f}: ${e.message}`); }
        }
        if (zonesDeleted > 0) {
          freed += zonesFreed;
          console.log(`[boot-cleanup] deleted ${zonesDeleted} stale CZDS leftover file(s) from zones/ (${(zonesFreed / 1e6).toFixed(0)}MB)`);
        }
      }
    } catch (e) {
      console.warn(`[boot-cleanup] stale zones/ cleanup skipped: ${e.message}`);
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
    // 4) checkpoint + truncate the WAL now that there is headroom
    for (const dbFile of ['domains.db', 'zone_index.db']) {
      try {
        const Database = require('better-sqlite3');
        const dbPath = path.join(dir, dbFile);
        if (fs.existsSync(dbPath)) {
          const db = new Database(dbPath);
          db.pragma('busy_timeout = 30000');
          const r = db.pragma('wal_checkpoint(TRUNCATE)');
          db.pragma('journal_size_limit = 67108864');
          db.close();
          console.log(`[boot-cleanup] ${dbFile} wal_checkpoint(TRUNCATE): ${JSON.stringify(r)}`);
        }
      } catch (e) { console.warn(`[boot-cleanup] ${dbFile} WAL checkpoint skipped: ${e.message}`); }
    }
    console.log(`[boot-cleanup] freed ~${(freed / 1e6).toFixed(0)}MB; free after: ${freeMB().toFixed(0)}MB`);
  } catch (e) {
    console.warn(`[boot-cleanup] error (continuing to start anyway): ${e.message}`);
  }
}

if (require.main === module) {
  runBootCleanup();
  process.exit(0);
}

module.exports = { shouldDeleteZoneDb, runBootCleanup };
