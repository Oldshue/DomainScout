'use strict';

/**
 * Portfolio Engine — Stage 1-3 of the self-driving acquisition engine.
 *
 * Turns the NRD registration lane already captured in zone_index.db
 * (zone_daily_tokens) into a stage-classified acquisition board: which
 * naming grids are FORMING (<40% consumed, demand rising), MID-CURVE, or
 * LATE, and which specific .com names to hand-register today.
 *
 * House style of server/registration-clusters.js: caller passes
 * better-sqlite3 handles (db = sale_watch.db for engine state/boards,
 * zoneDb = zone_index.db for demand signals); every side-effecting
 * dependency is opts-injectable; orchestrators never throw.
 * [PortfolioEngine] log prefix throughout. No module-opened connections.
 * checkAvailability()/inspectCell() are the only network calls this module
 * makes, and only when actually invoked — nothing runs at require-time.
 *
 * Stage 3 adds: RDAP-dated curve position per grid cell (registered_at),
 * humanoid-ops / datacenter-land / power-siting grid classes, and
 * burst-aware demand (single-day spikes no longer masquerade as sustained
 * multi-day slope).
 */

const DEFAULT_RDAP_BUDGET = 150;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_SPACING_MS = 150;
const DEFAULT_MIN_CHECKED_FRACTION = 0.6;
const RDAP_TIMEOUT_MS = 12000;

// Grid template data: literal, auditable cross-product lists.
const METROS = [
  'houston', 'dallas', 'phoenix', 'atlanta', 'miami', 'denver', 'austin',
  'sanantonio', 'charlotte', 'nashville', 'tampa', 'orlando', 'memphis',
  'columbus', 'indianapolis',
];
const METRO_SUFFIXES = ['homebattery', 'batterystorage', 'evcharger', 'evcharging', 'heatpumps'];

const VERTICALS = [
  'dental', 'legal', 'medical', 'roofing', 'hvac', 'restaurant', 'realty',
  'logistics', 'insurance', 'accounting', 'plumbing', 'veterinary',
];
const AI_BUYER_PLURALS = [
  'dentists', 'lawyers', 'roofers', 'realtors', 'plumbers', 'restaurants',
  'contractors', 'accountants',
];

const TRADES = [
  'roofing', 'hvac', 'plumbing', 'fencing', 'paving', 'concrete', 'solar',
  'evcharger', 'evcharging', 'heatpump', 'junkremoval', 'pressurewashing',
];
const MONEY_FORMS = ['quotes', 'estimates', 'bids'];

const HUMANOID_OPS_SUFFIXES = [
  'quotes', 'pricing', 'bids', 'estimates', 'subscriptions', 'fleetops',
  'deployments', 'rollout', 'onboarding', 'supervisors', 'teleoperators',
  'shifts', 'installers', 'helpdesk', 'retrofit', 'audits', 'benefits',
  'nursing', 'hospitality', 'housekeeping', 'janitorial', 'kitchens',
  'fulfillment', 'picking', 'painting', 'roofing', 'integrator',
];

const DATACENTER_LAND_SUFFIXES = [
  'permits', 'rezoning', 'entitlements', 'waterrights', 'landsales',
  'landleases', 'landowners', 'landlords', 'landvalues', 'appraisals',
  'parcels', 'acres', 'landbrokers', 'substations', 'transformers',
  'gasturbines', 'pipelines', 'lenders', 'abatements', 'neighbors',
  'excavation', 'earthwork', 'sitework', 'surveying', 'rebar', 'paving',
  'welding', 'millwright', 'laborers', 'janitorial', 'securityguards',
  'catering',
];

const POWER_SITING_CANDIDATES = [
  'nuclearpermits', 'nuclearzoning', 'nuclearsiting', 'nuclearentitlements',
  'smrpermits', 'smrzoning', 'smrsiting', 'reactorpermits', 'gridpermits',
  'substationpermits', 'transmissionpermits', 'interconnectionpermits',
  'poweredlandbrokers', 'poweredlandsales', 'poweredlots',
  'energizedparcels', 'energizedacres', 'energizedlots',
];

