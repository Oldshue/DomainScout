'use strict';

const MAX_SCAN_LIMIT = 10_000;
const MAX_SCAN_FIELDS = 32;
const MAX_SCAN_TLDS = 32;

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeFields(index, input) {
  const available = new Set(index.compactColumns || Object.keys(index.rows?.[0] || {}));
  const defaults = [
    'domain', 'tld', 'auction_price', 'auction_end', 'auction_url',
    'age_years', 'bid_count', 'length', 'has_numbers', 'has_hyphens', 'metrics',
  ];
  const fields = input == null || input === ''
    ? defaults.filter(field => available.has(field))
    : String(input).split(',').map(field => field.trim()).filter(Boolean);
  if (!fields.length || fields.length > MAX_SCAN_FIELDS) {
    throw new Error(`fields must contain between 1 and ${MAX_SCAN_FIELDS} entries`);
  }
  if (new Set(fields).size !== fields.length) throw new Error('fields must be unique');
  for (const field of fields) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(field) || !available.has(field)) {
      throw new Error(`unsupported provider snapshot field: ${field}`);
    }
  }
  return fields;
}

function normalizeTlds(input) {
  if (input == null || input === '') return null;
  const values = String(input).split(',').map(value => {
    const bare = value.trim().toLowerCase().replace(/^\./, '');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(bare)) {
      throw new Error(`invalid TLD filter: ${value}`);
    }
    return `.${bare}`;
  });
  const unique = [...new Set(values)];
  if (!unique.length || unique.length > MAX_SCAN_TLDS) {
    throw new Error(`tlds must contain between 1 and ${MAX_SCAN_TLDS} entries`);
  }
  return new Set(unique);
}

function scanLargeProviderIndex(index, options = {}) {
  if (!index || typeof index !== 'object' || !Number.isInteger(index.count) || index.count < 0) {
    throw new Error('provider snapshot index is required');
  }
  const offset = boundedInteger(options.offset, 0, 0, index.count, 'offset');
  const limit = boundedInteger(options.limit, 1_000, 1, MAX_SCAN_LIMIT, 'limit');
  const nowMs = Number(options.nowMs);
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be a finite timestamp');
  const fields = normalizeFields(index, options.fields);
  const tlds = normalizeTlds(options.tlds);
  const compact = Array.isArray(index.compactRows) && index.compactColumnIndex;
  const endPosition = compact ? index.compactColumnIndex.auction_end : null;
  const tldPosition = compact ? index.compactColumnIndex.tld : null;
  if (index.excludeEnded && compact && endPosition == null) {
    throw new Error('provider snapshot lacks auction_end required by excludeEnded');
  }

  const rows = [];
  let cursor = offset;
  while (cursor < index.count && rows.length < limit) {
    const row = compact ? index.compactRows[cursor] : index.rows[cursor];
    cursor += 1;
    const field = name => compact ? row[index.compactColumnIndex[name]] : row?.[name];
    const rowTld = compact && tldPosition != null ? row[tldPosition] : field('tld');
    if (tlds && !tlds.has(String(rowTld || '').toLowerCase())) continue;
    if (index.excludeEnded) {
      const endValue = compact ? row[endPosition] : field('auction_end');
      const endMs = Date.parse(endValue || '');
      if (!Number.isFinite(endMs) || endMs <= nowMs) continue;
    }
    rows.push(fields.map(name => field(name) ?? null));
  }

  return {
    stream: index.stream,
    generatedAt: index.generatedAt || null,
    totalSnapshotRows: index.count,
    offset,
    nextOffset: cursor,
    scanned: cursor - offset,
    returned: rows.length,
    done: cursor >= index.count,
    columns: fields,
    rows,
  };
}

module.exports = {
  MAX_SCAN_LIMIT,
  scanLargeProviderIndex,
};
