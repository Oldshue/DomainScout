#!/usr/bin/env bash
set -u
ROOT="${DOMAINSCOUT_ROOT:-/Users/hamp/DomainScout}"
NODE_BIN="${NODE_BIN:-$(command -v node || printf '/usr/local/bin/node')}"
INTERVAL_SECONDS="${DOMAINSCOUT_WAL_WATCHDOG_INTERVAL_SECONDS:-60}"
cd "$ROOT" || exit 1
while true; do
  if pgrep -f "server/czds-sync.js" >/dev/null 2>&1; then czds_active=1; else czds_active=0; fi
  CZDS_ACTIVE="$czds_active" DOMAINSCOUT_SKIP_DB_MAINTENANCE=1 "$NODE_BIN" -e '
    const D=require("better-sqlite3"); const fs=require("fs");
    const czdsActive=process.env.CZDS_ACTIVE === "1";
    // Checkpoint both stores even while maintenance is active. Skipping the active
    // writer allowed one resumable full-zone pass to accumulate an 18GB WAL. PASSIVE
    // keeps ordinary writes moving; RESTART at the high-water mark makes the next
    // writer reuse the existing file; an idle store is physically truncated.
    for (const [path, restartAt] of [["data/zone_index.db", 2e9], ["data/domains.db", 1e9]]) {
      try {
        if (!fs.existsSync(path)) continue;
        const db=new D(path); db.pragma("busy_timeout=15000");
        const walFile=path+"-wal";
        const wal=fs.existsSync(walFile)?fs.statSync(walFile).size:0;
        const writerActive = path.includes("zone_index") && czdsActive;
        const mode = wal > restartAt ? (writerActive ? "RESTART" : "TRUNCATE") : "PASSIVE";
        const r=db.pragma("wal_checkpoint("+mode+")");
        if (path === "data/domains.db") {
          // Bootstrap sqlite_stat4 (range-selectivity histograms) if missing. Without it
          // the planner picks the filter index + a TEMP B-TREE sort over hundreds of
          // thousands of rows for "filter + ORDER BY discovered_at + LIMIT" queries
          // (length/age/tlds/price/search), e.g. 13.6s for a length range; with stat4 it
          // walks idx_discovered and early-terminates = ~13ms. NOTE: only better-sqlite3
          // builds (ENABLE_STAT4) populate stat4 — the system sqlite3 CLI does not, and a
          // stat1-only ANALYZE makes PRAGMA optimize think stats are fresh and skip it.
          // One-time full ANALYZE (~60s) on fresh DBs; thereafter optimize maintains it.
          // Bound param (not an inline quoted literal) — single quotes would be eaten
          // by the surrounding node -e (...) shell quoting. One-time bootstrap only;
          // PRAGMA optimize is NOT run here (it write-locks the DB; db.js does it once
          // on server startup, which is enough — running it every cycle stalls reads).
          try {
            const hasStat4 = db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get("sqlite_stat4");
            if (!hasStat4) { process.stderr.write(new Date().toISOString()+" domains.db: sqlite_stat4 missing -> full ANALYZE\n"); db.exec("ANALYZE;"); }
          } catch(e){ process.stderr.write("stat4 bootstrap: "+e.message+"\n"); }
        }
        process.stderr.write(new Date().toISOString()+" "+path+" wal="+(wal/1e9).toFixed(1)+"GB "+mode+" "+JSON.stringify(r)+"\n");
        db.close();
      } catch(e){ process.stderr.write("watchdog "+path+": "+e.message+"\n"); }
    }
  '
  sleep "$INTERVAL_SECONDS"
done
