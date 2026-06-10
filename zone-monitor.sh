#!/bin/bash
cd /Users/hamp/Desktop/Projects/DomainScout
LAST_MAT=0
while true; do
  # count indexed TLDs + bracelet live count from zone index
  STATS=$(node -e '
    const Database=require("better-sqlite3");
    try{const db=new Database("data/domains.db",{readonly:true});
    db.prepare("ATTACH DATABASE ? AS zi").run("data/zone_index.db");
    const t=db.prepare("SELECT COUNT(*) c FROM zi.zone_indexed_tlds").get().c;
    const b=db.prepare("SELECT tld_count FROM zi.name_summary WHERE base_name=?").get("bracelet");
    const big=["net","org","info","biz"].filter(x=>db.prepare("SELECT 1 FROM zi.zone_indexed_tlds WHERE tld=?").get(x));
    console.log(t+"|"+(b?b.tld_count:0)+"|"+big.join(","));
    db.close();}catch(e){console.log("ERR|"+e.message);}
  ' 2>/dev/null)
  TLDS=$(echo "$STATS"|cut -d'|' -f1); BRC=$(echo "$STATS"|cut -d'|' -f2); BIG=$(echo "$STATS"|cut -d'|' -f3)
  echo "[$(date +%H:%M)] indexed TLDs=$TLDS | bracelet=$BRC | legacy in=[$BIG]"
  # re-materialize sort column every time +25 TLDs land
  if [ "$TLDS" != "ERR" ] && [ $((TLDS - LAST_MAT)) -ge 25 ]; then
    echo "  -> re-materializing tlds_taken (TLDs now $TLDS)..."
    node scripts/materialize-tlds-from-zone.cjs 2>&1 | tail -1
    LAST_MAT=$TLDS
  fi
  # stop when full sweep done
  if grep -q "ALL DONE" /tmp/zone-priority.log 2>/dev/null; then echo "SYNC COMPLETE — final materialize"; node scripts/materialize-tlds-from-zone.cjs 2>&1|tail -1; break; fi
  sleep 300
done
