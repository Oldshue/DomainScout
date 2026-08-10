'use strict';

const fs = require('fs');

function finiteTime(value) {
  const time = new Date(value || '').getTime();
  return Number.isFinite(time) ? time : null;
}

function evaluateSnapshotHealth(meta, policy = {}, nowMs = Date.now()) {
  const maxAgeMs = Math.max(1, Number(policy.maxAgeMs) || 60 * 60 * 1000);
  const minCount = Math.max(0, Number(policy.minCount) || 1);
  const generatedAtMs = finiteTime(meta?.generatedAt);
  const count = Number(meta?.count || 0);
  const ageMs = generatedAtMs == null ? null : Math.max(0, nowMs - generatedAtMs);
  const lastAttempt = meta?.lastAttempt || null;

  let status = 'current';
  let reason = null;
  if (!meta || generatedAtMs == null) {
    status = 'missing';
    reason = 'No successful snapshot is available.';
  } else if (!Number.isFinite(count) || count < minCount) {
    status = 'invalid';
    reason = `Snapshot has ${Number.isFinite(count) ? count : 0} rows; at least ${minCount} are required.`;
  } else if (ageMs > maxAgeMs) {
    status = 'stale';
    reason = `Last successful snapshot is older than ${maxAgeMs} ms.`;
  }

  return {
    status,
    current: status === 'current',
    serveable: status === 'current',
    generatedAt: meta?.generatedAt || null,
    ageMs,
    maxAgeMs,
    count: Number.isFinite(count) ? count : 0,
    reason,
    lastAttempt,
    lastFailure: lastAttempt?.status === 'failed' ? lastAttempt : null,
    evidence: meta?.evidence || null,
    validation: meta?.validation || null,
  };
}

function validateSnapshotCandidate(rows, policy = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const minCount = Math.max(0, Number(policy.minCount) || 1);
  const previousCount = Math.max(0, Number(policy.previousCount) || 0);
  const maxDropFraction = Math.min(1, Math.max(0, Number(policy.maxDropFraction) || 0));
  const identityField = policy.identityField || null;
  const timestampField = policy.timestampField || null;
  const minTimestampRatio = Math.min(1, Math.max(0, Number(policy.minTimestampRatio) || 0));
  const errors = [];

  if (list.length < minCount) errors.push(`row count ${list.length} is below minimum ${minCount}`);
  if (previousCount > 0 && maxDropFraction > 0) {
    const minimumFromPrior = Math.floor(previousCount * (1 - maxDropFraction));
    if (list.length < minimumFromPrior) {
      errors.push(`row count ${list.length} fell below ${minimumFromPrior} (${Math.round(maxDropFraction * 100)}% maximum drop from ${previousCount})`);
    }
  }

  let distinctCount = null;
  if (identityField) {
    const identities = new Set();
    for (const row of list) {
      const value = String(row?.[identityField] || '').trim().toLowerCase();
      if (value) identities.add(value);
    }
    distinctCount = identities.size;
    if (distinctCount !== list.length) errors.push(`${list.length - distinctCount} rows have missing or duplicate ${identityField}`);
  }

  let validTimestampCount = null;
  let timestampRatio = null;
  if (timestampField && list.length) {
    validTimestampCount = 0;
    for (const row of list) if (finiteTime(row?.[timestampField]) != null) validTimestampCount += 1;
    timestampRatio = validTimestampCount / list.length;
    if (timestampRatio < minTimestampRatio) {
      errors.push(`${timestampField} coverage ${(timestampRatio * 100).toFixed(2)}% is below ${(minTimestampRatio * 100).toFixed(2)}%`);
    }
  }

  return {
    ok: errors.length === 0,
    count: list.length,
    previousCount,
    distinctCount,
    validTimestampCount,
    timestampRatio,
    checkedAt: new Date().toISOString(),
    errors,
  };
}

function readRefreshJournal(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function writeRefreshEvent(filePath, resourceKey, event) {
  const journal = readRefreshJournal(filePath);
  journal[resourceKey] = {
    ...event,
    recordedAt: event.recordedAt || new Date().toISOString(),
  };
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(journal, null, 2));
  fs.renameSync(tmpPath, filePath);
  return journal[resourceKey];
}

module.exports = {
  evaluateSnapshotHealth,
  validateSnapshotCandidate,
  readRefreshJournal,
  writeRefreshEvent,
};
