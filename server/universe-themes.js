'use strict';

// Serves the vendored theme-convergence engine (scripts/universe/theme-convergence.py +
// mine-universe-types.py) over the cloud universe lane's per-day tapes
// (<universeDir>/<day>/tape/adds.tsv). This module never reimplements the engine's
// scoring logic (independence breadth, kit collapse, rise-vs-reference); it only:
//   1. builds a python work dir by unioning day tapes for a requested span (and,
//      separately, the reference span), reporting any missing days instead of
//      silently dropping them,
//   2. shells out to the vendored scripts exactly as the MacBook lane does,
//   3. reshapes theme-convergence.json into the documented API response shape,
//   4. persists the full result durably next to the tapes so repeat reads are free,
//   5. runs on-demand ranges as a bounded, deduplicated background job so the
//      request thread is never blocked and the same range is never computed twice
//      concurrently.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 7;
const ENGINE_VERSION = 'theme-convergence-v1';

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

function rangeKey({ from, to, refFrom, refTo }) {
  return `${from}:${to}:${refFrom}:${refTo}`;
}

function safeRangeSlug({ from, to, refFrom, refTo }) {
  return `${from}_${to}__ref_${refFrom}_${refTo}`;
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

  const jobs = new Map(); // rangeKey -> { status, startedAt, promise, error, result }
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

  function resultPathFor(range) {
    return path.join(storeDir, `${safeRangeSlug(range)}.json`);
  }

  // Backfills a stored result computed before referenceCoverage carried the
  // full coverage shape (zonesPerDay/comPresent) and riseBasis, using the
  // same tape presence check already recorded in referenceCoverage.daysPresent.
  // Persists the backfilled result so repeat reads do not recompute it.
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
    await fsp.mkdir(storeDir, { recursive: true });
    const tmpPath = `${resultPathFor(range)}.${crypto.randomUUID()}.part`;
    await fsp.writeFile(tmpPath, JSON.stringify(backfilled));
    await fsp.rename(tmpPath, resultPathFor(range));
    return backfilled;
  }

  async function loadStoredResult(range) {
    try {
      const text = await fsp.readFile(resultPathFor(range), 'utf8');
      const stored = JSON.parse(text);
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

  async function computeRange(range) {
    const { from, to, refFrom, refTo } = range;
    await fsp.mkdir(scratchRoot, { recursive: true });
    const current = await buildSpanWorkDir({ universeDir, scratchDir: scratchRoot, from, to });
    const reference = await buildSpanWorkDir({ universeDir, scratchDir: scratchRoot, from: refFrom, to: refTo });
    try {
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
      await runPython(pythonBin, [themePath, current.workDir, reference.workDir], {
        cwd: repoRoot,
        timeoutMs: themeTimeoutMs,
      });
      const engineOutput = JSON.parse(await fsp.readFile(path.join(current.workDir, 'theme-convergence.json'), 'utf8'));
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
        // Reference-span coverage uses the same shape as `coverage`, computed
        // from the same tape presence check, so a client can tell when every
        // theme's `rise` (always computed against the reference span) rests
        // on a partial baseline. `riseBasis` summarizes this at the top level.
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
      await fsp.mkdir(storeDir, { recursive: true });
      const tmpPath = `${resultPathFor(range)}.${crypto.randomUUID()}.part`;
      await fsp.writeFile(tmpPath, JSON.stringify(result));
      await fsp.rename(tmpPath, resultPathFor(range));
      return result;
    } finally {
      await fsp.rm(current.workDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(reference.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function startJob(range) {
    const key = rangeKey(range);
    const existing = jobs.get(key);
    if (existing && (existing.status === 'running' || existing.status === 'done')) return existing;
    const job = { status: 'running', startedAt: new Date(now()).toISOString(), error: null, result: null };
    jobs.set(key, job);
    job.promise = enqueue(() => computeRange(range))
      .then(result => { job.status = 'done'; job.result = result; return result; })
      .catch(error => { job.status = 'error'; job.error = error.message || String(error); throw error; });
    job.promise.catch(() => {}); // status is read via the job map; never crash the process on a background failure
    return job;
  }

  // Returns { status: 'ready', result } if a durable result already exists or a
  // background job just finished; otherwise starts (or reuses) exactly one
  // deduplicated background job for this exact range and returns
  // { status: 'pending', job }. Never blocks on the python subprocess.
  async function getOrCompute(range) {
    const stored = await loadStoredResult(range);
    if (stored) return { status: 'ready', result: stored };
    const key = rangeKey(range);
    const existing = jobs.get(key);
    if (existing) {
      if (existing.status === 'done') return { status: 'ready', result: existing.result };
      if (existing.status === 'error') throw requestError(existing.error || 'Theme computation failed', 500);
      return { status: 'pending', job: existing };
    }
    return { status: 'pending', job: startJob(range) };
  }

  // Precompute hook: called after each day's universe tape lands, and once
  // (guarded) at startup. Computes the default 7-day window ending on the
  // latest complete day if it is not already durably stored.
  async function runPrecompute() {
    const range = await defaultWindow();
    const stored = await loadStoredResult(range);
    if (stored) return { skipped: 'complete', range };
    const key = rangeKey(range);
    const existing = jobs.get(key);
    if (existing && existing.status === 'running') return { skipped: 'running', range };
    const job = startJob(range);
    try {
      const result = await job.promise;
      return { computed: true, range, result };
    } catch (error) {
      return { failed: true, range, error: error.message };
    }
  }

  return {
    defaultWindow,
    getOrCompute,
    runPrecompute,
    computeRange,
    loadStoredResult,
    resultPathFor,
    isJobRunning: range => jobs.get(rangeKey(range))?.status === 'running',
    _jobs: jobs,
  };
}

// Resolves the four-date range for a request: explicit from/to (with an
// explicit refFrom/refTo, or else a reference span of equal length ending the
// day before `from`), or — when neither from nor to is given — the engine's
// default 7-day window ending on the latest complete universe day.
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

// Mounts GET /api/universe/themes: a token-readable GET route like the other
// /api/universe/* routes (the caller's existing agent-token middleware already
// gates every /api/* GET; this route adds no auth of its own). Never blocks the
// request thread on the python engine: an unready range answers 202 with a
// status while exactly one deduplicated background job computes it.
function registerUniverseThemeRoutes(app, engine) {
  app.get('/api/universe/themes', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const query = req.query || {};
      const range = await parseRange(query, engine);
      const limitRaw = query.limit === undefined ? 50 : Math.trunc(Number(query.limit));
      if (!Number.isFinite(limitRaw) || limitRaw < 1) throw requestError('limit must be a positive integer');
      const limit = Math.min(MAX_LIMIT, limitRaw);
      const q = query.q !== undefined ? String(query.q).trim().toLowerCase() : '';
      const outcome = await engine.getOrCompute(range);
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
      res.json({
        range: result.range,
        referenceRange: result.referenceRange,
        coverage: result.coverage,
        referenceCoverage: result.referenceCoverage,
        riseBasis: result.riseBasis,
        computedAt: result.computedAt,
        engineVersion: result.engineVersion,
        themes,
      });
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
  diversifyExamples,
  DEFAULT_WINDOW_DAYS,
  ENGINE_VERSION,
};
