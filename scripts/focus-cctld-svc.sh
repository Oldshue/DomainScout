#!/usr/bin/env bash
# Resident focused-ccTLD enrichment. Keeps the "taken in .ai" filter populated for
# imminent auctions the slow full-universe tlds-worker can't reach in time (it does
# ~286 lookups/name; this does 1-3). Loops: sweep uncached upcoming-auction bases for
# .ai/.io/.co, sleep, repeat. See scripts/focus-cctld-enrich.cjs for the why.
cd "/Users/hamp/DomainScout"
export FOCUS_LOOP=1
export FOCUS_TLDS=".ai,.io,.co"
export FOCUS_WINDOW_DAYS=14
export FOCUS_CONCURRENCY=200
export FOCUS_DNS_TIMEOUT_MS=900
export FOCUS_LOOP_SLEEP_MS=1800000
exec "/opt/homebrew/Cellar/node@22/22.22.0/bin/node" scripts/focus-cctld-enrich.cjs