/**
 * Builds CLASSES from the template data: one class per metro suffix
 * (metro x suffix), one class per vertical-ai template shape, one combined
 * money-form class (trade x quote/estimate/bid), plus the stage-3
 * humanoid-ops / datacenter-land / power-siting classes. ~155+90
 * candidates total.
 */
function buildClasses() {
  const classes = [];

  for (const suffix of METRO_SUFFIXES) {
    classes.push({
      id: `metro-${suffix}`,
      kind: 'metro',
      buyerNote: `Local ${suffix} installers/dealers wanting a city-branded .com`,
      candidates: METROS.map((metro) => `${metro}${suffix}.com`),
    });
  }

  classes.push({
    id: 'vertical-aiautomation',
    kind: 'vertical-aiautomation',
    buyerNote: 'AI-automation agencies/SaaS selling into a single vertical',
    candidates: VERTICALS.map((v) => `${v}aiautomation.com`),
  });

  classes.push({
    id: 'aiautomationfor',
    kind: 'aiautomationfor',
    buyerNote: 'AI-automation agencies pitching a named buyer persona',
    candidates: AI_BUYER_PLURALS.map((buyer) => `aiautomationfor${buyer}.com`),
  });

  const agentCandidates = [];
  for (const v of VERTICALS) {
    agentCandidates.push(`${v}agents.com`, `${v}agent.com`);
  }
  classes.push({
    id: 'vertical-agents',
    kind: 'vertical-agents',
    buyerNote: 'AI-agent vendors/resellers branding by vertical',
    candidates: agentCandidates,
  });

  const moneyCandidates = [];
  for (const trade of TRADES) {
    for (const form of MONEY_FORMS) moneyCandidates.push(`${trade}${form}.com`);
  }
  classes.push({
    id: 'money-form',
    kind: 'money-form',
    buyerNote: 'Lead-gen operators selling trade quote/estimate/bid funnels',
    candidates: moneyCandidates,
  });

  classes.push({
    id: 'humanoid-ops',
    kind: 'humanoid-ops',
    buyerNote: 'humanoid-robot integrators/operators/fleet owners',
    candidates: HUMANOID_OPS_SUFFIXES.map((s) => `humanoid${s}.com`),
  });

  classes.push({
    id: 'datacenter-land',
    kind: 'datacenter-land',
    buyerNote: 'data-center developers, land brokers, permitting consultants, site contractors',
    candidates: DATACENTER_LAND_SUFFIXES.map((s) => `datacenter${s}.com`),
  });

  classes.push({
    id: 'power-siting',
    kind: 'power-siting',
    buyerNote: 'nuclear/SMR developers, grid interconnection and energized-land brokers',
    candidates: POWER_SITING_CANDIDATES.map((s) => `${s}.com`),
  });

  return classes;
}

const CLASSES = buildClasses();

// Demand token(s) per class for classSignals' zone_daily_tokens LIKE match
// (substring match, so singular tokens also catch plural forms).
const DEMAND_TOKENS = {
  'metro-homebattery': ['homebattery'],
  'metro-batterystorage': ['batterystorage'],
  'metro-evcharger': ['evcharger'],
  'metro-evcharging': ['evcharging'],
  'metro-heatpumps': ['heatpump'],
  'vertical-aiautomation': ['aiautomation'],
  'aiautomationfor': ['aiautomation'],
  'vertical-agents': ['agent'],
  'money-form': ['quote', 'estimate', 'bid'],
  'humanoid-ops': ['humanoid'],
  'datacenter-land': ['datacenter'],
  'power-siting': ['nuclear', 'smr', 'interconnection'],
};

// 2-part templates (metro+suffix, vertical+aiautomation, vertical+agent(s),
// trade+form) read as 2 words; aiautomationfor{buyer} reads as 3+.
function wordCountFactorForKind(kind) {
  return kind === 'aiautomationfor' ? 0.85 : 1.25;
}

// Full-domain-string length bucketing (includes the .com suffix).
function lengthFactor(domain) {
  const len = String(domain || '').length;
  if (len <= 14) return 1.15;
  if (len >= 20) return 0.8;
  return 1.0;
}

function dateMinusDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Creates (IF NOT EXISTS) the tables this module owns on db (sale_watch.db),
 * and adds the registered_at column to portfolio_grid_state (stage-3 curve
 * position) if an earlier install predates it — guarded by a PRAGMA
 * table_info check so this is safe to call every time.
 */
function ensureEngineSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_grid_state (
      class_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      status TEXT,
      checked_at TEXT,
      PRIMARY KEY (class_id, domain)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS portfolio_boards (
      day TEXT PRIMARY KEY,
      board_json TEXT,
      created_at TEXT
    );
  `);

  const cols = db.prepare('PRAGMA table_info(portfolio_grid_state)').all();
  const hasRegisteredAt = cols.some((c) => c.name === 'registered_at');
  if (!hasRegisteredAt) {
    db.exec('ALTER TABLE portfolio_grid_state ADD COLUMN registered_at TEXT');
  }
}

/**
 * RDAP inspection for one .com domain: on HTTP 200 parses the JSON body and
 * reads events[].eventAction === 'registration' -> eventDate for curve
 * position. Returns { status, registeredAt }: status is
 * 'taken'|'available'|'unknown' (HTTP 200 / 404 / anything else, including
 * network errors and body-parse failures) — never throws. registeredAt is
 * null unless a 200 response yields a parseable registration eventDate.
 * Injectable via opts.check in callers for tests; opts.fetch overrides the
 * fetch implementation directly.
 */
async function inspectCell(domain, opts = {}) {
  const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return { status: 'unknown', registeredAt: null };
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(RDAP_TIMEOUT_MS)
      : undefined;
    const response = await fetchFn(`https://rdap.verisign.com/com/v1/domain/${domain}`, { signal });
    if (response.status === 200) {
      let registeredAt = null;
      try {
        const body = await response.json();
        const events = Array.isArray(body && body.events) ? body.events : [];
        const regEvent = events.find((e) => e && e.eventAction === 'registration');
        if (regEvent && regEvent.eventDate) registeredAt = regEvent.eventDate;
      } catch (_) {
        // Body wasn't parseable JSON; status is still known.
      }
      return { status: 'taken', registeredAt };
    }
    if (response.status === 404) return { status: 'available', registeredAt: null };
    return { status: 'unknown', registeredAt: null };
  } catch (_) {
    return { status: 'unknown', registeredAt: null };
  }
}

/**
 * Back-compat string-returning wrapper around inspectCell for existing
 * callers/tests: 'taken'|'available'|'unknown'. Never throws.
 */
async function checkAvailability(domain, opts = {}) {
  const result = await inspectCell(domain, opts);
  return result.status;
}

/**
 * Re-checks grid cells oldest-first (never-checked cells first), spending
 * at most `budget` RDAP calls (opts.budget, else env
 * DOMAINSCOUT_ENGINE_RDAP_BUDGET, else DEFAULT_RDAP_BUDGET/day). Bounded
 * concurrency of DEFAULT_CONCURRENCY workers, each pausing
 * DEFAULT_SPACING_MS before every check (politeness toward RDAP). Upserts
 * results into portfolio_grid_state with checked_at, and registered_at
 * when the injected check returns an object with registeredAt (accepts
 * both string and object results from `check` for backward compatibility
 * with existing tests). opts.check overrides the checker (test injection
 * point); opts is also forwarded to it. Never throws.
 */
