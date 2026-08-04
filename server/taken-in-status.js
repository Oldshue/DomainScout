'use strict';

const STATUS = Object.freeze({
  TAKEN: 'taken',
  NOT_TAKEN: 'not_taken',
  UNCHECKED: 'unchecked',
});

function normalizeTld(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/^\.+/, '');
  return /^[a-z0-9-]{2,63}$/.test(clean) ? `.${clean}` : null;
}

function parseTakenJson(value) {
  if (Array.isArray(value)) return value.map(normalizeTld).filter(Boolean);
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(normalizeTld).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function cacheCoversTld(cacheRow, tld, universe = null) {
  if (!cacheRow) return false;
  const normalized = normalizeTld(tld);
  if (!normalized) return false;

  if (universe && cacheRow.source === universe.source &&
      Number(cacheRow.all_count) === Number(universe.count)) {
    return true;
  }

  // Focused enrichment records its exact checked set in the source string. A row
  // from dns-focus:ai+io+co proves .ai was checked, but says nothing about .dev.
  const focus = String(cacheRow.source || '').match(/^dns-focus:([a-z0-9+-]+)$/i);
  if (!focus) return false;
  return focus[1].split('+').some(value => normalizeTld(value) === normalized);
}

function resolveTakenInStatus(evidence, tld, universe = null) {
  const normalized = normalizeTld(tld);
  if (!normalized) return STATUS.UNCHECKED;
  const input = evidence || {};
  const cacheTaken = parseTakenJson(input.cacheRow?.taken_json);

  if (input.zoneTaken || input.domainTaken || cacheTaken.includes(normalized)) {
    return STATUS.TAKEN;
  }
  if (input.zoneAuthoritative || cacheCoversTld(input.cacheRow, normalized, universe)) {
    return STATUS.NOT_TAKEN;
  }
  return STATUS.UNCHECKED;
}

function aggregateTakenInStatus(statuses) {
  const values = Array.isArray(statuses) ? statuses : [];
  if (!values.length || values.includes(STATUS.UNCHECKED)) return STATUS.UNCHECKED;
  return values.includes(STATUS.TAKEN) ? STATUS.TAKEN : STATUS.NOT_TAKEN;
}

function statusSortWeight(status) {
  return status === STATUS.TAKEN ? 2 : status === STATUS.NOT_TAKEN ? 0 : 1;
}

module.exports = {
  STATUS,
  normalizeTld,
  parseTakenJson,
  cacheCoversTld,
  resolveTakenInStatus,
  aggregateTakenInStatus,
  statusSortWeight,
};
