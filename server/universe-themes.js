'use strict';

// Serves the vendored theme-convergence engine (scripts/universe/theme-convergence.py +
// mine-universe-types.py) over one of two engine inputs, selected by `source`:
//   - source=registrations (default, unchanged): the cloud universe lane's per-day
//     tapes (<universeDir>/<day>/tape/adds.tsv) -- daily CZDS registration adds.
//   - source=sales: the Sale Watch likely-sale ledger's admitted rows (tier
//     verified/probable/suspected; never excluded, owner-migration, transfer-only
//     or single-actor portfolio-kit "platform" rows) whose reportDate falls in the
//     requested span, adapted into the identical label\tzone\twindow_start tape
//     shape by server/sale-watch-theme-source.js. Raw nameserver departures are
//     never used directly: most are platform, expiry and portfolio noise that the
//     ledger's classifier has already adjudicated.
// This module never reimplements the engine's scoring logic (independence breadth,
// kit collapse, rise-vs-reference); for source=sales it additionally computes
// buyer-independence stats (buyers, topBuyerShare, builtCount, buyerIndependence)
// from the engine's full member list, entirely in this JS layer, and uses them to
// rank themes carried by many independent built buyers above themes carried by one
// destination set. It otherwise only:
//   1. builds a python work dir with the requested span's tape (and, separately,
//      the reference span's tape) per source, reporting any missing days/entries
//      instead of silently dropping them,
//   2. shells out to the vendored scripts exactly as the MacBook lane does,
//   3. reshapes theme-convergence.json into the documented API response shape,
//   4. persists the full result durably, keyed by source (and, for sales, kept
//      fresh against the ledger's classifier version) so repeat reads are free,
//   5. runs on-demand ranges as a bounded, deduplicated background job per
//      (source, range) so the request thread is never blocked and the same
//      (source, range) is never computed twice concurrently.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  likelySalesInSpan,
  buildSalesTape,
  buyerSignature,
  computeThemeBuyerStats,
  buildSalesExample,
} = require('./sale-watch-theme-source');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 7;
const ENGINE_VERSION = 'theme-convergence-v1';
const SOURCES = ['registrations', 'sales'];
const DEFAULT_SOURCE = 'registrations';

// Engine minimums passed to scripts/universe/theme-convergence.py via --options.
// DEFAULT_ENGINE_OPTIONS reproduces exactly the script's own pre-existing
// hardcoded constants (tuned for registration-scale tapes: millions of daily
// CZDS adds), so source=registrations always passes these and its persisted
// output stays byte-identical to before this parameterization existed.
// SALES_ENGINE_OPTIONS scales those same minimums to the Sale Watch
// likely-sale ledger's much smaller per-week input (a few hundred to a few
// thousand labels): three to five independent buyers of one construction is
// the signal, and one-word (single-token) names must contribute their token.
const DEFAULT_ENGINE_OPTIONS = Object.freeze({
  themeMin: 12,
  memberMin: 12,
  familyRootMin: 20,
  risingIndependentRootsMin: 10,
  newIndependentRootsMin: 8,
  minTokens: 2,
  alwaysRank: false,
});
const SALES_ENGINE_OPTIONS = Object.freeze({
  themeMin: 3,
  memberMin: 3,
  familyRootMin: 5,
  risingIndependentRootsMin: 3,
  newIndependentRootsMin: 3,
  minTokens: 1,
  alwaysRank: true,
});

function engineOptionsFor(source) {
  return source === 'sales' ? SALES_ENGINE_OPTIONS : DEFAULT_ENGINE_OPTIONS;
}

