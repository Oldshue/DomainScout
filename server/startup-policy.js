'use strict';

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function startupMaintenanceEnabled(env = process.env) {
  return isEnabled(env.DOMAINSCOUT_STARTUP_MAINTENANCE_ENABLED);
}

function nrdImportEnabled(env = process.env) {
  if (env.DOMAINSCOUT_NRD_IMPORT_ENABLED !== undefined) return isEnabled(env.DOMAINSCOUT_NRD_IMPORT_ENABLED);
  return Boolean(env.RAILWAY_VOLUME_MOUNT_PATH);
}

module.exports = {
  nrdImportEnabled,
  isEnabled,
  startupMaintenanceEnabled,
};
