#!/usr/bin/env bash
cd "/Users/hamp/Desktop/Projects/DomainScout"
export TLDS_WORKER_USE_ZONE=0 TLDS_WORKER_SCOPE=auction TLDS_WORKER_WINDOW_DAYS=10
export TLDS_WORKER_DNS_CONCURRENCY=80 TLDS_WORKER_DNS_TIMEOUT_MS=2000 TLDS_WORKER_BATCH=30
while true; do
  echo "[supervisor] starting worker $(date)"
  node server/tlds-worker.js
  echo "[supervisor] worker exited ($?), restarting in 5s $(date)"
  sleep 5
done
