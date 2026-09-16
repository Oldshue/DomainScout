'use strict';

/**
 * Sale Watch: registry-transfer screen for names that go live off
 * registrar-default DNS.
 *
 * Most non-public domain sales never touch a marketplace nameserver:
 * for-sale landers on GoDaddy, Dynadot, Namecheap and Spaceship all sit on
 * registrar-default DNS, so the daily NS-movement tape only shows the name
 * later going live on hosting (registrar/other -> hosting). That alone is
 * not a sale signal (owner consolidation looks identical) — it is
 * corroborated only when the registry RDAP record shows a transfer event or
 * a pending transfer close to the move: the buyer moved the name to their
 * own registrar and built. Admitted rows are queued into
 * sale_watch_candidates for the normal probe ladder/adjudicator, never
 * treated as a sale directly.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ensureReconstructionSchema, recordObservation } = require('./sale-watch-reconstruction');
const { inspectRdap: defaultInspectRdap, mapLimit } = require('./sale-watch-discovery');
const { signalWeight } = require('./domain-signal-policy');

const DEFAULT_LIMIT = 4000;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_MIN_INTERVAL_MS = 120;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_COHORT_SIZE = 10;

function ensureTransferScreenSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_watch_transfer_screen (
      domain TEXT NOT NULL,
      day TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      transfer_at TEXT,
      registrar TEXT,
      admitted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (domain, day)
    );
  `);
}

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

function eligibleSignal(domain) {
  return signalWeight(String(domain || '').replace(/\.$/, '').split('.').at(-1)) > 0;
}

function cohortKeyOf(row) {
  return (Array.isArray(row?.today_ns) ? row.today_ns : []).slice().sort().join(',');
}

/**
 * Streams the day's movement tape line-by-line into a plain array.
 * Production tapes reach 100+ MB, so this reads via readline over a
 * fs.createReadStream (crlfDelay: Infinity, so CRLF-terminated tapes parse
 * correctly) rather than loading the whole file into memory at once.
 * Blank and malformed lines are skipped. A stream error (e.g. ENOENT)
 * propagates as a rejection with the original error, including `.code`.
 */
async function readMovementRows(tapePath) {
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(tapePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_) { /* skip malformed line */ }
  }
  return rows;
}

/**
 * Selects eligible went-live registrar/other -> hosting rows: not already a
 * sale_watch_candidates domain, not already checked for this day, cohort
 * (today_ns set, any selection) size < 10, eligible signal weight — sorted
 * by domain so repeated bounded calls walk the tape deterministically.
 */
function selectEligibleRows(db, rows, day, cohortSizes) {
  const candidateCheck = db.prepare('SELECT 1 FROM sale_watch_candidates WHERE domain = ?');
  const screenCheck = db.prepare('SELECT 1 FROM sale_watch_transfer_screen WHERE domain = ? AND day = ?');

  const eligible = [];
  for (const row of rows) {
    if (!row || !row.domain) continue;
    if (row.selection !== 'went-live') continue;
    if (!['registrar', 'other'].includes(row.prev_class)) continue;
    if (row.today_class !== 'hosting') continue;
    if (!eligibleSignal(row.domain)) continue;
    if ((cohortSizes.get(cohortKeyOf(row)) || 0) >= MAX_COHORT_SIZE) continue;
    if (candidateCheck.get(row.domain)) continue;
    if (screenCheck.get(row.domain, day)) continue;
    eligible.push(row);
  }
  eligible.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return eligible;
}

/**
 * Admits a row when the RDAP record shows a 'transfer' event dated within
 * windowDays before `day` (or up to 3 days after), or pendingTransfer is
 * true.
 */
function decideAdmission(rdap, day, windowDays) {
  if (!rdap) return { admitted: false, transferAt: null };
  if (rdap.pendingTransfer === true) return { admitted: true, transferAt: rdap.transferAt || null };
  const transferAt = rdap.transferAt || null;
  if (!transferAt) return { admitted: false, transferAt: null };
  const transferDay = isoDay(transferAt);
  if (!transferDay) return { admitted: false, transferAt };
  const earliest = dateMinusDays(day, windowDays);
  const latest = datePlusDays(day, 3);
  return { admitted: transferDay >= earliest && transferDay <= latest, transferAt };
}

/**
 * Screens one bounded slice (limit) of a day's went-live tape for names that
 * went live off registrar-default DNS, corroborating each with a bounded,
 * polite (minIntervalMs-spaced) RDAP lookup at concurrency `concurrency`.
 * Never throws — a single RDAP failure is counted in `errors` and the row is
 * still recorded as checked (transfer_at null) so it is not retried that
 * day. `exhausted` is true once no eligible rows remain, so repeated calls
 * can walk the day's tape in bounded slices.
 */
