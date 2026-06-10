#!/bin/bash
cd /Users/hamp/Desktop/Projects/DomainScout
echo "=== PRIORITY DIFF: .com .net .org .info .biz === $(date)"
if ! CZDS_UNSAFE_DIRECT_INDEX=0 CZDS_SKIP_REINDEX=0 CZDS_SKIP_SUMMARY_REFRESH=1 CZDS_STAGING_TEMP_STORE=FILE \
  DOMAINSCOUT_CZDS_POST_IMPORT=1 DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_LIMIT="${DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_LIMIT:-3000}" \
  node server/czds-sync.js --tlds=com,net,org,info,biz --full 2>&1; then
  echo "=== PRIORITY DIFF FAILED === $(date)"
  exit 1
fi
echo "=== FULL SWEEP (remaining of 1123) === $(date)"
CZDS_UNSAFE_DIRECT_INDEX=1 CZDS_SKIP_REINDEX=1 node server/czds-sync.js --full 2>&1
echo "=== ALL DONE === $(date)"
