#!/usr/bin/env bash
# Resident materializer. Keeps domains.tlds_taken (the indexed column the EXTENSION sort
# uses) = MAX(zone, cache) for active auctions, rebuilds the inverted cctld_taken_idx
# (used by the ccTLD takenIn fast path), and checkpoints the WAL each sweep. Without this
# the sort column goes stale (sorts wrong → alphabetical) as enrichment/scrapes add data.
cd "/Users/hamp/DomainScout"
export MATERIALIZE_LOOP=1
export MATERIALIZE_BATCH=20000
export MATERIALIZE_LOOP_SLEEP_MS=1200000
exec "/opt/homebrew/Cellar/node@22/22.22.0/bin/node" scripts/materialize-auction-tlds.cjs