async function refreshGridState(db, opts = {}) {
  try {
    ensureEngineSchema(db);
    const budget = Number.isFinite(opts.budget) && opts.budget > 0
      ? Math.floor(opts.budget)
      : (parseInt(process.env.DOMAINSCOUT_ENGINE_RDAP_BUDGET, 10) || DEFAULT_RDAP_BUDGET);
    const checkFn = opts.check || checkAvailability;

    const stateRows = db.prepare('SELECT class_id, domain, checked_at FROM portfolio_grid_state').all();
    const stateMap = new Map();
    for (const row of stateRows) stateMap.set(`${row.class_id} ${row.domain}`, row.checked_at || null);

    const cells = [];
    for (const cls of CLASSES) {
      for (const domain of cls.candidates) {
        const key = `${cls.id} ${domain}`;
        cells.push({ classId: cls.id, domain, checkedAt: stateMap.has(key) ? stateMap.get(key) : null });
      }
    }

    // Never-checked cells first, then oldest checked_at ascending.
    cells.sort((a, b) => {
      if (!a.checkedAt && !b.checkedAt) return 0;
      if (!a.checkedAt) return -1;
      if (!b.checkedAt) return 1;
      return a.checkedAt < b.checkedAt ? -1 : (a.checkedAt > b.checkedAt ? 1 : 0);
    });

    const targets = cells.slice(0, budget);
    const upsert = db.prepare(`
      INSERT INTO portfolio_grid_state (class_id, domain, status, checked_at, registered_at)
      VALUES (@classId, @domain, @status, @checkedAt, @registeredAt)
      ON CONFLICT(class_id, domain) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at, registered_at = excluded.registered_at
    `);

    const summary = { checked: 0, available: 0, taken: 0, unknown: 0 };
    let cursor = 0;

    async function worker() {
      while (cursor < targets.length) {
        const cell = targets[cursor++];
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_SPACING_MS));
        let status = 'unknown';
        let registeredAt = null;
        try {
          const result = await checkFn(cell.domain, opts);
          if (result && typeof result === 'object') {
            status = result.status || 'unknown';
            registeredAt = result.registeredAt || null;
          } else {
            status = result || 'unknown';
          }
        } catch (_) {
          status = 'unknown';
        }
        const checkedAt = new Date().toISOString();
        try {
          upsert.run({ classId: cell.classId, domain: cell.domain, status, checkedAt, registeredAt });
        } catch (err) {
          console.warn(`[PortfolioEngine] refreshGridState: upsert failed for ${cell.domain}: ${err.message}`);
        }
        summary.checked += 1;
        if (status === 'available') summary.available += 1;
        else if (status === 'taken') summary.taken += 1;
        else summary.unknown += 1;
      }
    }

    const poolSize = Math.min(DEFAULT_CONCURRENCY, targets.length);
    const workers = [];
    for (let i = 0; i < poolSize; i++) workers.push(worker());
    await Promise.all(workers);

    return summary;
  } catch (err) {
    console.warn(`[PortfolioEngine] refreshGridState failed: ${err.message}`);
    return { checked: 0, available: 0, taken: 0, unknown: 0 };
  }
}

/**
 * Demand signals for one class's token(s) over the last 30 days of
 * zone_daily_tokens (tld='com'), share-weighted against that day's total
 * .com registrations (zone_daily_stats.new_count). Cheap: two aggregate
 * SQL queries against a <=30-row window. Returns totalRegs, activeDays
 * (days with >=1 reg), maxDayShare (burst), and slope (last-10-days share
 * minus first-10-days share of the 30-day window) — burst-aware: when
 * maxDayShare >= 0.2 (a single day dominates the window) slope is
 * suppressed to 0 and demandBasis is 'burst-suppressed' instead of
 * 'multi-day', so a one-day spike can't masquerade as sustained demand.
 * Never throws.
 */