// Deterministic short digest of an engine-options object, independent of key
// insertion order, used to (a) distinguish sales results computed under
// different minimums in the persisted-result path / in-memory job key, so a
// future change to SALES_ENGINE_OPTIONS (or an explicit override, e.g. in
// tests) transparently invalidates any previously stored sales result for the
// same range instead of serving it stale, and (b) never affects the
// registrations key/path format, which stays exactly the pre-existing bare
// "from:to:refFrom:refTo" string.
const ENGINE_OPTIONS_DIGEST_KEYS = ['themeMin', 'memberMin', 'familyRootMin', 'risingIndependentRootsMin', 'newIndependentRootsMin', 'minTokens', 'alwaysRank'];
function engineOptionsDigest(options) {
  const canonical = ENGINE_OPTIONS_DIGEST_KEYS.map(k => `${k}=${JSON.stringify(options[k])}`).join('&');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validDay(day) {
  const value = String(day || '');
  if (!DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  if (!validDay(from) || !validDay(to)) throw requestError('from/to must be valid YYYY-MM-DD dates');
  if (from > to) throw requestError('from must not be after to');
  const out = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
    if (guard > 5000) throw requestError('Requested range is too large');
  }
  return out;
}

// Keeps the exact pre-existing format for source='registrations' (no prefix) so
// already-persisted registrations results and any code keying off the bare
// "from:to:refFrom:refTo" string (e.g. existing tests) are unaffected. Only
// source='sales' gets a distinguishing prefix, giving true per-source caching.
// A non-default source additionally carries an engine-options digest (see
// engineOptionsDigest above), computed from engineOptionsFor(source) unless an
// explicit optionsDigest override is passed (used by tests to simulate an
// options change without altering SALES_ENGINE_OPTIONS itself): changing the
// sales engine minimums therefore changes the cache key/persisted-result path
// for every existing range, invalidating any stored sales result computed
// under the old minimums instead of serving it stale.
function rangeKey({ source = DEFAULT_SOURCE, from, to, refFrom, refTo, optionsDigest }) {
  const base = `${from}:${to}:${refFrom}:${refTo}`;
  if (source === DEFAULT_SOURCE) return base;
  const digest = optionsDigest || engineOptionsDigest(engineOptionsFor(source));
  return `${source}:${digest}:${base}`;
}

function safeRangeSlug({ source = DEFAULT_SOURCE, from, to, refFrom, refTo, optionsDigest }) {
  const base = `${from}_${to}__ref_${refFrom}_${refTo}`;
  if (source === DEFAULT_SOURCE) return base;
  const digest = optionsDigest || engineOptionsDigest(engineOptionsFor(source));
  return `${source}__${digest}__${base}`;
}

function runPython(pythonBin, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(pythonBin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(requestError(`${args.join(' ')} timed out after ${timeoutMs}ms`, 500));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(requestError(`${args.join(' ')} exited ${code}: ${stderr.slice(0, 2000)}`, 500));
    });
  });
}

