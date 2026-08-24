/**
 * ICANN CZDS — Centralized Zone Data Service
 * Diffs zone files day-over-day to find dropped domains.
 *
 * Free account required: https://czds.icann.org
 * Set CZDS_USER and CZDS_PASS in .env
 *
 * Covers: ALL TLDs the account has been approved for.
 * CZDS covers 900+ gTLDs including .com, .net, .org, .app, .dev, .xyz,
 * .shop, .online, .store, .tech, .io, .ai, and hundreds of new gTLDs.
 * Apply for additional TLDs at https://czds.icann.org to expand coverage.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const dns = require('dns');

// Robust DNS: travel/hotel wifi resolvers intermittently fail (ENOTFOUND) on ICANN's
// hosts even though curl resolves them fine — node's getaddrinfo is the weak link. Use
// public resolvers (1.1.1.1 / 8.8.8.8) via dns.resolve4, cache results, and supply this
// as axios's `lookup` so connections don't depend on the local resolver. IPv4 only,
// because IPv6 is broken on these networks.
try { dns.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']); } catch {}
const _ipCache = new Map();
function robustLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const cached = _ipCache.get(hostname);
  if (cached) return cb(null, cached, 4);
  dns.resolve4(hostname, (err, addrs) => {
    if (!err && addrs && addrs.length) { _ipCache.set(hostname, addrs[0]); return cb(null, addrs[0], 4); }
    // fall back to the system resolver, IPv4
    dns.lookup(hostname, { family: 4 }, (e, addr, fam) => { if (!e && addr) _ipCache.set(hostname, addr); cb(e, addr, fam); });
  });
}

const DATA_BASE = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const DATA_DIR  = path.join(DATA_BASE, 'zones');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Auth: get JWT from ICANN
async function getCZDSToken() {
  const user = process.env.CZDS_USER;
  const pass = process.env.CZDS_PASS;
  if (!user || !pass) throw new Error('CZDS_USER / CZDS_PASS not set in .env');

  // ICANN's auth endpoint is frequently slow; a single 15s timeout aborted the whole
  // build. Retry with backoff and a generous timeout.
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const resp = await axios.post(
        'https://account-api.icann.org/api/authenticate',
        { username: user, password: pass },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000, lookup: robustLookup }
      );
      return resp.data.accessToken;
    } catch (e) {
      lastErr = e;
      console.log(`[CZDS] auth attempt ${attempt}/5 failed (${e.message}); retrying...`);
      await sleep(5000 * attempt);
    }
  }
  throw lastErr;
}

// List available zone file download links. The CZDS links endpoint is frequently slow
// (15s+); a single timeout made the whole pass abort and do nothing. Retry with backoff
// and a generous timeout so a slow-but-up CZDS doesn't kill the build.
async function getZoneLinks(token) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const resp = await axios.get(
        'https://czds-api.icann.org/czds/downloads/links',
        { headers: { Authorization: `Bearer ${token}` }, timeout: 120000, lookup: robustLookup }
      );
      return resp.data; // array of download URLs
    } catch (e) {
      lastErr = e;
      console.log(`[CZDS] links fetch attempt ${attempt}/5 failed (${e.message}); retrying...`);
      await sleep(5000 * attempt);
    }
  }
  throw lastErr;
}

// Download a zone file, decompress, and save as plain text
async function downloadZone(token, url, outPath) {
  const tmpPath = `${outPath}.part`;
  // CZDS soft-throttles bursts of rapid downloads with connect ETIMEDOUTs that
  // clear within seconds. Retry with backoff instead of skipping the zone for
  // the whole pass (auth/links fetches already do this).
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    try {
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'stream',
        lookup: robustLookup,
        timeout: 300000, // zone files can be large
      });
      await new Promise((resolve, reject) => {
        const gunzip = zlib.createGunzip();
        const out = fs.createWriteStream(tmpPath);
        resp.data.pipe(gunzip).pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        gunzip.on('error', reject);
        resp.data.on('error', reject);
      });
      fs.renameSync(tmpPath, outPath);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 5) {
        const wait = attempt * 3000;
        console.log(`[CZDS] download attempt ${attempt}/5 failed (${e.message}); retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// Download a zone file keeping it compressed (.zone.gz) — used for .com to avoid
// writing the ~12 GB decompressed file; indexer streams gunzip on the fly instead.
async function downloadZoneGzipped(token, url, outPath) {
  const tmpPath = `${outPath}.part`;
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    try {
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'stream',
        lookup: robustLookup,
        timeout: 600000, // .com is large
      });
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmpPath);
        resp.data.pipe(out); // no gunzip — keep compressed
        out.on('finish', resolve);
        out.on('error', reject);
        resp.data.on('error', reject);
      });
      fs.renameSync(tmpPath, outPath);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 5) {
        const wait = attempt * 3000;
        console.log(`[CZDS] gz download attempt ${attempt}/5 failed (${e.message}); retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// TLDs too large or valuable enough to avoid decompressed temp files. They are
// downloaded as .gz and stream-indexed directly into SQLite.
const GZ_ONLY_TLDS = new Set(['com', 'net', 'org']);
const HEAVY_TLDS = new Set([
  ...GZ_ONLY_TLDS,
  'app', 'dev', 'tech', 'info', 'biz', 'club',
  'xyz', 'online', 'site', 'shop', 'store', 'top', 'icu', 'vip', 'live',
  'click', 'website', 'cfd', 'cyou', 'bond', 'sbs', 'lol', 'mom',
]);

const PRIORITY_TLDS = [
  'com', 'net', 'org', 'co', 'io', 'ai',
  'xyz', 'online', 'site', 'shop', 'store', 'app', 'dev', 'tech',
  'info', 'biz', 'club', 'vip', 'live', 'click', 'website', 'cfd',
  'top', 'icu', 'cyou', 'bond', 'sbs', 'lol', 'mom',
  'cloud', 'digital', 'software', 'systems', 'network', 'solutions',
  'services', 'agency', 'group', 'company', 'business', 'world',
  'global', 'pro', 'one', 'space', 'life', 'today', 'news',
  'media', 'blog', 'social', 'design', 'studio', 'art',
  'finance', 'capital', 'fund', 'ventures', 'partners', 'exchange',
];

function tldFromLink(link) {
  const match = link.match(/\/([a-z0-9-]+)\.zone/i);
  return match ? match[1].toLowerCase() : null;
}

function sortZoneLinks(links) {
  const priority = new Map(PRIORITY_TLDS.map((tld, i) => [tld, i]));
  return [...links].sort((a, b) => {
    const at = tldFromLink(a) || '';
    const bt = tldFromLink(b) || '';
    const ap = (priority.has(at) ? priority.get(at) : 10_000) + (HEAVY_TLDS.has(at) ? 5_000 : 0);
    const bp = (priority.has(bt) ? priority.get(bt) : 10_000) + (HEAVY_TLDS.has(bt) ? 5_000 : 0);
    if (ap !== bp) return ap - bp;
    const ax = at.startsWith('xn--') ? 1 : 0;
    const bx = bt.startsWith('xn--') ? 1 : 0;
    if (ax !== bx) return ax - bx;
    return at.localeCompare(bt);
  });
}

// Extract domain names from a zone file (BIND format)
// Zone files have lines like: example com. 3600 IN NS ns1.example.com.
// We just want unique second-level domain names
async function extractDomains(zonePath, tld) {
  const domains = new Set();
  const rl = readline.createInterface({
    input: fs.createReadStream(zonePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line || line.startsWith(';') || line.startsWith('$')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    // First field is the domain name — relative ("example") or FQDN ("example.capital.")
    let name = parts[0].toLowerCase().replace(/\.$/, '');
    if (name.endsWith(`.${tld}`)) name = name.slice(0, -(tld.length + 1));
    if (!name || name === tld || name.includes('.')) continue; // skip sub-zones
    domains.add(`${name}.${tld}`);
  }

  return domains;
}

// Compare yesterday vs today, return dropped (in yesterday, not today)
function diffDomains(yesterday, today) {
  const dropped = [];
  for (const d of yesterday) {
    if (!today.has(d)) dropped.push(d);
  }
  return dropped;
}

function parseDomain(domain) {
  const lower = domain.toLowerCase().trim();
  const dotIdx = lower.lastIndexOf('.');
  const tld = dotIdx >= 0 ? lower.slice(dotIdx) : '';
  const name = dotIdx >= 0 ? lower.slice(0, dotIdx) : lower;
  return {
    domain: lower,
    tld,
    length: name.length,
    has_numbers: /\d/.test(name) ? 1 : 0,
    has_hyphens: /-/.test(name) ? 1 : 0,
  };
}

function addReturnedNewNames(newRegMap, result, tld) {
  if (!result || !Array.isArray(result.addedNames) || result.addedNames.length === 0) return;
  const dot = `.${tld}`;
  for (const baseName of result.addedNames) {
    if (!baseName || baseName.includes('.')) continue;
    if (!newRegMap.has(baseName)) newRegMap.set(baseName, new Set());
    newRegMap.get(baseName).add(dot);
  }
}

function utcReportDate(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function addReturnedNewNamesByDate(newRegMapsByDate, reportDate, result, tld) {
  if (!newRegMapsByDate.has(reportDate)) newRegMapsByDate.set(reportDate, new Map());
  addReturnedNewNames(newRegMapsByDate.get(reportDate), result, tld);
}

function appendReturnedDropped(results, result, tld) {
  if (!result || !Array.isArray(result.droppedNames) || result.droppedNames.length === 0) return;
  const dropDate = new Date().toISOString().slice(0, 10);
  for (const baseName of result.droppedNames) {
    const parsed = parseDomain(`${baseName}.${tld}`);
    results.push({
      ...parsed,
      stream: 'just-dropped',
      source: 'CZDS Zone Diff',
      drop_date: dropDate,
      auction_url: null,
    });
  }
}

async function indexDownloadedZone(tld, filePath, gzipped) {
  const { indexZoneFile, indexZoneFileGzipped } = require('../server/zone-indexer');
  return gzipped
    ? indexZoneFileGzipped(tld, filePath)
    : indexZoneFile(tld, filePath);
}

async function runCZDS(options = {}) {
  const fastPass = options.fast !== false;
  const includeHeavy = options.includeHeavy === true || process.env.CZDS_INCLUDE_HEAVY === '1';
  const maxTlds = Number(options.maxTlds || process.env.CZDS_FAST_TLD_LIMIT || (fastPass ? 40 : 0));
  const fastMaxZoneBytes = Number(options.maxZoneMb || process.env.CZDS_FAST_MAX_ZONE_MB || 100) * 1024 * 1024;
  const targetTlds = new Set(String(options.tlds || process.env.CZDS_TARGET_TLDS || '')
    .split(',')
    .map(tld => tld.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean));

  if (!process.env.CZDS_USER || !process.env.CZDS_PASS) {
    console.warn('[CZDS] No credentials — skipping. Add CZDS_USER + CZDS_PASS to .env');
    return [];
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  let token;
  try {
    token = await getCZDSToken();
    console.log('[CZDS] Authenticated');
  } catch (err) {
    console.error('[CZDS] Auth failed:', err.message);
    return [];
  }

  let links;
  try {
    links = await getZoneLinks(token);
    console.log(`[CZDS] ${links.length} zone links available`);
  } catch (err) {
    console.error('[CZDS] Failed to get links:', err.message);
    return [];
  }

  const results = [];

  // A complete accessible-zone sweep can cross UTC midnight. Partition new
  // registrations by the date each zone is actually processed so a long run
  // cannot silently attribute the 23rd's evidence to the 22nd.
  // reportDate → (baseName → Set<'.tld'>)
  const newRegMapsByDate = new Map();
  let processed = 0;
  let deferredHeavy = 0;

  let sortedLinks = sortZoneLinks(links);

  // Coverage-first: load the set of ALREADY-indexed TLDs directly from zone_indexed_tlds
  // via a fresh read-only connection. getIndexedTldSet() returns empty here (its getDb
  // connection reads 0 for reasons not worth chasing), which broke skipping and made the
  // build re-process zones it already had (no-op IGNORE inserts, never reaching the
  // missing ones). This direct query reliably returns the real set.
  // BUGFIX (2026-08-19): this used to record every TLD EVER indexed and skip
  // it forever whenever CZDS_SKIP_REINDEX=1. That is correct for the one-time
  // initial gap-fill build, but the long-running daily keep-alive supervisors
  // (zone-fast-supervisor.sh, zone-build-supervisor.sh's coverage pass) also
  // run with CZDS_SKIP_REINDEX=1. Once the initial build finished (~1080 TLDs
  // around 2026-08-14), every TLD counted as "already indexed" forever, so
  // every subsequent run skipped every zone -- no zone file was ever
  // re-downloaded/diffed again, addedNames stayed empty, and
  // recordKeywordTrends() was never invoked with data. Track "already
  // diffed for TODAY's file_date" instead, so the daily loop still re-diffs
  // each zone once per day and keyword-trend capture resumes.
  const indexedFileDateByTld = new Map();
  if (process.env.CZDS_SKIP_REINDEX === '1') {
    try {
      const Database = require('better-sqlite3');
      const zdb = new Database(path.join(DATA_BASE, 'zone_index.db'), { readonly: true });
      zdb.pragma('busy_timeout = 8000');
      for (const r of zdb.prepare('SELECT tld, file_date FROM zone_indexed_tlds').all()) {
        indexedFileDateByTld.set(r.tld, r.file_date);
      }
      zdb.close();
      console.log(`[CZDS] coverage-first: loaded ${indexedFileDateByTld.size} per-zone date receipts`);
    } catch (e) { console.log('[CZDS] could not load indexed set:', e.message); }
  }

  if (targetTlds.size > 0) {
    const available = new Set(sortedLinks.map(tldFromLink).filter(Boolean));
    const missing = [...targetTlds].filter(tld => !available.has(tld));
    if (missing.length) console.log(`[CZDS] Target TLDs unavailable from CZDS: ${missing.map(t => '.' + t).join(', ')}`);
    sortedLinks = sortedLinks.filter(link => targetTlds.has(tldFromLink(link)));
    console.log(`[CZDS] Targeted sync: ${sortedLinks.length} matching zone links`);
  }

  for (const link of sortedLinks) {
    // Extract TLD from URL (e.g. .../com.zone.gz)
    const tld = tldFromLink(link);
    if (!tld) continue;
    const reportDate = utcReportDate();

    try {
      const { isTldIndexedForDate } = require('../server/zone-indexer');
      // Coverage-first: skip a zone only if it has ALREADY been diffed for
      // the per-zone report date -- not merely "ever
      // indexed", which is what silently stalled zone_keyword_trends capture
      // past 2026-08-14 (see BUGFIX note above).
      if (process.env.CZDS_SKIP_REINDEX === '1' && indexedFileDateByTld.get(tld) === reportDate) {
        continue;
      }
      if (isTldIndexedForDate(tld, reportDate)) {
        console.log(`[CZDS] .${tld} already indexed for ${reportDate} — skipping`);
        continue;
      }
    } catch (_) {}

    if (targetTlds.size === 0 && fastPass && HEAVY_TLDS.has(tld) && !includeHeavy) {
      deferredHeavy++;
      continue;
    }

    if (targetTlds.size === 0 && maxTlds > 0 && processed >= maxTlds) {
      console.log(`[CZDS] Fast pass limit reached (${maxTlds} TLDs); remaining zones deferred`);
      break;
    }

    processed++;

    // Large/high-value zones: keep compressed and stream-index directly.
    if (GZ_ONLY_TLDS.has(tld)) {
      const gzPath = path.join(DATA_DIR, `${tld}-${reportDate}.zone.gz`);
      if (!fs.existsSync(gzPath)) {
        console.log(`[CZDS] Downloading .${tld} zone file (keeping compressed)...`);
        try {
          await downloadZoneGzipped(token, link, gzPath);
          console.log(`[CZDS] .${tld} downloaded (${(fs.statSync(gzPath).size / 1024 / 1024 / 1024).toFixed(1)} GB compressed)`);
        } catch (err) {
          console.error(`[CZDS] Download failed for .${tld}:`, err.message);
          continue;
        }
      } else {
        console.log(`[CZDS] .${tld} zone already cached for today (compressed)`);
      }

      try {
        const indexResult = await indexDownloadedZone(tld, gzPath, true);
        appendReturnedDropped(results, indexResult, tld);
        addReturnedNewNamesByDate(newRegMapsByDate, reportDate, indexResult, tld);
        try {
          const { recordZoneDailyTokens } = require('../server/zone-indexer');
          recordZoneDailyTokens(tld, indexResult?.addedNames || [], reportDate);
        } catch (tokenErr) {
          console.error(`[CZDS] .${tld}: recordZoneDailyTokens failed:`, tokenErr.message);
        }
        if (indexResult?.droppedCount > indexResult?.returnedDroppedCount) {
          console.log(`[CZDS] .${tld}: ${indexResult.droppedCount.toLocaleString()} dropped; returned ${indexResult.returnedDroppedCount.toLocaleString()} for just-dropped stream`);
        }
      } catch (err) {
        console.error(`[CZDS] Index failed for .${tld}:`, err.message);
      }

      cleanOldZones(DATA_DIR, tld, 1, '.zone.gz');
      await sleep(1000);
      continue;
    }

    const todayPath = path.join(DATA_DIR, `${tld}-${reportDate}.zone`);

    // Download today's zone if not already cached
    if (!fs.existsSync(todayPath)) {
      console.log(`[CZDS] Downloading .${tld} zone file...`);
      try {
        await downloadZone(token, link, todayPath);
        console.log(`[CZDS] .${tld} downloaded`);
      } catch (err) {
        console.error(`[CZDS] Download failed for .${tld}:`, err.message);
        continue;
      }
    } else {
      console.log(`[CZDS] .${tld} zone already cached for today`);
    }

    if (targetTlds.size === 0 && fastPass && !includeHeavy) {
      const zoneSize = fs.statSync(todayPath).size;
      if (zoneSize > fastMaxZoneBytes) {
        console.log(`[CZDS] .${tld} zone is ${(zoneSize / 1024 / 1024).toFixed(0)} MB; deferred from fast pass`);
        try { fs.unlinkSync(todayPath); } catch (_) {}
        deferredHeavy++;
        await sleep(250);
        continue;
      }
    }

    try {
      const indexResult = await indexDownloadedZone(tld, todayPath, false);
      appendReturnedDropped(results, indexResult, tld);
      addReturnedNewNamesByDate(newRegMapsByDate, reportDate, indexResult, tld);
      try {
        const { recordZoneDailyTokens } = require('../server/zone-indexer');
        recordZoneDailyTokens(tld, indexResult?.addedNames || [], reportDate);
      } catch (tokenErr) {
        console.error(`[CZDS] .${tld}: recordZoneDailyTokens failed:`, tokenErr.message);
      }
      if (indexResult?.status === 'indexed') {
        console.log(
          `[CZDS] .${tld}: ${Number(indexResult.count || 0).toLocaleString()} indexed, ` +
          `${Number(indexResult.addedCount || 0).toLocaleString()} added, ` +
          `${Number(indexResult.droppedCount || 0).toLocaleString()} dropped`
        );
      }
      if (indexResult?.droppedCount > indexResult?.returnedDroppedCount) {
        console.log(`[CZDS] .${tld}: ${indexResult.droppedCount.toLocaleString()} dropped; returned ${indexResult.returnedDroppedCount.toLocaleString()} for just-dropped stream`);
      }
    } catch (err) {
      console.error(`[CZDS] Index failed for .${tld}:`, err.message);
    }

    // Keep only today's source file; yesterday's snapshot lives in SQLite.
    cleanOldZones(DATA_DIR, tld, 1);

    await sleep(1000);
  }

  if (deferredHeavy) {
    console.log(`[CZDS] Fast pass deferred ${deferredHeavy} heavyweight TLDs for the overnight/full sync`);
  }

  // After processing all TLDs, write trending keywords to zone index
  if (newRegMapsByDate.size > 0) {
    try {
      const { recordKeywordTrends } = require('../server/zone-indexer');
      for (const [reportDate, newRegMap] of [...newRegMapsByDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (newRegMap.size > 0) recordKeywordTrends(newRegMap, reportDate);
      }
    } catch (err) {
      console.error('[CZDS] Failed to record keyword trends:', err.message);
    }
  }

  return results;
}

function cleanOldZones(dir, tld, keepDays, ext = '.zone') {
  const cutoff = Date.now() - (keepDays * 86400000);
  try {
    fs.readdirSync(dir)
      .filter(f => f.startsWith(`${tld}-`) && f.endsWith(ext))
      .forEach(f => {
        const dateStr = f.replace(`${tld}-`, '').replace(ext, '');
        const d = new Date(dateStr).getTime();
        if (d < cutoff) {
          fs.unlinkSync(path.join(dir, f));
        }
      });
  } catch (_) {}
}

module.exports = { runCZDS, utcReportDate, addReturnedNewNamesByDate };
