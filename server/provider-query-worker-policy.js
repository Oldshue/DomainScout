'use strict';

// Large immutable provider inventories must be queried outside the HTTP thread.
// Default the worker on so a missing deployment flag cannot silently route current
// snapshot views into an older compatibility store. Keep the former GoDaddy flag as
// a migration alias; the provider-neutral flag is authoritative when both exist.
function providerSnapshotQueryWorkerEnabled(env = process.env) {
  const configured = env.DOMAINSCOUT_PROVIDER_SNAPSHOT_QUERY_WORKER
    ?? env.DOMAINSCOUT_GODADDY_WORKER
    ?? '1';
  return !/^(0|false|no|off)$/i.test(String(configured).trim());
}

module.exports = { providerSnapshotQueryWorkerEnabled };
