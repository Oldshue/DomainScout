'use strict';

const {
  getLargeProviderDescriptor,
  registerLargeProviderStream,
} = require('./large-provider-snapshot');

const DOMAIN_COLUMNS = [
  'domain', 'tld', 'stream', 'source', 'auction_price', 'auction_end', 'auction_url',
  'age_years', 'bid_count', 'length', 'has_numbers', 'has_hyphens', 'tlds_taken',
  'tlds_lower_bound', 'tlds_verified', 'source_feed', 'metrics',
];

const STREAM_DESCRIPTORS = [
  { stream: 'godaddy-auction', minCount: 10_000, legacyFileStem: 'godaddy-auction-cache', excludeEnded: true },
  { stream: 'godaddy-closeout', minCount: 1_000, legacyFileStem: 'godaddy-closeout-cache' },
  { stream: 'namecheap-auction', minCount: 100_000, excludeEnded: true },
];

for (const descriptor of STREAM_DESCRIPTORS) {
  registerLargeProviderStream({
    ...descriptor,
    columns: DOMAIN_COLUMNS,
    maxAgeMs: 2 * 60 * 60 * 1000,
    maxDropFraction: 0.6,
    minTimestampRatio: 0.98,
    maxSnapshotBytes: 2 * 1024 * 1024 * 1024,
    retainGenerations: 2,
  });
}

module.exports = {
  DOMAIN_COLUMNS,
  STREAM_DESCRIPTORS,
  getProviderSnapshotDescriptor: getLargeProviderDescriptor,
};