function classSignals(zoneDb, classId) {
  const empty = { totalRegs: 0, activeDays: 0, maxDayShare: 0, slope: 0, burstFlag: false, demandBasis: 'multi-day' };
  try {
    const tokens = DEMAND_TOKENS[classId] || [];
    if (!tokens.length) return empty;

    const maxDayRow = zoneDb.prepare("SELECT MAX(report_date) AS day FROM zone_daily_tokens WHERE tld = 'com'").get();
    const endDay = (maxDayRow && maxDayRow.day) || new Date().toISOString().slice(0, 10);
    const startDay = dateMinusDays(endDay, 29);
    const first10End = dateMinusDays(startDay, -9);
    const last10Start = dateMinusDays(endDay, 9);

    const likeClauses = tokens.map(() => 'token LIKE ?').join(' OR ');
    const likeParams = tokens.map((t) => `%${t}%`);

    const tokenRows = zoneDb.prepare(`
      SELECT report_date, SUM(reg_count) AS regs
      FROM zone_daily_tokens
      WHERE tld = 'com' AND report_date >= ? AND report_date <= ? AND (${likeClauses})
      GROUP BY report_date
    `).all(startDay, endDay, ...likeParams);

    const totalRows = zoneDb.prepare(`
      SELECT stat_date, SUM(new_count) AS total
      FROM zone_daily_stats
      WHERE tld = 'com' AND stat_date >= ? AND stat_date <= ?
      GROUP BY stat_date
    `).all(startDay, endDay);

    const totalByDay = new Map();
    for (const row of totalRows) totalByDay.set(row.stat_date, row.total || 0);

    let totalRegs = 0;
    let activeDays = 0;
    let maxDayRegs = 0;
    let firstRegs = 0;
    let firstTotal = 0;
    let lastRegs = 0;
    let lastTotal = 0;

    for (const row of tokenRows) {
      const regs = row.regs || 0;
      totalRegs += regs;
      if (regs > 0) activeDays += 1;
      const total = totalByDay.get(row.report_date) || 0;
      if (regs > maxDayRegs) maxDayRegs = regs;
      if (row.report_date <= first10End) { firstRegs += regs; firstTotal += total; }
      if (row.report_date >= last10Start) { lastRegs += regs; lastTotal += total; }
    }

    const firstShare = firstTotal > 0 ? firstRegs / firstTotal : 0;
    const lastShare = lastTotal > 0 ? lastRegs / lastTotal : 0;
    const rawSlope = lastShare - firstShare;
    // Burst = one day's share of the CLASS's own registrations in the window
    // (single-actor kits register 20-40 names in a day); share-of-all-.com is
    // the wrong denominator for this and never crosses the threshold.
    const maxDayShare = totalRegs > 0 ? maxDayRegs / totalRegs : 0;
    const burstFlag = maxDayShare >= 0.2;
    const slope = burstFlag ? 0 : rawSlope;
    const demandBasis = burstFlag ? 'burst-suppressed' : 'multi-day';

    return { totalRegs, activeDays, maxDayShare, slope, burstFlag, demandBasis };
  } catch (err) {
    console.warn(`[PortfolioEngine] classSignals failed for ${classId}: ${err.message}`);
    return empty;
  }
}

/**
 * Builds today's acquisition board from portfolio_grid_state (checked
 * cells) and classSignals (demand). Only classes with >= minCheckedFraction
 * (default DEFAULT_MIN_CHECKED_FRACTION) of their cells checked are staged.
 * consumption = taken/(taken+available); base stage = FORMING (<0.4), MID
 * (0.4-0.75), LATE (>0.75). Curve position per class: curve =
 * { takenTotal, takenLast180d, takenLast30d, activeFront } computed from
 * registered_at on taken cells relative to `day`; activeFront =
 * takenLast180d / takenTotal (0 when takenTotal is 0 or no dates known).
 * Stage refinement layered on top of the base stage: consumption >= 0.75
 * with activeFront >= 0.2 is relabelled 'LATE-ACTIVE' (grid being finished
 * off right now); consumption < 0.4 with activeFront >= 0.3 is relabelled
 * 'FORMING-HOT'. Each AVAILABLE cell is scored: stageWeight (base FORMING
 * with positive slope and activeDays>=15: 5; plain base FORMING: 3; MID: 4;
 * LATE: 2) x wordCountFactor x lengthFactor, then x1.2 for FORMING-HOT or
 * x1.1 for LATE-ACTIVE cells. Persists the board (INSERT OR REPLACE by
 * day) into portfolio_boards and returns it: { day, classes, buys: top 40,
 * carry: next 20 }. Never throws.
 */
function classThemeRegexForClass(classId) {
  const tokens = DEMAND_TOKENS[classId] || [];
  return tokens.length ? tokens.join('|') : null;
}

/**
 * Resolves the comps lookup function for buildBoard: when the caller
 * explicitly passed opts.comps, use it verbatim (a function, or null/
 * anything non-function to disable comps). Otherwise default to a
 * compsForShape(db, shapeQuery) binding from server/sales-comps.js when the
 * sales_comps table exists on db, else null. Never throws.
 */
function resolveCompsFn(db, opts) {
  if (Object.prototype.hasOwnProperty.call(opts, 'comps')) {
    return typeof opts.comps === 'function' ? opts.comps : null;
  }
  try {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sales_comps'").get();
    if (!row) return null;
    const { compsForShape } = require('./sales-comps');
    return (shapeQuery) => compsForShape(db, shapeQuery);
  } catch (_) {
    return null;
  }
}

