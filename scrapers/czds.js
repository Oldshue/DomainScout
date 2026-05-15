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

const DATA_BASE = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const DATA_DIR  = path.join(DATA_BASE, 'zones');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Auth: get JWT from ICANN
async function getCZDSToken() {
  const user = process.env.CZDS_USER;
  const pass = process.env.CZDS_PASS;
  if (!user || !pass) throw new Error('CZDS_USER / CZDS_PASS not set in .env');

  const resp = await axios.post(
    'https://account-api.icann.org/api/authenticate',
    { username: user, password: pass },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return resp.data.accessToken;
}

// List available zone file download links
async function getZoneLinks(token) {
  const resp = await axios.get(
    'https://czds-api.icann.org/czds/downloads/links',
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    }
  );
  return resp.data; // array of download URLs
}

// Download a zone file, decompress, and save as plain text
async function downloadZone(token, url, outPath) {
  const tmpPath = `${outPath}.part`;
  try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'stream',
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
}

// Download a zone file keeping it compressed (.zone.gz) — used for .com to avoid
// writing the ~12 GB decompressed file; indexer streams gunzip on the fly instead.
async function downloadZoneGzipped(token, url, outPath) {
  const tmpPath = `${outPath}.part`;
  try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'stream',
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

function appendReturnedDropped(results, result, tld) {
  if (!result || !Array.isArray(result.droppedNames) || result.droppedNames.length === 0) return;
  for (const baseName of result.droppedNames) {
    const parsed = parseDomain(`${baseName}.${tld}`);
    results.push({
      ...parsed,
      stream: 'just-dropped',
      source: 'CZDS Zone Diff',
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
  const today = new Date().toISOString().slice(0, 10);

  // Accumulates new registrations across all TLDs for trending keyword analysis
  // baseName → Set<'.tld'>
  const newRegMap = new Map();
  let processed = 0;
  let deferredHeavy = 0;

  for (const link of sortZoneLinks(links)) {
    // Extract TLD from URL (e.g. .../com.zone.gz)
    const tld = tldFromLink(link);
    if (!tld) continue;

    try {
      const { isTldIndexedForDate } = require('../server/zone-indexer');
      if (isTldIndexedForDate(tld, today)) {
        console.log(`[CZDS] .${tld} already indexed for ${today} — skipping`);
        continue;
      }
    } catch (_) {}

    if (fastPass && HEAVY_TLDS.has(tld) && !includeHeavy) {
      deferredHeavy++;
      continue;
    }

    if (maxTlds > 0 && processed >= maxTlds) {
      console.log(`[CZDS] Fast pass limit reached (${maxTlds} TLDs); remaining zones deferred`);
      break;
    }

    processed++;

    // Large/high-value zones: keep compressed and stream-index directly.
    if (GZ_ONLY_TLDS.has(tld)) {
      const gzPath = path.join(DATA_DIR, `${tld}-${today}.zone.gz`);
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
        addReturnedNewNames(newRegMap, indexResult, tld);
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

    const todayPath = path.join(DATA_DIR, `${tld}-${today}.zone`);

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

    if (fastPass && !includeHeavy) {
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
      addReturnedNewNames(newRegMap, indexResult, tld);
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
  if (newRegMap.size > 0) {
    try {
      const { recordKeywordTrends } = require('../server/zone-indexer');
      recordKeywordTrends(newRegMap, today);
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

module.exports = { runCZDS };
