'use strict';

const DEFAULT_COLUMNS = Object.freeze([
  'domain', 'stream', 'tld', 'length', 'tlds_taken', 'age_years', 'wayback_snapshots',
  'bid_count', 'auction_price', 'expiry_date', 'auction_end', 'discovered_at', 'actions',
]);
const contracts = new Map();

function normalizeField(field = {}) {
  const supported = field.supported === true;
  return Object.freeze({
    supported,
    source: supported ? String(field.source || 'provider-snapshot') : null,
    liveRefresh: supported && field.liveRefresh === true,
    snapshotFallback: supported && field.snapshotFallback !== false,
    maxAgeMs: supported && Number.isFinite(Number(field.maxAgeMs))
      ? Math.max(60_000, Number(field.maxAgeMs)) : null,
  });
}

function normalizeLifecycle(lifecycle = {}) {
  const endTimestamp = ['terminal', 'historical', 'none'].includes(lifecycle.endTimestamp)
    ? lifecycle.endTimestamp
    : 'none';
  return Object.freeze({ endTimestamp });
}

function registerMarketStreamContract(input) {
  if (!input || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(input.stream || ''))) {
    throw new Error('market stream capability contract requires a bounded stream identifier');
  }
  const stream = String(input.stream);
  const columns = [...new Set((input.columns || []).map(String))]
    .filter(column => DEFAULT_COLUMNS.includes(column));
  if (!columns.includes('domain') || !columns.includes('actions')) {
    throw new Error(`${stream} market contract requires domain and actions columns`);
  }
  const contract = Object.freeze({
    stream,
    columns: Object.freeze(columns),
    fields: Object.freeze({
      bid_count: normalizeField(input.fields?.bid_count),
      auction_price: normalizeField(input.fields?.auction_price),
    }),
    lifecycle: normalizeLifecycle(input.lifecycle),
  });
  const prior = contracts.get(stream);
  if (prior && JSON.stringify(prior) !== JSON.stringify(contract)) {
    throw new Error(`market stream capability contract already registered for ${stream}`);
  }
  contracts.set(stream, contract);
  return contract;
}

function getMarketStreamContract(stream) {
  return contracts.get(String(stream || '')) || {
    stream: String(stream || 'all'),
    columns: DEFAULT_COLUMNS,
    fields: {
      bid_count: normalizeField({ supported: true, source: 'stored-observation' }),
      auction_price: normalizeField({ supported: true, source: 'stored-observation' }),
    },
    lifecycle: normalizeLifecycle(),
  };
}

const AUCTION_COLUMNS = [
  'domain', 'tld', 'length', 'tlds_taken', 'age_years', 'bid_count', 'auction_price',
  'auction_end', 'actions',
];

registerMarketStreamContract({
  stream: 'godaddy-auction', columns: AUCTION_COLUMNS,
  lifecycle: { endTimestamp: 'terminal' },
  fields: {
    bid_count: { supported: true, source: 'live-overlay-or-provider-snapshot', liveRefresh: true, maxAgeMs: 30 * 60_000 },
    auction_price: { supported: true, source: 'live-overlay-or-provider-snapshot', liveRefresh: true, maxAgeMs: 30 * 60_000 },
  },
});
registerMarketStreamContract({
  stream: 'namecheap-auction', columns: AUCTION_COLUMNS,
  lifecycle: { endTimestamp: 'terminal' },
  fields: {
    bid_count: { supported: true, source: 'official-provider-snapshot', maxAgeMs: 2 * 60 * 60_000 },
    auction_price: { supported: true, source: 'official-provider-snapshot', maxAgeMs: 2 * 60 * 60_000 },
  },
});
registerMarketStreamContract({
  stream: 'godaddy-closeout',
  columns: ['domain', 'tld', 'length', 'tlds_taken', 'age_years', 'auction_price', 'actions'],
  lifecycle: { endTimestamp: 'historical' },
  fields: {
    bid_count: { supported: false },
    auction_price: { supported: true, source: 'provider-snapshot', maxAgeMs: 2 * 60 * 60_000 },
  },
});

module.exports = { DEFAULT_COLUMNS, getMarketStreamContract, registerMarketStreamContract };
