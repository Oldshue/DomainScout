#!/usr/bin/env bash
cd "/Users/hamp/DomainScout"
export DOMAINSCOUT_SKIP_DB_MAINTENANCE=1 DOMAINSCOUT_DNS_ONLY_UNIVERSE=1
# USE_ZONE=1: the gTLD zone index is complete (1078 zones), so use it as the
# instant gTLD authority and DNS-check only the ~286-TLD ccTLD gap (.co/.de/.io/.ai
# ...). ~4.5x fewer DNS lookups per name AND the count merges zone gTLDs + ccTLDs.
export TLDS_WORKER_USE_ZONE=1 TLDS_WORKER_SCOPE=auction TLDS_WORKER_WINDOW_DAYS=10
export TLDS_WORKER_DNS_CONCURRENCY=160 TLDS_WORKER_DNS_TIMEOUT_MS=1500
export TLDS_WORKER_NAME_CONCURRENCY=24 TLDS_WORKER_FETCH=500
exec "/opt/homebrew/Cellar/node@22/22.22.0/bin/node" server/tlds-worker.js