/**
 * Computes { twoWord, any } comps for one class via compsFn, using a theme
 * regex derived from DEMAND_TOKENS (joined with '|'). Never throws; returns
 * null when compsFn is unavailable or either lookup fails.
 */
function computeClassComps(compsFn, classId) {
  if (typeof compsFn !== 'function') return null;
  try {
    const classThemeRegex = classThemeRegexForClass(classId);
    return {
      twoWord: compsFn({ wordCount: 2, theme: classThemeRegex }),
      any: compsFn({ theme: classThemeRegex }),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Classifies a class's comps.any into a buy/carry row's priceTier:
 * 'retail-comped' (>=5 public comps; carries the median), 'thin-comps'
 * (1-4), or 'no-public-comps' (0, or comps unavailable) -- the honest label
 * for classes whose sales happen below the public reporting floor.
 */
function priceTierForClassComps(classComps) {
  const anyN = classComps && classComps.any ? Number(classComps.any.n) || 0 : 0;
  if (anyN >= 5) return { priceTier: 'retail-comped', compsMedian: classComps.any.median ?? null };
  if (anyN >= 1) return { priceTier: 'thin-comps', compsMedian: null };
  return { priceTier: 'no-public-comps', compsMedian: null };
}

function buildBoard(db, zoneDb, opts = {}) {
  const day = opts.day || new Date().toISOString().slice(0, 10);
  try {
    ensureEngineSchema(db);
    const minCheckedFraction = Number.isFinite(opts.minCheckedFraction) && opts.minCheckedFraction >= 0
      ? opts.minCheckedFraction
      : DEFAULT_MIN_CHECKED_FRACTION;
    const compsFn = resolveCompsFn(db, opts);

    const stateRows = db.prepare('SELECT class_id, domain, status, registered_at FROM portfolio_grid_state').all();
    const byClass = new Map();
    for (const row of stateRows) {
      if (!byClass.has(row.class_id)) byClass.set(row.class_id, []);
      byClass.get(row.class_id).push(row);
    }

    const day180 = dateMinusDays(day, 180);
    const day30 = dateMinusDays(day, 30);

    const classSummaries = [];
    const availableCells = [];

    for (const cls of CLASSES) {
      const rows = byClass.get(cls.id) || [];
      const totalCells = cls.candidates.length;
      const checkedFraction = totalCells > 0 ? rows.length / totalCells : 0;
      if (checkedFraction < minCheckedFraction) continue;

      let taken = 0;
      let available = 0;
      let takenLast180d = 0;
      let takenLast30d = 0;
      const availDomains = [];
      for (const row of rows) {
        if (row.status === 'taken') {
          taken += 1;
          const ra = row.registered_at ? String(row.registered_at).slice(0, 10) : null;
          if (ra && ra >= day180) takenLast180d += 1;
          if (ra && ra >= day30) takenLast30d += 1;
        } else if (row.status === 'available') { available += 1; availDomains.push(row.domain); }
      }
      const denom = taken + available;
      const consumption = denom > 0 ? taken / denom : 0;
      const activeFront = taken > 0 ? takenLast180d / taken : 0;
      const curve = { takenTotal: taken, takenLast180d, takenLast30d, activeFront };

      let baseStage = 'MID';
      if (consumption < 0.4) baseStage = 'FORMING';
      else if (consumption > 0.75) baseStage = 'LATE';

      let refinedLabel = null;
      if (consumption >= 0.75 && activeFront >= 0.2) refinedLabel = 'LATE-ACTIVE';
      else if (consumption < 0.4 && activeFront >= 0.3) refinedLabel = 'FORMING-HOT';
      const displayStage = refinedLabel || baseStage;

      const demand = classSignals(zoneDb, cls.id);
      const classComps = computeClassComps(compsFn, cls.id);
      classSummaries.push({ id: cls.id, stage: displayStage, consumption, demand, checkedFraction, curve, comps: classComps });

      for (const domain of availDomains) {
        availableCells.push({ domain, classId: cls.id, kind: cls.kind, baseStage, refinedLabel, demand, classComps });
      }
    }

    const scored = availableCells.map((cell) => {
      let stageWeight;
      if (cell.baseStage === 'FORMING' && cell.demand.slope > 0 && cell.demand.activeDays >= 15) stageWeight = 5;
      else if (cell.baseStage === 'MID') stageWeight = 4;
      else if (cell.baseStage === 'LATE') stageWeight = 2;
      else stageWeight = 3; // plain FORMING, demand not yet confirmed rising
      let score = stageWeight * wordCountFactorForKind(cell.kind) * lengthFactor(cell.domain);
      if (cell.refinedLabel === 'FORMING-HOT') score *= 1.2;
      else if (cell.refinedLabel === 'LATE-ACTIVE') score *= 1.1;
      const { priceTier, compsMedian } = priceTierForClassComps(cell.classComps);
      return {
        domain: cell.domain,
        class: cell.classId,
        stage: cell.refinedLabel || cell.baseStage,
        score,
        priceTier,
        ...(priceTier === 'retail-comped' ? { compsMedian } : {}),
      };
    });
    scored.sort((a, b) => b.score - a.score);

    const board = {
      day,
      classes: classSummaries,
      buys: scored.slice(0, 40),
      carry: scored.slice(40, 60),
    };

    db.prepare(`
      INSERT OR REPLACE INTO portfolio_boards (day, board_json, created_at)
      VALUES (@day, @boardJson, datetime('now'))
    `).run({ day, boardJson: JSON.stringify(board) });

    return board;
  } catch (err) {
    console.warn(`[PortfolioEngine] buildBoard failed: ${err.message}`);
    return { day, classes: [], buys: [], carry: [] };
  }
}

/**
 * Never-throw daily orchestrator. Skips (ran:false) if today's board
 * already exists in portfolio_boards, unless opts.force. Otherwise runs
 * refreshGridState then buildBoard, logs one summary line, and returns
 * {ran, day, summary}.
 */
async function runDailyEngine(db, zoneDb, opts = {}) {
  const day = opts.day || new Date().toISOString().slice(0, 10);
  try {
    ensureEngineSchema(db);

    if (!opts.force) {
      const existing = db.prepare('SELECT 1 FROM portfolio_boards WHERE day = ? LIMIT 1').get(day);
      if (existing) {
        console.log(`[PortfolioEngine] runDailyEngine: ${day} already boarded, skipping`);
        return { ran: false, day, summary: null };
      }
    }

    const refreshFn = opts.refreshGridState || refreshGridState;
    await refreshFn(db, { budget: opts.budget, check: opts.check });

    const buildFn = opts.buildBoard || buildBoard;
    const board = await buildFn(db, zoneDb, { day, minCheckedFraction: opts.minCheckedFraction });

    const forming = (board.classes || []).filter((c) => c.stage === 'FORMING' || c.stage === 'FORMING-HOT').length;
    const summary = `board ${day}: ${(board.classes || []).length} classes staged, ${(board.buys || []).length} buys (${forming} forming)`;
    console.log(`[PortfolioEngine] ${summary}`);

    return { ran: true, day, summary };
  } catch (err) {
    console.warn(`[PortfolioEngine] runDailyEngine failed: ${err.message}`);
    return { ran: false, day, summary: null, error: err.message };
  }
}

/** Returns the latest (or given day's) parsed board, or null. Never throws. */
function readBoard(db, opts = {}) {
  try {
    const row = opts.day
      ? db.prepare('SELECT board_json FROM portfolio_boards WHERE day = ?').get(opts.day)
      : db.prepare('SELECT board_json FROM portfolio_boards ORDER BY day DESC LIMIT 1').get();
    if (!row || !row.board_json) return null;
    return JSON.parse(row.board_json);
  } catch (err) {
    console.warn(`[PortfolioEngine] readBoard failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  ensureEngineSchema,
  checkAvailability,
  inspectCell,
  refreshGridState,
  classSignals,
  buildBoard,
  runDailyEngine,
  readBoard,
  CLASSES,
  DEMAND_TOKENS,
  DEFAULT_RDAP_BUDGET,
  DEFAULT_CONCURRENCY,
  DEFAULT_SPACING_MS,
  DEFAULT_MIN_CHECKED_FRACTION,
};
