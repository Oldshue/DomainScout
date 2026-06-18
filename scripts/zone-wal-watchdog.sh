#!/usr/bin/env bash
cd "/Users/hamp/DomainScout"
while true; do
  if pgrep -f "server/czds-sync.js" >/dev/null 2>&1; then
    sleep 240
    continue
  fi
  DOMAINSCOUT_SKIP_DB_MAINTENANCE=1 "/opt/homebrew/Cellar/node@22/22.22.0/bin/node" -e '
    const D=require("better-sqlite3"); const fs=require("fs");
    // Checkpoint BOTH the zone index AND domains.db. domains.db is written continuously
    // by the availability worker, so its WAL re-bloats (18GB seen) and PASSIVE never
    // shrinks the file; TRUNCATE when it grows past 1GB. The 30s busy_timeout lets the
    // checkpoint slip into the gaps while the worker is on RDAP network calls.
    for (const [path, truncAt] of [["data/zone_index.db", 8e9], ["data/domains.db", 1e9]]) {
      try {
        const db=new D(path); db.pragma("busy_timeout=30000");
        const walFile=path+"-wal";
        const wal=fs.existsSync(walFile)?fs.statSync(walFile).size:0;
        const mode = wal > truncAt ? "TRUNCATE" : "PASSIVE";
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
          try {
            const hasStat4 = db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat4'").get();
            if (!hasStat4) { process.stderr.write(new Date().toISOString()+" domains.db: sqlite_stat4 missing -> full ANALYZE\n"); db.exec("ANALYZE;"); }
            else { db.pragma("optimize"); }
          } catch(e){ process.stderr.write("stat4 bootstrap: "+e.message+"\n"); }
        }
        process.stderr.write(new Date().toISOString()+" "+path+" wal="+(wal/1e9).toFixed(1)+"GB "+mode+" "+JSON.stringify(r)+"\n");
        db.close();
      } catch(e){ process.stderr.write("watchdog "+path+": "+e.message+"\n"); }
    }
  '
  sleep 240
done
