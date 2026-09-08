'use strict';

const assert = require('assert');
const { startupMaintenanceEnabled } = require('../server/startup-policy');

assert.strictEqual(startupMaintenanceEnabled({}), false);
assert.strictEqual(startupMaintenanceEnabled({ DOMAINSCOUT_SKIP_DB_MAINTENANCE: '1' }), false);

for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
  assert.strictEqual(
    startupMaintenanceEnabled({ DOMAINSCOUT_STARTUP_MAINTENANCE_ENABLED: value }),
    true,
    `expected ${value} to enable startup maintenance`
  );
}

for (const value of ['0', 'false', 'no', 'off', '']) {
  assert.strictEqual(
    startupMaintenanceEnabled({ DOMAINSCOUT_STARTUP_MAINTENANCE_ENABLED: value }),
    false,
    `expected ${value} to keep startup maintenance disabled`
  );
}

console.log('startup-policy.test.js: all assertions passed');

const { nrdImportEnabled } = require('../server/startup-policy');
assert.equal(nrdImportEnabled({}), false);
assert.equal(nrdImportEnabled({RAILWAY_VOLUME_MOUNT_PATH:'/data'}), true);
assert.equal(nrdImportEnabled({DOMAINSCOUT_NRD_IMPORT_ENABLED:'1'}), true);
assert.equal(nrdImportEnabled({RAILWAY_VOLUME_MOUNT_PATH:'/data',DOMAINSCOUT_NRD_IMPORT_ENABLED:'0'}), false);
assert.equal(nrdImportEnabled({DOMAINSCOUT_NRD_IMPORT_ENABLED:'false'}), false);
