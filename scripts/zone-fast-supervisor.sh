#!/usr/bin/env bash
# Tight restart loop for the coverage-first zone build. A transient travel-wifi
# blip (ENETUNREACH/ECONNRESET) makes czds-sync exit; this restarts it within
# seconds. Coverage-first skips already-indexed zones, so each restart resumes
# right where it left off. When a fast pass stops adding zones (small zones
# exhausted), it runs ONE heavy/full pass to pick up the big zones (.net/.org/…),
# then keeps looping as a light keep-alive that re-checks for new daily zones.
cd "/Users/hamp/DomainScout" || exit 1
export DOMAINSCOUT_SKIP_DB_MAINTENANCE=1 CZDS_UNSAFE_DIRECT_INDEX=1 CZDS_SKIP_REINDEX=1
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
BACKGROUND_RUNNER=()
if [ -x /usr/sbin/taskpolicy ]; then BACKGROUND_RUNNER=(/usr/sbin/taskpolicy -b -d throttle -c maintenance); fi
NICE_RUNNER=()
if [ -x /usr/bin/nice ]; then NICE_RUNNER=(/usr/bin/nice -n 20); fi
run_maintenance() { "${BACKGROUND_RUNNER[@]}" "${NICE_RUNNER[@]}" "$NODE" "$@"; }
zcount() { sqlite3 data/zone_index.db "SELECT COUNT(*) FROM zone_indexed_tlds" 2>/dev/null || echo 0; }

flat_passes=0
while true; do
  before=$(zcount)
  if [ "$flat_passes" -ge 2 ]; then
    echo "[zone-sup] $(date) fast pass converged at $before zones — running FULL pass for heavy zones"
    DOMAINSCOUT_SKIP_DB_MAINTENANCE=1 CZDS_UNSAFE_DIRECT_INDEX=1 CZDS_SKIP_REINDEX=1 \
      run_maintenance server/czds-sync.js --full
    flat_passes=0
  else
    CZDS_FAST_TLD_LIMIT=2000 CZDS_FAST_MAX_ZONE_MB=150 \
      run_maintenance server/czds-sync.js
  fi
  code=$?
  after=$(zcount)
  echo "[zone-sup] $(date) pass exit=$code zones=$before -> $after"
  if [ "$after" -le "$before" ] 2>/dev/null; then flat_passes=$((flat_passes+1)); else flat_passes=0; fi
  # crash (nonzero) => restart fast; clean converged pass => brief idle before recheck
  if [ "$code" -ne 0 ]; then sleep 5; else sleep 30; fi
done