async function readDayTape(universeDir, day) {
  const addsPath = path.join(universeDir, day, 'tape', 'adds.tsv');
  try {
    return await fsp.readFile(addsPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Builds a python work dir with a unioned tape/adds.tsv for [from, to], reporting
// missing days. Also returns labelIndex: label -> { zones: Set, day: earliest day
// observed } so the JS response layer can attach zone/day evidence to examples
// without asking the python engine to carry UI-shaping concerns.
async function buildSpanWorkDir({ universeDir, scratchDir, from, to }) {
  const days = daysBetween(from, to);
  const workDir = await fsp.mkdtemp(path.join(scratchDir, 'span-'));
  await fsp.mkdir(path.join(workDir, 'tape'), { recursive: true });
  const addsPath = path.join(workDir, 'tape', 'adds.tsv');
  const out = fs.createWriteStream(addsPath);
  const daysPresent = [];
  const daysMissing = [];
  const labelIndex = new Map();
  for (const day of days) {
    const text = await readDayTape(universeDir, day);
    if (text === null) { daysMissing.push(day); continue; }
    daysPresent.push(day);
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const fields = line.split('\t');
      if (fields.length < 2) continue;
      const label = String(fields[0] || '').toLowerCase();
      const zone = String(fields[1] || '').toLowerCase().replace(/^\./, '');
      if (!label || !zone) continue;
      out.write(`${line}\n`);
      let entry = labelIndex.get(label);
      if (!entry) { entry = { zones: new Set(), day }; labelIndex.set(label, entry); }
      entry.zones.add(zone);
    }
  }
  await new Promise((resolve, reject) => {
    out.end(error => (error ? reject(error) : resolve()));
  });
  return { workDir, days, daysPresent, daysMissing, labelIndex };
}

// Builds a python work dir with tape/adds.tsv drawn from the Sale Watch ledger's
// likely-sale entries (see server/sale-watch-theme-source.js for the exact
// admission rule) whose reportDate falls in [from, to]. Returns the same
// { workDir, days, daysPresent, daysMissing, labelIndex } shape buildSpanWorkDir
// returns for registrations (daysPresent/daysMissing computed from whether any
// admitted entry's reportDate falls on that day), plus metaByLabel (label ->
// ledger entry) and zonesPerDay (day -> Set(zone)) so the sales-specific response
// fields (buyers, coverage, examples with buyer/provider info) can be computed
// without asking the python engine to carry ledger concerns.
async function buildSalesSpanWorkDir({ scratchDir, entries, from, to }) {
  const days = daysBetween(from, to);
  const workDir = await fsp.mkdtemp(path.join(scratchDir, 'sales-span-'));
  await fsp.mkdir(path.join(workDir, 'tape'), { recursive: true });
  const selected = likelySalesInSpan(entries, from, to);
  const { tapeText, metaByLabel } = buildSalesTape(selected);
  await fsp.writeFile(path.join(workDir, 'tape', 'adds.tsv'), tapeText);
  const labelIndex = new Map();
  const dayHasEntry = new Set();
  const zonesPerDay = new Map();
  for (const entry of selected) {
    const day = String(entry.reportDate || '').slice(0, 10);
    const domain = String(entry.domain || '').toLowerCase();
    const dot = domain.indexOf('.');
    if (dot <= 0 || dot === domain.length - 1) continue;
    const label = domain.slice(0, dot);
    const zone = domain.slice(dot + 1);
    if (!label || !zone || !day) continue;
    dayHasEntry.add(day);
    let idx = labelIndex.get(label);
    if (!idx) { idx = { zones: new Set(), day }; labelIndex.set(label, idx); }
    idx.zones.add(zone);
    if (!zonesPerDay.has(day)) zonesPerDay.set(day, new Set());
    zonesPerDay.get(day).add(zone);
  }
  const daysPresent = days.filter(d => dayHasEntry.has(d));
  const daysMissing = days.filter(d => !dayHasEntry.has(d));
  return { workDir, days, daysPresent, daysMissing, labelIndex, metaByLabel, zonesPerDay };
}

function salesZonesPerDayOutput(zonesPerDay) {
  const out = {};
  for (const [day, zones] of zonesPerDay) out[day] = [...zones].sort();
  return out;
}

function salesComPresent(daysPresent, zonesPerDay) {
  if (!daysPresent.length) return false;
  return daysPresent.every(day => (zonesPerDay.get(day) || new Set()).has('com'));
}

async function zonesPerDayFor(lane, days) {
  const listed = await lane.listDays();
  const byDay = new Map(listed.map(d => [d.day, d]));
  const out = {};
  for (const day of days) {
    const info = byDay.get(day);
    if (info) out[day] = info.zones;
  }
  return out;
}

async function comPresentFor(universeDir, daysPresent) {
  if (!daysPresent.length) return false;
  for (const day of daysPresent) {
    const text = await readDayTape(universeDir, day);
    if (!text) return false;
    let found = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const fields = line.split('\t');
      if (String(fields[1] || '').toLowerCase().replace(/^\./, '') === 'com') { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

// Picks up to `cap` examples spread across different roots by greedily
// preferring labels whose theme-stripped remainder signature hasn't been seen
// yet. The engine's kit_collapse already removed dominant single-actor
// substrings from `labels`, so this is a display-time diversity pass, not a
// re-derivation of the independence scoring itself.
function diversifyExamples(theme, labels, labelIndex, cap = 12) {
  const seen = new Set();
  const picked = [];
  const fallback = [];
  for (const label of labels) {
    const remainder = label.split(theme).join('|');
    const signature = remainder.slice(0, 5) || remainder;
    const entry = labelIndex.get(label);
    const row = { label, zones: entry ? [...entry.zones].sort() : [], day: entry ? entry.day : null };
    if (!seen.has(signature)) { seen.add(signature); picked.push(row); }
    else fallback.push(row);
    if (picked.length >= cap) break;
  }
  while (picked.length < cap && fallback.length) picked.push(fallback.shift());
  return picked.slice(0, cap);
}

// Picks up to `cap` example labels spread across different buyer destinations
// (server/sale-watch-theme-source.js's buyerSignature), so example evidence for
// a sales theme visibly demonstrates multiple independent buyers rather than
// repeatedly showing the same destination.
function diversifySalesExamples(members, metaByLabel, cap = 12) {
  const seenBuyers = new Set();
  const picked = [];
  const fallback = [];
  for (const label of members) {
    const entry = metaByLabel.get(label);
    if (!entry) continue;
    const sig = buyerSignature(entry);
    if (!seenBuyers.has(sig)) { seenBuyers.add(sig); picked.push(label); }
    else fallback.push(label);
    if (picked.length >= cap) break;
  }
  while (picked.length < cap && fallback.length) picked.push(fallback.shift());
  return picked.slice(0, cap);
}

function transformEngineRows(engineOutput, labelIndex) {
  const byTheme = new Map();
  for (const bucket of ['rising', 'new', 'stable', 'fading']) {
    for (const row of engineOutput[bucket] || []) {
      const existing = byTheme.get(row.theme);
      if (!existing || existing.convergence < row.convergence) byTheme.set(row.theme, row);
    }
  }
  const themes = [];
  for (const row of byTheme.values()) {
    const topZones = (row.topZones || []).map(([zone, count]) => ({ zone, count }));
    themes.push({
      theme: row.theme,
      convergence: row.convergence,
      rise: row.rise === undefined ? null : row.rise,
      labels: row.labels,
      distinctRoots: row.independentRoots,
      distinctConstructions: row.constructions,
      distinctZones: row.zones,
      topZones,
      kitCollapsed: (row.kitShareRemoved || 0) > 0,
      examples: diversifyExamples(row.theme, row.examples || [], labelIndex, 12),
    });
  }
  themes.sort((a, b) => (b.convergence * Math.min(b.rise || 1, 8)) - (a.convergence * Math.min(a.rise || 1, 8)));
  return themes;
}

// Reshapes theme-convergence.json into the sales-source response shape, adding
// buyers/topBuyerShare/builtCount/buyerIndependence per theme (computed from the
// engine's full, uncapped `members` list -- see scripts/universe/theme-convergence.py --
// against the ledger entries recorded in metaByLabel) and buyer-diversified
// examples. Ranking sorts primarily by buyerIndependence descending, then
// builtCount descending, then raw convergence*rise: a theme carried by many
// independent, built buyers always outranks a theme carried by one destination
// set, however many raw members the single-destination theme has.
function transformSalesEngineRows(engineOutput, labelIndex, metaByLabel) {
  const byTheme = new Map();
  // 'unranked' is only populated by the engine when alwaysRank is set (sales,
  // via SALES_ENGINE_OPTIONS): every theme that clears the sales minimums but
  // has no reference share (rise null; thin/absent reference span) lands
  // there instead of being silently dropped by rising/new/stable/fading,
  // which all require a numeric rise or refSharePer1000.
  for (const bucket of ['rising', 'new', 'stable', 'fading', 'unranked']) {
    for (const row of engineOutput[bucket] || []) {
      const existing = byTheme.get(row.theme);
      if (!existing || existing.convergence < row.convergence) byTheme.set(row.theme, row);
    }
  }
  const themes = [];
  for (const row of byTheme.values()) {
    const topZones = (row.topZones || []).map(([zone, count]) => ({ zone, count }));
    const members = row.members || row.examples || [];
    const buyerStats = computeThemeBuyerStats(members, metaByLabel);
    const exampleLabels = diversifySalesExamples(members, metaByLabel, 12);
    const examples = exampleLabels
      .map(label => buildSalesExample(label, labelIndex.get(label) ? [...labelIndex.get(label).zones].sort() : [], metaByLabel))
      .filter(Boolean);
    themes.push({
      theme: row.theme,
      convergence: row.convergence,
      rise: row.rise === undefined ? null : row.rise,
      labels: row.labels,
      distinctRoots: row.independentRoots,
      distinctConstructions: row.constructions,
      distinctZones: row.zones,
      topZones,
      kitCollapsed: (row.kitShareRemoved || 0) > 0,
      buyers: buyerStats.buyers,
      topBuyerShare: buyerStats.topBuyerShare,
      builtCount: buyerStats.builtCount,
      buyerIndependence: buyerStats.buyerIndependence,
      examples,
    });
  }
  themes.sort((a, b) => {
    const ai = a.buyerIndependence || 0;
    const bi = b.buyerIndependence || 0;
    if (ai !== bi) return bi - ai;
    const abc = a.builtCount || 0;
    const bbc = b.builtCount || 0;
    if (abc !== bbc) return bbc - abc;
    return (b.convergence * Math.min(b.rise || 1, 8)) - (a.convergence * Math.min(a.rise || 1, 8));
  });
  return themes;
}

function createUniverseThemeEngine(options = {}) {
  const lane = options.lane;
  if (!lane) throw new Error('universe theme engine requires a universe lane');
  const universeDir = lane.directory;
  const log = options.log || console;
  const pythonBin = options.pythonBin || process.env.DOMAINSCOUT_PYTHON_BIN || 'python3';
  const scriptsDir = options.scriptsDir || path.join(__dirname, '..', 'scripts', 'universe');
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const scratchRoot = options.scratchDir || path.join(os.tmpdir(), 'domainscout-universe-themes');
  const storeDir = options.storeDir || path.join(universeDir, 'themes');
  const maxConcurrentJobs = Math.max(1, options.maxConcurrentJobs || 2);
  const now = options.now || (() => new Date());
  const minerTimeoutMs = options.minerTimeoutMs || 10 * 60 * 1000;
  const themeTimeoutMs = options.themeTimeoutMs || 10 * 60 * 1000;

  // Sale Watch ledger loader for source='sales': injectable for tests; defaults
  // to server/sale-watch.js's readSaleWatchLedger with no reconstruction-loader
  // (the cloud reconstruction store, when present, is wired at the /api/sale-watch
  // route layer, not needed here -- the seed+discovery ledger is sufficient
  // engine input). classifierVersion tracks server/sale-watch-evidence.js's
  // VERSION constant so a classifier bump invalidates any stored sales result.
  const saleWatchLedgerLoader = options.saleWatchLedgerLoader || (() => {
    const { readSaleWatchLedger } = require('./sale-watch');
    const ledger = readSaleWatchLedger();
    return { entries: ledger.entries, classifierVersion: ledger.classifierVersion };
  });
  const classifierVersionOf = options.classifierVersion
    ? (() => options.classifierVersion)
    : (() => require('./sale-watch-evidence').VERSION);

  const jobs = new Map(); // rangeKey(range,source) -> { status, startedAt, promise, error, result }
  let running = 0;
  const queue = [];

  function pump() {
    while (running < maxConcurrentJobs && queue.length) {
      const task = queue.shift();
      running += 1;
      task().finally(() => { running -= 1; pump(); });
    }
  }

  function enqueue(task) {
    return new Promise((resolve, reject) => {
      queue.push(() => task().then(resolve, reject));
      pump();
    });
  }

  async function defaultWindow() {
    const days = await lane.listDays();
    if (!days.length) throw requestError('No universe days are available', 404);
    const to = days.at(-1).day;
    const from = addDays(to, -(DEFAULT_WINDOW_DAYS - 1));
    const refTo = addDays(from, -1);
    const refFrom = addDays(refTo, -(DEFAULT_WINDOW_DAYS - 1));
    return { from, to, refFrom, refTo };
  }

  function resultPathFor(range, source = DEFAULT_SOURCE) {
    return path.join(storeDir, `${safeRangeSlug({ source, ...range })}.json`);
  }

  async function persistResult(range, source, result) {
    await fsp.mkdir(storeDir, { recursive: true });
    const tmpPath = `${resultPathFor(range, source)}.${crypto.randomUUID()}.part`;
    await fsp.writeFile(tmpPath, JSON.stringify(result));
    await fsp.rename(tmpPath, resultPathFor(range, source));
  }

  // Backfills a stored registrations result computed before referenceCoverage
  // carried the full coverage shape (zonesPerDay/comPresent) and riseBasis, using
  // the same tape presence check already recorded in referenceCoverage.daysPresent.
  // Persists the backfilled result so repeat reads do not recompute it. Only
  // applies to source='registrations'; sales results always carry the full shape
  // from the version of this code that first wrote them.
  async function backfillReferenceCoverage(range, stored) {
    const refCoverage = stored.referenceCoverage || { daysPresent: [], daysMissing: daysBetween(range.refFrom, range.refTo) };
    const daysPresent = refCoverage.daysPresent || [];
    const daysMissing = refCoverage.daysMissing || [];
    const zonesPerDay = refCoverage.zonesPerDay !== undefined ? refCoverage.zonesPerDay : await zonesPerDayFor(lane, daysPresent);
    const comPresent = refCoverage.comPresent !== undefined ? refCoverage.comPresent : await comPresentFor(universeDir, daysPresent);
    const riseBasis = stored.riseBasis !== undefined ? stored.riseBasis : (daysMissing.length ? 'partial-reference' : 'complete-reference');
    const backfilled = {
      ...stored,
      referenceCoverage: { daysPresent, daysMissing, zonesPerDay, comPresent },
      riseBasis,
    };
    await persistResult(range, DEFAULT_SOURCE, backfilled);
    return backfilled;
  }

  async function loadStoredResult(range, source = DEFAULT_SOURCE) {
    try {
      const text = await fsp.readFile(resultPathFor(range, source), 'utf8');
      const stored = JSON.parse(text);
      if (source === 'sales') {
        if (stored.classifierVersion !== classifierVersionOf()) return null; // classifier changed: force recompute
        return stored;
      }
      const needsBackfill = !stored.referenceCoverage
        || stored.referenceCoverage.zonesPerDay === undefined
        || stored.referenceCoverage.comPresent === undefined
        || stored.riseBasis === undefined;
      if (!needsBackfill) return stored;
      return await backfillReferenceCoverage(range, stored);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // Runs the vendored miner (current span, and best-effort on the reference span
  // for brand-family exclusion) then theme-convergence.py over both work dirs.
  // Shared by both sources: only the tape each work dir carries differs.
  // engineOptions (DEFAULT_ENGINE_OPTIONS for registrations, SALES_ENGINE_OPTIONS
  // for sales) is written to a JSON file in the current span's work dir and
  // passed to theme-convergence.py via --options; omitting engineOptions here
  // would be a caller bug, so the default below only guards against that, it
  // is never relied on by either real caller.
  async function runEngine(current, reference, engineOptions = DEFAULT_ENGINE_OPTIONS) {
    const minerPath = path.join(scriptsDir, 'mine-universe-types.py');
    const themePath = path.join(scriptsDir, 'theme-convergence.py');
    await runPython(pythonBin, [minerPath], {
      cwd: repoRoot,
      env: { ...process.env, UNIVERSE_WORK: current.workDir },
      timeoutMs: minerTimeoutMs,
    });
    if (reference.daysPresent.length) {
      await runPython(pythonBin, [minerPath], {
        cwd: repoRoot,
        env: { ...process.env, UNIVERSE_WORK: reference.workDir },
        timeoutMs: minerTimeoutMs,
      }).catch(error => log.warn?.(`[UniverseThemes] reference miner failed (continuing without brand-family exclusion for the reference span): ${error.message}`));
    }
    const optionsPath = path.join(current.workDir, 'theme-convergence-options.json');
    await fsp.writeFile(optionsPath, JSON.stringify(engineOptions));
    await runPython(pythonBin, [themePath, current.workDir, reference.workDir, '--options', optionsPath], {
      cwd: repoRoot,
      timeoutMs: themeTimeoutMs,
    });
    return JSON.parse(await fsp.readFile(path.join(current.workDir, 'theme-convergence.json'), 'utf8'));
  }

  async function computeRegistrationsRange(range) {
    const { from, to, refFrom, refTo } = range;
    const current = await buildSpanWorkDir({ universeDir, scratchDir: scratchRoot, from, to });
    const reference = await buildSpanWorkDir({ universeDir, scratchDir: scratchRoot, from: refFrom, to: refTo });
    try {
      const engineOutput = await runEngine(current, reference, DEFAULT_ENGINE_OPTIONS);
      const themes = transformEngineRows(engineOutput, current.labelIndex);
      const zonesPerDay = await zonesPerDayFor(lane, current.daysPresent);
      const comPresent = await comPresentFor(universeDir, current.daysPresent);
      const refZonesPerDay = await zonesPerDayFor(lane, reference.daysPresent);
      const refComPresent = await comPresentFor(universeDir, reference.daysPresent);
      const riseBasis = reference.daysMissing.length ? 'partial-reference' : 'complete-reference';
      const result = {
        range: { from, to },
        referenceRange: { from: refFrom, to: refTo },
        coverage: {
          daysPresent: current.daysPresent,
          daysMissing: current.daysMissing,
          zonesPerDay,
          comPresent,
        },
        referenceCoverage: {
          daysPresent: reference.daysPresent,
          daysMissing: reference.daysMissing,
          zonesPerDay: refZonesPerDay,
          comPresent: refComPresent,
        },
        riseBasis,
        computedAt: new Date(now()).toISOString(),
        engineVersion: ENGINE_VERSION,
        themes,
      };
      await persistResult(range, DEFAULT_SOURCE, result);
      return result;
    } finally {
      await fsp.rm(current.workDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(reference.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function computeSalesRange(range) {
    const { from, to, refFrom, refTo } = range;
    const { entries } = await Promise.resolve(saleWatchLedgerLoader());
    const current = await buildSalesSpanWorkDir({ scratchDir: scratchRoot, entries, from, to });
    const reference = await buildSalesSpanWorkDir({ scratchDir: scratchRoot, entries, from: refFrom, to: refTo });
    try {
      const engineOutput = await runEngine(current, reference, SALES_ENGINE_OPTIONS);
      const themes = transformSalesEngineRows(engineOutput, current.labelIndex, current.metaByLabel);
      const riseBasis = reference.daysMissing.length ? 'partial-reference' : 'complete-reference';
      const result = {
        source: 'sales',
        range: { from, to },
        referenceRange: { from: refFrom, to: refTo },
        coverage: {
          daysPresent: current.daysPresent,
          daysMissing: current.daysMissing,
          zonesPerDay: salesZonesPerDayOutput(current.zonesPerDay),
          comPresent: salesComPresent(current.daysPresent, current.zonesPerDay),
        },
        referenceCoverage: {
          daysPresent: reference.daysPresent,
          daysMissing: reference.daysMissing,
          zonesPerDay: salesZonesPerDayOutput(reference.zonesPerDay),
          comPresent: salesComPresent(reference.daysPresent, reference.zonesPerDay),
        },
        riseBasis,
        computedAt: new Date(now()).toISOString(),
        engineVersion: ENGINE_VERSION,
        classifierVersion: classifierVersionOf(),
        themes,
      };
      await persistResult(range, 'sales', result);
      return result;
    } finally {
      await fsp.rm(current.workDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(reference.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function computeRange(range, source = DEFAULT_SOURCE) {
    await fsp.mkdir(scratchRoot, { recursive: true });
    return source === 'sales' ? computeSalesRange(range) : computeRegistrationsRange(range);
  }

  function startJob(range, source = DEFAULT_SOURCE) {
    const key = rangeKey({ source, ...range });
    const existing = jobs.get(key);
    if (existing && (existing.status === 'running' || existing.status === 'done')) return existing;
    const job = { status: 'running', startedAt: new Date(now()).toISOString(), error: null, result: null };
    jobs.set(key, job);
    job.promise = enqueue(() => computeRange(range, source))
      .then(result => { job.status = 'done'; job.result = result; return result; })
      .catch(error => { job.status = 'error'; job.error = error.message || String(error); throw error; });
    job.promise.catch(() => {});
    return job;
  }

  async function getOrCompute(range, source = DEFAULT_SOURCE) {
    const stored = await loadStoredResult(range, source);
    if (stored) return { status: 'ready', result: stored };
    const key = rangeKey({ source, ...range });
    const existing = jobs.get(key);
    if (existing) {
      if (existing.status === 'done') return { status: 'ready', result: existing.result };
      if (existing.status === 'error') throw requestError(existing.error || 'Theme computation failed', 500);
      return { status: 'pending', job: existing };
    }
    return { status: 'pending', job: startJob(range, source) };
  }

  async function runPrecompute() {
    const range = await defaultWindow();
    const sources = {};
    for (const source of SOURCES) {
      const stored = await loadStoredResult(range, source);
      if (stored) { sources[source] = { skipped: 'complete', range }; continue; }
      const key = rangeKey({ source, ...range });
      const existing = jobs.get(key);
      if (existing && existing.status === 'running') { sources[source] = { skipped: 'running', range }; continue; }
      const job = startJob(range, source);
      try {
        const result = await job.promise;
        sources[source] = { computed: true, range, result };
      } catch (error) {
        sources[source] = { failed: true, range, error: error.message };
      }
    }
    return { range, sources };
  }

  return {
    defaultWindow,
    getOrCompute,
    runPrecompute,
    computeRange,
    loadStoredResult,
    resultPathFor,
    isJobRunning: (range, source = DEFAULT_SOURCE) => jobs.get(rangeKey({ source, ...range }))?.status === 'running',
    _jobs: jobs,
  };
}

async function parseRange(query, engine) {
  let from = query.from !== undefined ? String(query.from) : null;
  let to = query.to !== undefined ? String(query.to) : null;
  let refFrom = query.refFrom !== undefined ? String(query.refFrom) : null;
  let refTo = query.refTo !== undefined ? String(query.refTo) : null;
  if (!from && !to) {
    const win = await engine.defaultWindow();
    return { from: win.from, to: win.to, refFrom: refFrom || win.refFrom, refTo: refTo || win.refTo };
  }
  if (!from || !to) throw requestError('from and to must both be provided together');
  if (!validDay(from) || !validDay(to)) throw requestError('from/to must be valid YYYY-MM-DD dates');
  if (from > to) throw requestError('from must not be after to');
  if ((refFrom && !refTo) || (refTo && !refFrom)) throw requestError('refFrom and refTo must both be provided together');
  if (refFrom && refTo) {
    if (!validDay(refFrom) || !validDay(refTo)) throw requestError('refFrom/refTo must be valid YYYY-MM-DD dates');
    if (refFrom > refTo) throw requestError('refFrom must not be after refTo');
  } else {
    const spanDays = daysBetween(from, to).length;
    refTo = addDays(from, -1);
    refFrom = addDays(refTo, -(spanDays - 1));
  }
  return { from, to, refFrom, refTo };
}

const MAX_LIMIT = 200;

function registerUniverseThemeRoutes(app, engine) {
  app.get('/api/universe/themes', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const query = req.query || {};
      const source = query.source !== undefined ? String(query.source) : DEFAULT_SOURCE;
      if (!SOURCES.includes(source)) throw requestError('source must be "registrations" or "sales"');
      const range = await parseRange(query, engine);
      const limitRaw = query.limit === undefined ? 50 : Math.trunc(Number(query.limit));
      if (!Number.isFinite(limitRaw) || limitRaw < 1) throw requestError('limit must be a positive integer');
      const limit = Math.min(MAX_LIMIT, limitRaw);
      const q = query.q !== undefined ? String(query.q).trim().toLowerCase() : '';
      const outcome = await engine.getOrCompute(range, source);
      if (outcome.status === 'pending') {
        res.status(202).json({
          status: 'pending',
          range: { from: range.from, to: range.to },
          referenceRange: { from: range.refFrom, to: range.refTo },
          startedAt: outcome.job.startedAt,
        });
        return;
      }
      const result = outcome.result;
      let themes = result.themes || [];
      if (q) themes = themes.filter(t => t.theme.toLowerCase().includes(q));
      themes = themes.slice(0, limit);
      const body = {
        range: result.range,
        referenceRange: result.referenceRange,
        coverage: result.coverage,
        referenceCoverage: result.referenceCoverage,
        riseBasis: result.riseBasis,
        computedAt: result.computedAt,
        engineVersion: result.engineVersion,
        themes,
      };
      if (source === 'sales') {
        body.source = 'sales';
        body.classifierVersion = result.classifierVersion;
      }
      res.json(body);
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || 'Universe themes query failed' });
    }
  });
}

module.exports = {
  createUniverseThemeEngine,
  registerUniverseThemeRoutes,
  validDay,
  addDays,
  daysBetween,
  rangeKey,
  safeRangeSlug,
  requestError,
  transformEngineRows,
  transformSalesEngineRows,
  diversifyExamples,
  diversifySalesExamples,
  buildSalesSpanWorkDir,
  SOURCES,
  DEFAULT_SOURCE,
  DEFAULT_WINDOW_DAYS,
  ENGINE_VERSION,
  DEFAULT_ENGINE_OPTIONS,
  SALES_ENGINE_OPTIONS,
  engineOptionsFor,
  engineOptionsDigest,
};
