'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 300;

function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function toNodeStream(body) {
  if (!body) throw new Error('Empty response body');
  if (typeof body.pipe === 'function') return body;
  if (typeof Readable.fromWeb === 'function') return Readable.fromWeb(body);
  throw new Error('Cannot convert response body to a Node stream');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Concurrent zone workers record progress into the same pull/health files, so
// each write uses its own temp name: a shared `.part` raced two renames into
// ENOENT and aborted the first cloud pull (2026-09-10). rename() is atomic;
// the last writer wins, which is the intended semantics for a progress record.
let atomicWriteSequence = 0;
async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  atomicWriteSequence += 1;
  const partPath = `${filePath}.${process.pid}.${atomicWriteSequence}.part`;
  await fsp.writeFile(partPath, JSON.stringify(value, null, 2));
  try { await fsp.rename(partPath, filePath); }
  catch (error) { await fsp.rm(partPath, { force: true }).catch(() => {}); throw error; }
}

// A progress record (pull/<day>.json, health.json) is derived state: if it is
// missing OR unreadable it is treated as absent so the lane can rebuild it,
// never as a reason to refuse the day (a corrupt record blocked the 2026-09-10
// re-trigger after the first race).
async function readJsonSafe(filePath) {
  let text;
  try { text = await fsp.readFile(filePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return JSON.parse(text); }
  catch (error) {
    await fsp.rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => {});
    return null;
  }
}

