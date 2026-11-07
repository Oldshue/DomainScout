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
 *
 * 2026-11-07: seller / marketplace departures come first. The previous order
 * (exit day desc, then domain) put the ~500/day departures from marketplace
 * DNS among ~70,000/day parking departures that share last_stream
 * 'zone-seller-departure', so a 2,000-row slice reached only a fraction of
 * them, and a name was checked once only, so a transfer landing days after
 * the departure was never seen. Now every live seller departure inside
 * sinceDays is checked first (never-checked newest first), then rechecked
 * every recheckHours (oldest check first), read from the indexed candidate
 * keys (idx_sale_watch_candidate_keys_seller); the remaining budget serves
 * the other unprobed departures as before.
 */

const { inspectRdap: defaultInspectRdap, mapLimitPaced } = require('./sale-watch-discovery');
const { recordObservation } = require('./sale-watch-reconstruction');
const K = require('./sale-watch-candidate-keys');

const DEFAULT_LIMIT = 20000;
const DEFAULT_CONCURRENCY = 12;
const DEFAULT_MIN_INTERVAL_MS = 60;
const DEFAULT_SINCE_DAYS = 14;
const DEFAULT_WINDOW_DAYS = 14;
/** Seller-departure RDAP recheck cadence inside the sinceDays window. */
const SELLER_RECHECK_HOURS = 12;
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

function recheckHours(env) {
  const n = Number(env && env.DOMAINSCOUT_SALE_WATCH_SELLER_RDAP_RECHECK_HOURS);
  return Number.isFinite(n) && n > 0 ? n : SELLER_RECHECK_HOURS;
}

/**
 * Seller / marketplace departures due an RDAP check, from the partial seller
 * index on the key table: never-checked rows (newest exit first), then rows
 * last checked at or before recheckBefore (oldest check first). Only the
 * seller population (~500/day x sinceDays) is read; candidates are fetched
 * by primary key.
 */
function selectSellerDepartures(db, { limit, cutoff, recheckBefore }) {
  if (!(limit > 0)) return [];
  const T = K.TABLE;
  const domains = db.prepare(`SELECT k.domain FROM ${T} k INDEXED BY idx_${T}_seller
    WHERE ${K.keySellerSql('k')} AND k.exit_observed_day >= @cutoff
      AND (k.rdap_at IS NULL OR k.rdap_at <= @recheckBefore)
    ORDER BY CASE WHEN k.rdap_at IS NULL THEN 0 ELSE 1 END,
      CASE WHEN k.rdap_at IS NULL THEN k.exit_observed_day END DESC,
      k.rdap_at, k.exit_observed_day DESC, k.domain
    LIMIT @limit`).all({ cutoff, recheckBefore, limit }).map(r => r.domain);
  const fetch = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?');
  return domains.map(d => fetch.get(d)).filter(Boolean).map(row => ({ ...row, _seller: true }));
}

/**
 * Selects the sweep population: exited, never-probed, evidence-carrying
 * candidates whose exit falls within sinceDays of `today` and that have not
 * yet had an RDAP discovery entry recorded, ordered exit-day-desc then
 * domain so repeated bounded calls walk deterministically. Once the candidate
 * keys are ready this reads the key table's window index (seller departures
 * are excluded: selectSellerDepartures owns them).
 */
