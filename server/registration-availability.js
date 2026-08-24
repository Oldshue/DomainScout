'use strict';

const AVAILABILITY_CHECK_TYPES = new Set(['FAST', 'FULL']);
const AVAILABILITY_BATCH_SIZES = Object.freeze({ FAST: 500, FULL: 10 });

function normalizeAvailabilityCheckType(value, fallback = 'FAST') {
  const normalized = String(value || '').trim().toUpperCase();
  if (AVAILABILITY_CHECK_TYPES.has(normalized)) return normalized;
  return AVAILABILITY_CHECK_TYPES.has(fallback) ? fallback : 'FAST';
}

function sanitizeAvailabilityDomains(domains, limit = 500) {
  if (!Array.isArray(domains)) return [];
  return domains
    .filter(domain => typeof domain === 'string' && /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))
    .slice(0, limit);
}

function chunkAvailabilityDomains(domains, checkType) {
  const size = AVAILABILITY_BATCH_SIZES[normalizeAvailabilityCheckType(checkType)];
  const chunks = [];
  for (let offset = 0; offset < domains.length; offset += size) chunks.push(domains.slice(offset, offset + size));
  return chunks;
}

function buildAvailabilityUrl(checkType) {
  const normalized = normalizeAvailabilityCheckType(checkType);
  return `https://api.godaddy.com/v1/domains/available?checkType=${encodeURIComponent(normalized)}`;
}

module.exports = {
  buildAvailabilityUrl,
  chunkAvailabilityDomains,
  normalizeAvailabilityCheckType,
  sanitizeAvailabilityDomains,
};