function createUniversePuller(options = {}) {
  const dataDir = options.dataDir;
  const universeDir = options.universeDir;
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const log = options.log || console;
  const summary = options.summary || require('./universe-summary');
  const extract = options.extract || require('./universe-extract');
  const now = options.now || (() => new Date());

  const anchors = String(env.DOMAINSCOUT_UNIVERSE_ANCHOR_ZONES
    || 'com,net,org,xyz,app,dev,top,shop,info,online,site,store,tech,club,live')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const concurrency = Math.max(1, Number(env.DOMAINSCOUT_UNIVERSE_PULL_CONCURRENCY) || 6);

  const namesRoot = path.join(dataDir, 'universe', 'names');
  const pullDir = path.join(dataDir, 'universe', 'pull');
  const summaryOutDir = path.join(dataDir, 'universe-summary');
  const healthPath = path.join(dataDir, 'universe', 'health.json');
  const lockPath = path.join(dataDir, 'universe', 'pull.lock.json');

  const namesDir = day => path.join(namesRoot, day);
  const namesPath = (day, tld) => path.join(namesDir(day), `${tld}.names.gz`);
  const pullRecordPath = day => path.join(pullDir, `${day}.json`);
  const tapeDir = day => path.join(universeDir, day, 'tape');

  let currentRun = null;

  function isRunning() {
    if (currentRun) return true;
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Date.now() - Date.parse(lock.startedAt) < LOCK_STALE_MS) return true;
    } catch (error) { /* no lock, or stale/corrupt */ }
    return false;
  }

  async function acquireLock(day) {
    await atomicWriteJson(lockPath, { pid: process.pid, day, startedAt: new Date(now()).toISOString() });
  }

  async function releaseLock() {
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }

  async function writeHealth(phase, run, error) {
    const previous = await readJsonSafe(healthPath);
    let disk = { freeBytes: null, totalBytes: null };
    try {
      const stats = fs.statfsSync(dataDir);
      disk = { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch (statError) { /* statfsSync unavailable in this sandbox */ }

    const complete = phase === 'finished' && run.failed.length === 0;
    const lastCompleteDay = complete ? run.day : (previous && previous.lastCompleteDay) || null;
    const alerts = [];
    // Group zone failures by their error so 44 identical failures read as one
    // sentence with a zone list, never a wall of repeated lines in the UI.
    const byError = new Map();
    for (const failure of run.failed) {
      const key = String(failure.error || 'unknown error').replace(/\s+/g, ' ').slice(0, 160);
      if (!byError.has(key)) byError.set(key, []);
      byError.get(key).push(failure.tld);
    }
    for (const [errorText, tlds] of byError) {
      const shown = tlds.slice(0, 5).join(', ') + (tlds.length > 5 ? `, +${tlds.length - 5} more` : '');
      alerts.push(tlds.length === 1
        ? `Zone ${tlds[0]} failed: ${errorText}`
        : `${tlds.length} zones failed (${shown}): ${errorText}`);
    }
    if (run.anchorsMissing.length) alerts.push(`Anchor zones missing from zone list: ${run.anchorsMissing.join(', ')}`);
    if (run.summaryError) alerts.push(`Summary import refused: ${run.summaryError}`);
    if (!lastCompleteDay) alerts.push('No complete universe day yet');
    else if (lastCompleteDay < todayUTC(new Date(Date.now() - 2 * 86400000))) alerts.push(`No complete universe day since ${lastCompleteDay}`);
    if (disk.freeBytes !== null && disk.freeBytes < 2 * 1024 ** 3) alerts.push('Volume free space under 2 GiB');
    if (error) alerts.push(String(error.message || error));

    const status = phase === 'running' ? 'running' : error ? 'failed' : complete ? 'ok' : 'incomplete';
    const health = {
      status,
      lastCompleteDay,
      lastRun: {
        day: run.day, startedAt: run.startedAt,
        finishedAt: phase === 'finished' ? new Date(now()).toISOString() : null,
        phase, error: error ? String(error.message || error) : null,
      },
      zonesListed: run.zonesListed, zonesOk: run.ok.length, failedZones: run.failed.map(f => f.tld),
      anchorsMissing: run.anchorsMissing, summary: run.summary || null, disk, alerts,
    };
    await atomicWriteJson(healthPath, health);
    return health;
  }

  async function authenticate() {
    const res = await fetchImpl('https://account-api.icann.org/api/authenticate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: env.CZDS_USER, password: env.CZDS_PASS }),
    });
    if (!res.ok) throw new Error(`CZDS authenticate failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.accessToken;
  }

  async function listZones(token) {
    const res = await fetchImpl('https://czds-api.icann.org/czds/downloads/links', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`CZDS links failed: HTTP ${res.status}`);
    const urls = await res.json();
    return urls.map(url => ({ url, tld: path.basename(String(url)).replace(/\.zone(\.gz)?$/i, '') }));
  }

  async function pullOneZone(token, zone, day) {
    const tmpBase = path.join(os.tmpdir(), 'domainscout-universe', day);
    await fsp.mkdir(tmpBase, { recursive: true });
    const rawPath = path.join(tmpBase, `${zone.tld}.raw`);
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetchImpl(zone.url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        await pipeline(
          toNodeStream(res.body), zlib.createGunzip(), extract.createLabelExtractor(zone.tld),
          fs.createWriteStream(rawPath),
        );
        await fsp.mkdir(namesDir(day), { recursive: true });
        await extract.sortUniqueGzip({ rawPath, outPath: namesPath(day, zone.tld), tmpDir: tmpBase });
        const stat = await fsp.stat(namesPath(day, zone.tld));
        const labels = await extract.countGzipLines(namesPath(day, zone.tld));
        await fsp.rm(rawPath, { force: true }).catch(() => {});
        return { tld: zone.tld, labels, bytes: stat.size };
      } catch (error) {
        lastError = error;
        await fsp.rm(rawPath, { force: true }).catch(() => {});
        if (attempt < 3) await delay(RETRY_DELAY_MS * attempt);
      }
    }
    throw Object.assign(new Error(lastError ? lastError.message : 'unknown error'), { tld: zone.tld, attempts: 3 });
  }

  async function runPool(items, worker) {
    let index = 0;
    async function next() {
      while (index < items.length) {
        const item = items[index]; index += 1;
        await worker(item);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  }

  async function newestCompletePriorDay(day) {
    let entries;
    try { entries = await fsp.readdir(pullDir); } catch (error) { return null; }
    const days = entries.filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(d => DAY_PATTERN.test(d) && d < day).sort();
    for (let i = days.length - 1; i >= 0; i -= 1) {
      const record = await readJsonSafe(pullRecordPath(days[i]));
      if (record && record.complete) return days[i];
    }
    return null;
  }

  async function writeTape(day, prevDay, okZones) {
    const dir = tapeDir(day);
    await fsp.mkdir(dir, { recursive: true });
    const addsStream = fs.createWriteStream(path.join(dir, 'adds.tsv.part'));
    const dropsStream = fs.createWriteStream(path.join(dir, 'drops.tsv.part'));
    const zones = {};
    for (const zone of okZones) {
      const prevPath = prevDay ? namesPath(prevDay, zone.tld) : null;
      const result = await extract.diffSortedGzip({
        prevPath, todayPath: namesPath(day, zone.tld),
        onAdd: label => addsStream.write(`${label}\t${zone.tld}\t${prevDay || ''}\n`),
        onDrop: label => dropsStream.write(`${label}\t${zone.tld}\t${prevDay || ''}\n`),
      });
      const status = !prevDay ? 'no-baseline' : result.prevCount === 0 ? 'empty-baseline' : 'ok';
      zones[zone.tld] = {
        status, window_start: prevDay || null, baseline_count: result.prevCount,
        today_count: result.todayCount, adds: result.adds, drops: result.drops,
      };
    }
    await new Promise((resolve, reject) => addsStream.end(err => (err ? reject(err) : resolve())));
    await new Promise((resolve, reject) => dropsStream.end(err => (err ? reject(err) : resolve())));
    await fsp.rename(path.join(dir, 'adds.tsv.part'), path.join(dir, 'adds.tsv'));
    await fsp.rename(path.join(dir, 'drops.tsv.part'), path.join(dir, 'drops.tsv'));
    await fsp.writeFile(path.join(dir, 'zones.json'), JSON.stringify(zones, null, 2));
    return zones;
  }

  async function pruneOld(day, prevDay) {
    try {
      const keepNames = new Set([day, prevDay].filter(Boolean));
      for (const name of await fsp.readdir(namesRoot).catch(() => [])) {
        if (DAY_PATTERN.test(name) && !keepNames.has(name)) {
          await fsp.rm(path.join(namesRoot, name), { recursive: true, force: true });
        }
      }
      const tapes = (await fsp.readdir(summaryOutDir).catch(() => [])).filter(n => /\.tsv\.gz$/.test(n)).sort();
      for (const name of tapes.slice(0, Math.max(0, tapes.length - 2))) {
        await fsp.rm(path.join(summaryOutDir, name), { force: true }).catch(() => {});
        await fsp.rm(path.join(summaryOutDir, name.replace(/\.tsv\.gz$/, '.meta.json')), { force: true }).catch(() => {});
      }
      const records = (await fsp.readdir(pullDir).catch(() => [])).filter(n => n.endsWith('.json')).sort();
      for (const name of records.slice(0, Math.max(0, records.length - 60))) {
        await fsp.rm(path.join(pullDir, name), { force: true }).catch(() => {});
      }
    } catch (error) { log.error?.('universe-puller: retention prune failed', error); }
  }

  async function runDay({ day, force, onlyTlds } = {}) {
    const targetDay = day || todayUTC(now());
    if (!DAY_PATTERN.test(targetDay)) throw new Error(`Invalid day: ${targetDay}`);
    if (isRunning() && !force) return { skipped: 'running' };
    currentRun = { day: targetDay };
    await acquireLock(targetDay);
    const existing = await readJsonSafe(pullRecordPath(targetDay));
    const existingOk = (existing && existing.ok) || [];
    const run = {
      day: targetDay,
      startedAt: (existing && existing.startedAt) || new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(), finishedAt: null,
      zonesListed: (existing && existing.zonesListed) || 0,
      ok: onlyTlds ? existingOk.filter(o => !onlyTlds.includes(o.tld)) : [],
      failed: [], anchorsMissing: [], complete: false,
    };
    try {
      await writeHealth('listing', run);
      log.log?.(`universe-puller: authenticating for ${targetDay}`);
      const token = await authenticate();
      let zoneList = await listZones(token);
      run.zonesListed = zoneList.length;
      run.anchorsMissing = anchors.filter(a => !zoneList.some(z => z.tld === a));
      if (onlyTlds) zoneList = zoneList.filter(z => onlyTlds.includes(z.tld));
      log.log?.(`universe-puller: downloading ${zoneList.length} zones for ${targetDay}`);
      await writeHealth('downloading', run);
      await runPool(zoneList, async zone => {
        try { run.ok.push(await pullOneZone(token, zone, targetDay)); }
        catch (error) { run.failed.push({ tld: zone.tld, attempts: error.attempts || 3, error: error.message }); }
        run.updatedAt = new Date(now()).toISOString();
        await atomicWriteJson(pullRecordPath(targetDay), run);
        await writeHealth('downloading', run);
      });
      run.complete = run.failed.length === 0;
      run.finishedAt = new Date(now()).toISOString();
      await atomicWriteJson(pullRecordPath(targetDay), run);

      if (run.complete) {
        const prevDay = await newestCompletePriorDay(targetDay);
        log.log?.(`universe-puller: diffing ${targetDay} against ${prevDay || '(none)'}`);
        await writeTape(targetDay, prevDay, run.ok);
        try {
          const tape = await summary.buildUniverseSummaryTape({ namesDir: namesDir(targetDay), day: targetDay, outDir: summaryOutDir, log });
          let expectZones = run.zonesListed - 5;
          if (typeof summary.openUniverseSummary === 'function') {
            const prevSummary = summary.openUniverseSummary(dataDir);
            if (prevSummary) expectZones = prevSummary.status().zones - 5;
          }
          await summary.importUniverseSummaryTape({ tapePath: tape.tapePath, dataDir, expectZones, requireZones: anchors, log });
          run.summary = { day: targetDay, zones: tape.zones };
        } catch (summaryError) {
          run.summaryError = summaryError.message;
          log.error?.('universe-puller: summary build/import failed', summaryError);
        }
        await pruneOld(targetDay, prevDay);
      }
      const health = await writeHealth('finished', run);
      return { day: targetDay, complete: run.complete, ok: run.ok.length, failed: run.failed.length, health };
    } catch (error) {
      log.error?.('universe-puller: runDay failed', error);
      await writeHealth('error', run, error);
      throw error;
    } finally {
      currentRun = null;
      await releaseLock();
    }
  }

  async function retryIncomplete() {
    const day = todayUTC(now());
    const record = await readJsonSafe(pullRecordPath(day));
    if (!record || record.complete) return { skipped: 'not-incomplete' };
    if (now().getUTCHours() >= 22) return { skipped: 'too-late' };
    const failedTlds = (record.failed || []).map(f => f.tld);
    if (!failedTlds.length) return { skipped: 'no-failed-zones' };
    return runDay({ day, onlyTlds: failedTlds });
  }

  async function health() {
    const stored = await readJsonSafe(healthPath);
    if (!stored) return { status: isRunning() ? 'running' : 'unknown', alerts: ['Universe lane has not run yet'] };
    if (isRunning() && stored.status !== 'running') return { ...stored, status: 'running' };
    return stored;
  }

  return { runDay, retryIncomplete, health, isRunning };
}

module.exports = { createUniversePuller };