async function screenWentLiveTransfers(db, {
  directory,
  day,
  limit = DEFAULT_LIMIT,
  concurrency = DEFAULT_CONCURRENCY,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  now,
  inspectRdap = defaultInspectRdap,
  windowDays = DEFAULT_WINDOW_DAYS,
} = {}) {
  const startedAt = Date.now();
  ensureReconstructionSchema(db);
  ensureTransferScreenSchema(db);

  const tapePath = path.join(directory, day, 'ns', 'movement.jsonl');
  let rows = [];
  try {
    rows = await readMovementRows(tapePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { day, scanned: 0, eligible: 0, checked: 0, admitted: 0, errors: 0, exhausted: true, ms: Date.now() - startedAt };
    }
    throw error;
  }

  const scanned = rows.length;
  const cohortSizes = new Map();
  for (const row of rows) {
    if (!row || !Array.isArray(row.today_ns)) continue;
    const key = cohortKeyOf(row);
    cohortSizes.set(key, (cohortSizes.get(key) || 0) + 1);
  }

  const eligibleRows = selectEligibleRows(db, rows, day, cohortSizes);
  const slice = eligibleRows.slice(0, limit);
  const exhausted = slice.length >= eligibleRows.length;
  const prevDay = dateMinusDays(day, 1);
  const checkedAt = (now instanceof Date ? now : now ? new Date(now) : new Date()).toISOString();

  const insertScreen = db.prepare(`
    INSERT INTO sale_watch_transfer_screen (domain, day, checked_at, transfer_at, registrar, admitted)
    VALUES (@domain, @day, @checkedAt, @transferAt, @registrar, @admitted)
    ON CONFLICT(domain, day) DO UPDATE SET
      checked_at = excluded.checked_at,
      transfer_at = excluded.transfer_at,
      registrar = excluded.registrar,
      admitted = excluded.admitted
  `);

  const insertCandidate = db.prepare(`
    INSERT OR IGNORE INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, last_price, outcome, outcome_tier, evidence_json, updated_at)
    VALUES (@domain, @firstSeenDay, @day, 'transfer-departure', @day, 'exited', @day, 0, NULL, NULL, NULL, @evidenceJson, @updatedAt)
  `);

  let admitted = 0;
  let errors = 0;
  let lastStart = 0;

  const runOne = async (row) => {
    const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastStart));
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastStart = Date.now();

    let rdap = null;
    let errored = false;
    try {
      rdap = await inspectRdap(row.domain);
    } catch (_) {
      errored = true;
    }

    if (errored) {
      errors += 1;
      insertScreen.run({ domain: row.domain, day, checkedAt, transferAt: null, registrar: null, admitted: 0 });
      return;
    }

    const { admitted: isAdmitted, transferAt } = decideAdmission(rdap, day, windowDays);
    insertScreen.run({
      domain: row.domain,
      day,
      checkedAt,
      transferAt: transferAt || null,
      registrar: rdap?.registrar || null,
      admitted: isAdmitted ? 1 : 0,
    });

    if (!isAdmitted) return;

    admitted += 1;
    const movement = {
      day,
      prevDay,
      previousNameservers: row.prev_ns || [],
      currentNameservers: row.today_ns || [],
      previousProvider: row.prev_provider || null,
      currentProvider: row.today_provider || null,
      previousClass: row.prev_class,
      currentClass: row.today_class,
      destinationProbe: row.probe || null,
      source: 'daily-zone-delegation-diff',
      sourceUrl: `/api/universe/ns-movement?day=${day}&q=${encodeURIComponent(row.domain)}`,
      cohortSize: cohortSizes.get(cohortKeyOf(row)) || 1,
    };
    const evidence = {
      domain: row.domain,
      tier: 'suspected',
      sellerNameservers: row.prev_ns || [],
      buyerNameservers: row.today_ns || [],
      reportDate: day,
      venue: row.prev_provider || null,
      discovery: {
        movement,
        structurallyMoved: true,
        departureDate: day,
        registrarOrigin: true,
        rdap,
        transferEvidence: { transferAt, registrarChanged: false, observedAt: checkedAt, toRegistrar: rdap?.registrar || null },
      },
    };
    insertCandidate.run({
      domain: row.domain,
      firstSeenDay: prevDay,
      day,
      evidenceJson: JSON.stringify(evidence),
      updatedAt: checkedAt,
    });
    recordObservation(db, row.domain, checkedAt, 'movement', movement);
  };

  await mapLimit(slice, concurrency, runOne);

  return {
    day,
    scanned,
    eligible: eligibleRows.length,
    checked: slice.length,
    admitted,
    errors,
    exhausted,
    ms: Date.now() - startedAt,
  };
}

module.exports = { ensureTransferScreenSchema, screenWentLiveTransfers };
