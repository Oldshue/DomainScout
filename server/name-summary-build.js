require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.DOMAINSCOUT_ZONE_INDEX_ROLE ||= 'bulk';

const { rebuildNameSummary } = require('./zone-indexer');

const result = rebuildNameSummary();
if (!result.ok) {
  console.error('[NameSummary] Build failed:', result.error || 'already running');
  process.exitCode = 1;
}
