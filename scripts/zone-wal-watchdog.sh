#!/usr/bin/env bash
cd "/Users/hamp/DomainScout"
while true; do
  if pgrep -f "server/czds-sync.js" >/dev/null 2>&1; then
    sleep 240
    continue
  fi
  DOMAINSCOUT_SKIP_DB_MAINTENANCE=1 "/opt/homebrew/Cellar/node@22/22.22.0/bin/node" -e '
    try { const D=require("better-sqlite3"); const db=new D("data/zone_index.db"); db.pragma("busy_timeout=30000");
      const wal=require("fs").existsSync("data/zone_index.db-wal")?require("fs").statSync("data/zone_index.db-wal").size:0;
      const mode = wal > 8*1024*1024*1024 ? "TRUNCATE" : "PASSIVE";
      const r=db.pragma("wal_checkpoint("+mode+")");
      process.stderr.write(new Date().toISOString()+" wal="+(wal/1e9).toFixed(1)+"GB "+mode+" "+JSON.stringify(r)+"\n");
      db.close();
    } catch(e){ process.stderr.write("watchdog: "+e.message+"\n"); }
  '
  sleep 240
done
