'use strict';

/**
 * Sale Watch: RDAP sweep of every unprobed marketplace departure.
 *
 * A homepage probe is slow (20s timeouts) and the hourly probe wave is
 * bounded, so it cannot keep pace with the volume of marketplace/parking
 * departures entering Sale Watch daily. The decisive footprint for a
 * cross-registrar sale — a registry RDAP transfer event, a pendingTransfer
 * status, or a registrar identity change — is a single fast JSON lookup.
 * This sweep runs RDAP over every freshly exited, never-probed candidate
 * first: rows with a transfer near the departure are promoted to an
 * immediate full probe, expiring names are parked on a long recheck, and
 * large bulk cohorts (portfolio migrations, e.g. Afternic -> Spaceship
 * defaults) are deferred to their existing 14-day off-market check instead
 * of spending a page-fetch probe on them. Small cohorts with no evidence
 * either way keep their existing place in the probe wave untouched.
 */

const { inspectRdap: defaultInspectRdap, mapLimit } = require('./sale-watch-discovery');
const { recordObservation } = require('./sale-watch-reconstruction');

const DEFAULT_LIMIT = 20000;
const DEFAULT_CONCURRENCY = 12;
const DEFAULT_MIN_INTERVAL_MS = 60;
const DEFAULT_SINCE_DAYS = 14;
const DEFAULT_WINDOW_DAYS = 14;
const BULK_COHORT_SIZE = 100;
const EXPIRATION_STATUSES = new Set(['redemptionperiod', 'pendingdelete']);

function isoDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function dateMinusDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function datePlusDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isExpirationStatus(rdap) {
  const statuses = Array.isArray(rdap?.statuses) ? rdap.statuses : [];
  return statuses.some(s => EXPIRATION_STATUSES.has(String(s).toLowerCase().replace(/[^a-z]/g, '')));
}

/**
 * Selects the sweep population: exited, never-probed, evidence-carrying
 * candidates whose exit falls within sinceDays of `today` and that have not
 * yet had an RDAP discovery entry recorded, ordered exit-day-desc then
 * domain so repeated bounded calls walk deterministically.
 */
function selectUnprobedDepartures(db, { limit, sinceDays, today }) {
  const cutoff = dateMinusDays(today, sinceDays);
  return db.prepare(`
    SELECT * FROM sale_watch_candidates
    WHERE state = 'exited'
      AND probe_count = 0
      AND exit_observed_day >= ?
      AND evidence_json IS NOT NULL
      AND json_extract(evidence_json, '$.discovery.rdap') IS NULL
    ORDER BY exit_observed_day DESC, domain ASC
    LIMIT ?
  `).all(cutoff, limit);
}

/**
 * Sweeps RDAP over every unprobed marketplace departure (see module
 * header). Never throws: a single domain's RDAP failure is recorded on the
 * row (as {error, checkedAt} under $.discovery.rdap, which also removes it
 * from the population on a future call) and counted in `errors`; the wave
 * continues for every other row.
 */
async function rdapSweep(db, {
  limit = DEFAULT_LIMIT,
  concurrency = DEFAULT_CONCURRENCY,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  sinceDays = DEFAULT_SINCE_DAYS,
  now,
  inspectRdap = defaultInspectRdap,
  windowDays = DEFAULT_WINDOW_DAYS,
} = {}) {
  const startedAt = Date.now();
  const nowDate = now instanceof Date ? now : now ? new Date(now) : new Date();
  const nowIso = nowDate.toISOString();
  const today = isoDay(nowDate);

  const rows = selectUnprobedDepartures(db, { limit, sinceDays, today });
  const scanned = rows.length;

  let checked = 0;
  let transfers = 0;
  let pending = 0;
  let expirations = 0;
  let deferred = 0;
  let errors = 0;
  let lastStart = 0;

  const updateEvidence = db.prepare(`
    UPDATE sale_watch_candidates
    SET evidence_json = json_set(evidence_json, '$.discovery.rdap', json(@rdap), '$.discovery.transferEvidence', json(@transferEvidence), '$.lastObservedAt', @lastObservedAt)
    WHERE domain = @domain
  `);
  const promoteRow = db.prepare(`UPDATE sale_watch_candidates SET next_probe_at = @nextProbeAt, probe_priority = 1 WHERE domain = @domain`);
  const parkExpiration = db.prepare(`UPDATE sale_watch_candidates SET state = 'parked-watch', outcome = 'expiration', next_probe_at = @nextProbeAt, probe_priority = 5 WHERE domain = @domain`);
  const deferBulk = db.prepare(`UPDATE sale_watch_candidates SET next_probe_at = @nextProbeAt, probe_priority = 4 WHERE domain = @domain`);

  const runOne = async (row) => {
    const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastStart));
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastStart = Date.now();

    checked += 1;
    let rdap;
    try {
      rdap = await inspectRdap(row.domain);
    } catch (error) {
      rdap = { error: error.message, checkedAt: new Date().toISOString() };
    }
    if (!rdap || typeof rdap !== 'object') rdap = { error: 'invalid rdap result', checkedAt: new Date().toISOString() };
    if (rdap.error) errors += 1;

    const checkedAt = rdap.checkedAt || new Date().toISOString();
    const transferEvidence = {
      transferAt: rdap.transferAt || null,
      pendingTransfer: !!rdap.pendingTransfer,
      registrarChanged: false,
      observedAt: checkedAt,
      toRegistrar: rdap.registrar || null,
    };

    updateEvidence.run({
      rdap: JSON.stringify(rdap),
      transferEvidence: JSON.stringify(transferEvidence),
      lastObservedAt: checkedAt,
      domain: row.domain,
    });
    recordObservation(db, row.domain, checkedAt, 'rdap', rdap);

    if (rdap.error) return;

    const exitDay = row.exit_observed_day;
    const transferDay = isoDay(rdap.transferAt);
    const datedTransferNear = !!(transferDay && exitDay
      && transferDay >= dateMinusDays(exitDay, windowDays)
      && transferDay <= datePlusDays(exitDay, 3));
    const pendingFlag = rdap.pendingTransfer === true;

    if (datedTransferNear || pendingFlag) {
      if (datedTransferNear) transfers += 1;
      if (pendingFlag) pending += 1;
      promoteRow.run({ nextProbeAt: nowIso, domain: row.domain });
      return;
    }

    if (isExpirationStatus(rdap)) {
      expirations += 1;
      parkExpiration.run({ nextProbeAt: new Date(nowDate.getTime() + 45 * 86400000).toISOString(), domain: row.domain });
      return;
    }

    let evidence = null;
    try { evidence = JSON.parse(row.evidence_json); } catch (_) { evidence = null; }
    const cohortSize = Number(evidence?.discovery?.movement?.cohortSize || 0);
    if (cohortSize >= BULK_COHORT_SIZE) {
      deferred += 1;
      deferBulk.run({ nextProbeAt: datePlusDays(exitDay, 14), domain: row.domain });
      return;
    }
    // Small, non-bulk cohorts with no transfer or expiration evidence keep
    // their existing next_probe_at/probe_priority — the wave already has
    // them queued.
  };

  await mapLimit(rows, concurrency, runOne);

  return {
    scanned,
    checked,
    transfers,
    pending,
    expirations,
    deferred,
    errors,
    ms: Date.now() - startedAt,
  };
}

module.exports = { rdapSweep, selectUnprobedDepartures, isExpirationStatus };
