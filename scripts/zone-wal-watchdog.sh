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
        // Refresh query-planner stats on domains.db (grows continuously via import +
        // availability worker). Stale stats make selective filters full-scan. Cheap/incremental.
        if (path === "data/domains.db") { try { db.pragma("optimize"); } catch(e){} }
        process.stderr.write(new Date().toISOString()+" "+path+" wal="+(wal/1e9).toFixed(1)+"GB "+mode+" "+JSON.stringify(r)+"\n");
        db.close();
      } catch(e){ process.stderr.write("watchdog "+path+": "+e.message+"\n"); }
    }
  '
  sleep 240
done
