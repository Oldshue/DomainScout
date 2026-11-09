'use strict';
// Child process for one My names authoritative-DNS sweep (spawned by
// createOwnerNamesDnsSupervisor in server/owner-names-dns.js). Keeps all DNS
// probing off the HTTP process; holds its refresh lease via heartbeat.
const path = require('node:path');
const { runOwnerNamesDnsSweep } = require('./owner-names-dns');
const { startRefreshLeaseHeartbeat } = require('./refresh-lease');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DOMAINSCOUT_DATA_DIR || path.join(__dirname, '../data');
const universeDir = process.env.DOMAINSCOUT_UNIVERSE_DIR || path.join(dataDir, 'universe');
const [day, mode] = process.argv.slice(2);
const stop = startRefreshLeaseHeartbeat();
runOwnerNamesDnsSweep({ dataDir, universeDir, day: day || undefined, force: mode === 'force' })
  .then(result => console.log(`[OwnerNamesDns] ${JSON.stringify(result)}`))
  .catch(error => { console.error(`[OwnerNamesDns] ${error.message}`); process.exitCode = 1; })
  .finally(() => stop());
