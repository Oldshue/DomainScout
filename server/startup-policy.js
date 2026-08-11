'use strict';

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function startupMaintenanceEnabled(env = process.env) {
  return isEnabled(env.DOMAINSCOUT_STARTUP_MAINTENANCE_ENABLED);
}

module.exports = {
  isEnabled,
  startupMaintenanceEnabled,
};
