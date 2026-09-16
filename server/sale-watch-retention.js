'use strict';

/**
 * Bounds the growth of sale_watch.db (the Sale Watch reconstruction
 * database) by deleting rows that have aged out of usefulness, per the
 * owner-defined retention policy below. All deletes happen in loops of
 * `batch` rows per transaction so interactive readers (dashboard, API)
 * never wait on a long write lock. auto_vacuum is intentionally left off in
 * production — freed pages are reused, which is enough; this module must
 * NEVER run VACUUM (that needs a full copy of the file, which is exactly
 * the disk pressure this module exists to relieve).
 *
 * Policy:
 *   a) candidates state='dropped' older than keepDroppedDays (updated_at).
 *   b) candidates whose follow-up is exhausted — state IN
 *      ('probing','parked-watch') AND next_probe_at IS NULL AND outcome IN
 *      ('no-evidence','sale-or-parking-destination') — older than
 *      keepExhaustedDays. State 'detected'/'transferring' rows are never in
 *      scope (excluded by the state filter itself); rows whose
 *      evidence_json classification is 'acquisition-candidate' or
 *      'likely-sale' are never deleted by this branch regardless of age.
 *   c) sale_watch_observations rows: kind='probe' older than
 *      keepProbeObservationDays, kind='movement' older than
 *      keepMovementObservationDays — except observations belonging to a
 *      domain still in state 'detected' or 'transferring' (those stay for
 *      as long as the candidate is actively followed).
 *   d) observations whose domain no longer has a sale_watch_candidates row
 *      at all (orphaned by a prior candidate delete in this same pass, an
 *      earlier pass, or a bug).
 *
 * All age comparisons run through SQLite's datetime() normalizer rather
 * than raw string comparison, because sale_watch_candidates.updated_at is
 * written via SQL datetime('now') ("YYYY-MM-DD HH:MM:SS") elsewhere in this
 * codebase while sale_watch_observations.observed_at is written as full
 * ISO8601 ("YYYY-MM-DDTHH:MM:SS.sssZ") — datetime() parses both and
 * normalizes them to the same comparable form. Cutoff bounds themselves are
 * computed in JS from `now`, ISO8601, the same way `datetime('now', '-N
 * days')` would express them.
 */

const DEFAULT_BATCH = 5000;
const DEFAULT_KEEP_DROPPED_DAYS = 30;
const DEFAULT_KEEP_EXHAUSTED_DAYS = 120;
const DEFAULT_KEEP_PROBE_OBSERVATION_DAYS = 180;
const DEFAULT_KEEP_MOVEMENT_OBSERVATION_DAYS = 365;

function isoCutoff(now, days) {
  return new Date(now.getTime() - days * 86400000).toISOString();
}

/**
 * Deletes rows matching `whereSql` (bound to `whereParams`) from `table` in
 * loops of `batch` rowids per transaction, so no single write lock is held
 * across more than `batch` rows. Returns the total number of rows deleted.
 */
function deleteInBatches(db, { table, whereSql, whereParams, batch }) {
  let total = 0;
  const selectStmt = db.prepare(`SELECT rowid AS rid FROM ${table} WHERE ${whereSql} LIMIT ?`);
  const deleteStmt = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
  for (;;) {
    const rows = selectStmt.all(...whereParams, batch);
    if (rows.length === 0) break;
    const runBatch = db.transaction((ids) => {
      for (const id of ids) deleteStmt.run(id);
    });
    runBatch(rows.map((row) => row.rid));
    total += rows.length;
    if (rows.length < batch) break;
  }
  return total;
}

/**
 * Runs the full retention pass once. Pure/injectable in the style of
 * server/sale-watch-reconstruction.js: `now` overrides "the current time"
 * for deterministic tests; `db` is a better-sqlite3 handle with the
 * sale-watch-reconstruction schema already applied (ensureReconstructionSchema).
 */
function runSaleWatchRetention(db, {
  now = new Date(),
  batch = DEFAULT_BATCH,
  keepDroppedDays = DEFAULT_KEEP_DROPPED_DAYS,
  keepExhaustedDays = DEFAULT_KEEP_EXHAUSTED_DAYS,
  keepProbeObservationDays = DEFAULT_KEEP_PROBE_OBSERVATION_DAYS,
  keepMovementObservationDays = DEFAULT_KEEP_MOVEMENT_OBSERVATION_DAYS,
} = {}) {
  const start = Date.now();
  const droppedCutoff = isoCutoff(now, keepDroppedDays);
  const exhaustedCutoff = isoCutoff(now, keepExhaustedDays);
  const probeCutoff = isoCutoff(now, keepProbeObservationDays);
  const movementCutoff = isoCutoff(now, keepMovementObservationDays);

  const candidatesDropped = deleteInBatches(db, {
    table: 'sale_watch_candidates',
    whereSql: `state = 'dropped' AND datetime(updated_at) < datetime(?)`,
    whereParams: [droppedCutoff],
    batch,
  });

  const candidatesExhausted = deleteInBatches(db, {
    table: 'sale_watch_candidates',
    whereSql: `state IN ('probing','parked-watch')
      AND next_probe_at IS NULL
      AND outcome IN ('no-evidence','sale-or-parking-destination')
      AND datetime(updated_at) < datetime(?)
      AND (evidence_json IS NULL OR COALESCE(json_extract(evidence_json,'$.classification'), '') NOT IN ('acquisition-candidate','likely-sale'))`,
    whereParams: [exhaustedCutoff],
    batch,
  });

  const probeObservations = deleteInBatches(db, {
    table: 'sale_watch_observations',
    whereSql: `kind = 'probe'
      AND datetime(observed_at) < datetime(?)
      AND domain NOT IN (SELECT domain FROM sale_watch_candidates WHERE state IN ('detected','transferring'))`,
    whereParams: [probeCutoff],
    batch,
  });

  const movementObservations = deleteInBatches(db, {
    table: 'sale_watch_observations',
    whereSql: `kind = 'movement'
      AND datetime(observed_at) < datetime(?)
      AND domain NOT IN (SELECT domain FROM sale_watch_candidates WHERE state IN ('detected','transferring'))`,
    whereParams: [movementCutoff],
    batch,
  });

  const orphanObservations = deleteInBatches(db, {
    table: 'sale_watch_observations',
    whereSql: `domain NOT IN (SELECT domain FROM sale_watch_candidates)`,
    whereParams: [],
    batch,
  });

  return {
    candidatesDropped,
    candidatesExhausted,
    probeObservations,
    movementObservations,
    orphanObservations,
    ms: Date.now() - start,
  };
}

module.exports = {
  runSaleWatchRetention,
  deleteInBatches,
  DEFAULT_BATCH,
  DEFAULT_KEEP_DROPPED_DAYS,
  DEFAULT_KEEP_EXHAUSTED_DAYS,
  DEFAULT_KEEP_PROBE_OBSERVATION_DAYS,
  DEFAULT_KEEP_MOVEMENT_OBSERVATION_DAYS,
};