function selectUnprobedDepartures(db, { limit, sinceDays, today, excludeSeller = false }) {
  const cutoff = dateMinusDays(today, sinceDays);
  if (!(limit > 0)) return [];
  if (K.candidateKeysReady(db)) {
    const T = K.TABLE;
    const domains = db.prepare(`SELECT k.domain FROM ${T} k INDEXED BY idx_${T}_window
      WHERE k.exit_observed_day >= ? AND k.state = 'exited' AND k.probe_count = 0 AND k.ev_valid = 1 AND k.rdap_at IS NULL
        ${excludeSeller ? 'AND NOT (k.seller_dep = 1 AND k.live = 1 AND k.eligible = 1)' : ''}
      ORDER BY k.exit_observed_day DESC, k.domain ASC
      LIMIT ?`).all(cutoff, limit).map(r => r.domain);
    const fetch = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?');
    return domains.map(d => fetch.get(d)).filter(Boolean);
  }
  // Before the keys are backfilled: the previous query, seller departures first.
  return db.prepare(`
    SELECT * FROM sale_watch_candidates
    WHERE state = 'exited'
      AND probe_count = 0
      AND exit_observed_day >= ?
      AND evidence_json IS NOT NULL
      AND json_extract(evidence_json, '$.discovery.rdap') IS NULL
    ORDER BY CASE WHEN json_extract(evidence_json, '$.discovery.movement.previousClass') = 'seller' THEN 0 ELSE 1 END,
      exit_observed_day DESC, domain ASC
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
  pacer,
  env = process.env,
} = {}) {
  const startedAt = Date.now();
  const nowDate = now instanceof Date ? now : now ? new Date(now) : new Date();
  const nowIso = nowDate.toISOString();
  const today = isoDay(nowDate);

  const cap = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : DEFAULT_LIMIT;
  const keysReady = K.candidateKeysReady(db);
  const sellerRows = keysReady ? selectSellerDepartures(db, {
    limit: cap,
    cutoff: dateMinusDays(today, sinceDays),
    recheckBefore: new Date(nowDate.getTime() - recheckHours(env) * 3600000).toISOString(),
  }) : [];
  const otherRows = selectUnprobedDepartures(db, { limit: cap - sellerRows.length, sinceDays, today, excludeSeller: keysReady });
  const rows = [...sellerRows, ...otherRows];
  const scanned = rows.length;
  const sellerUnchecked = sellerRows.filter(r => !priorRdapOf(r)).length;

  let checked = 0;
  let transfers = 0;
  let pending = 0;
  let expirations = 0;
  let deferred = 0;
  let errors = 0;
  let lastStart = 0;

  const updateEvidence = db.prepare(`
    UPDATE sale_watch_candidates
    SET evidence_json = json_set(evidence_json, '$.discovery.rdap', json(@rdap), '$.discovery.transferEvidence', json(@transferEvidence), '$.discovery.rdapCheckedAt', @lastObservedAt, '$.lastObservedAt', @lastObservedAt)
    WHERE domain = @domain
  `);
  // A failed recheck keeps the last good RDAP record; only the attempt is stamped.
  const stampAttempt = db.prepare(`
    UPDATE sale_watch_candidates
    SET evidence_json = json_set(evidence_json, '$.discovery.rdapCheckedAt', @checkedAt, '$.discovery.rdapError', @error)
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
    let evidence = null;
    try { evidence = JSON.parse(row.evidence_json); } catch (_) { evidence = null; }
    const priorRdap = evidence?.discovery?.rdap && !evidence.discovery.rdap.error ? evidence.discovery.rdap : null;
    const priorTransfer = evidence?.discovery?.transferEvidence || {};
    if (rdap.error && priorRdap) {
      stampAttempt.run({ checkedAt, error: String(rdap.error), domain: row.domain });
      return;
    }
    const transferEvidence = {
      transferAt: rdap.transferAt || priorTransfer.transferAt || null,
      pendingTransfer: !!rdap.pendingTransfer,
      registrarChanged: priorTransfer.registrarChanged === true,
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
    // A sale's transfer can land days after a seller departure: the recheck
    // window for those rows runs to the end of the sinceDays follow-up.
    const afterDays = row._seller ? Math.max(3, sinceDays) : 3;
    const datedTransferNear = !!(transferDay && exitDay
      && transferDay >= dateMinusDays(exitDay, windowDays)
      && transferDay <= datePlusDays(exitDay, afterDays));
    const pendingFlag = rdap.pendingTransfer === true;
    const probed = Number(row.probe_count) > 0;

    if (datedTransferNear || pendingFlag) {
      if (datedTransferNear) transfers += 1;
      if (pendingFlag) pending += 1;
      // A probed row is re-promoted only for new transfer evidence.
      const fresh = !probed || (datedTransferNear && rdap.transferAt !== priorRdap?.transferAt)
        || (pendingFlag && priorRdap?.pendingTransfer !== true);
      if (fresh) promoteRow.run({ nextProbeAt: nowIso, domain: row.domain });
      return;
    }

    if (probed) return;

    if (isExpirationStatus(rdap)) {
      expirations += 1;
      parkExpiration.run({ nextProbeAt: new Date(nowDate.getTime() + 45 * 86400000).toISOString(), domain: row.domain });
      return;
    }

    const cohortSize = Number(evidence?.discovery?.movement?.cohortSize || 0);
    // A seller departure is never deferred: it keeps its first probe this wave.
    if (cohortSize >= BULK_COHORT_SIZE && !row._seller) {
      deferred += 1;
      deferBulk.run({ nextProbeAt: datePlusDays(exitDay, 14), domain: row.domain });
      return;
    }
    // Small, non-bulk cohorts with no transfer or expiration evidence keep
    // their existing next_probe_at/probe_priority — the wave already has
    // them queued.
  };

  // Registries with a TLD pace policy (DOMAINSCOUT_RDAP_TLD_PACE, default .si)
  // run in their own paced lane; every other registry keeps full concurrency.
  await mapLimitPaced(rows, concurrency, runOne, { env, ...(pacer ? { pacer } : {}) });

  return {
    scanned,
    checked,
    seller: sellerRows.length,
    sellerUnchecked,
    sellerRechecked: sellerRows.length - sellerUnchecked,
    transfers,
    pending,
    expirations,
    deferred,
    errors,
    ms: Date.now() - startedAt,
  };
}

function priorRdapOf(row) {
  try { return JSON.parse(row.evidence_json)?.discovery?.rdap || null; } catch (_) { return null; }
}

module.exports = { rdapSweep, selectUnprobedDepartures, selectSellerDepartures, isExpirationStatus, SELLER_RECHECK_HOURS };
