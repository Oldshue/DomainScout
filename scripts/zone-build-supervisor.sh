#!/usr/bin/env bash
cd "/Users/hamp/DomainScout"
export DOMAINSCOUT_SKIP_DB_MAINTENANCE=1
while true; do
  if ! pgrep -f "czds-sync.js" >/dev/null 2>&1; then
    echo "[zone-build] priority diff start $(date)"
    if ! CZDS_UNSAFE_DIRECT_INDEX=0 CZDS_SKIP_REINDEX=0 CZDS_SKIP_SUMMARY_REFRESH=1 CZDS_STAGING_TEMP_STORE=FILE \
      DOMAINSCOUT_CZDS_POST_IMPORT=1 DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_LIMIT="${DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_LIMIT:-3000}" \
      "/opt/homebrew/Cellar/node@22/22.22.0/bin/node" server/czds-sync.js --tlds=com,net,org,info,biz --full; then
      echo "[zone-build] priority diff failed $(date)"
      sleep 900
      continue
    fi
    echo "[zone-build] priority diff pass done $(date)"

    echo "[zone-build] coverage start $(date)"
    CZDS_UNSAFE_DIRECT_INDEX=1 CZDS_SKIP_REINDEX=1 \
      "/opt/homebrew/Cellar/node@22/22.22.0/bin/node" server/czds-sync.js --full
    echo "[zone-build] coverage pass done $(date)"
  fi
  sleep 900
done
