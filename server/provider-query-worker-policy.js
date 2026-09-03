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

// Provider snapshots are the freshness authority for provider-snapshot streams, so an
// unsupported sort field must never change which store answers the request (falling
// through to SQLite would serve stale/empty results). Instead, coerce the sort to the
// worker's canonical default (soonest-ending first) and report that it was coerced.
function resolveProviderSnapshotSort(sortBy, sortDir, supportedSortFields) {
  const supported = supportedSortFields instanceof Set
    ? supportedSortFields
    : new Set(supportedSortFields || []);
  if (supported.has(sortBy)) {
    const normalizedDir = String(sortDir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    return { sortBy, sortDir: normalizedDir, coerced: false, requested: sortBy };
  }
  return {
    sortBy: 'auction_end',
    sortDir: 'ASC',
    coerced: true,
    requested: sortBy || '',
    reason: 'provider-snapshot-sort-unsupported',
  };
}

module.exports = { providerSnapshotQueryWorkerEnabled, resolveProviderSnapshotSort };
