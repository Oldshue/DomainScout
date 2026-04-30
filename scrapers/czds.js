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
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'stream',
    timeout: 300000, // zone files can be large
  });

  await new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const out = fs.createWriteStream(outPath);
    resp.data.pipe(gunzip).pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

// Download a zone file keeping it compressed (.zone.gz) — used for .com to avoid
// writing the ~12 GB decompressed file; indexer streams gunzip on the fly instead.
async function downloadZoneGzipped(token, url, outPath) {
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'stream',
    timeout: 600000, // .com is large
  });

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    resp.data.pipe(out); // no gunzip — keep compressed
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

// TLDs too large to decompress to disk — downloaded as .gz and stream-indexed
const GZ_ONLY_TLDS = new Set(['com']);

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

async function runCZDS() {
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
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Accumulates new registrations across all TLDs for trending keyword analysis
  // baseName → Set<'.tld'>
  const newRegMap = new Map();

  for (const link of links) {
    // Extract TLD from URL (e.g. .../com.zone.gz)
    const match = link.match(/\/([a-z0-9-]+)\.zone/i);
    if (!match) continue;
    const tld = match[1].toLowerCase();

    // ── .com (and any other GZ_ONLY_TLDS): download compressed, stream-index, skip diff ──
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
      // Stream-index from gzip — fire-and-forget (takes ~15 min for .com)
      try {
        const { indexZoneFileGzipped } = require('../server/zone-indexer');
        indexZoneFileGzipped(tld, gzPath).catch(() => {});
      } catch (_) {}
      // Keep only today's .gz — no diff needed for .com
      cleanOldZones(DATA_DIR, tld, 1, '.zone.gz');
      await sleep(1000);
      continue;
    }

    const todayPath = path.join(DATA_DIR, `${tld}-${today}.zone`);
    const yesterdayPath = path.join(DATA_DIR, `${tld}-${yesterday}.zone`);

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

    // Index immediately after download so Research results grow progressively
    // (don't await — runs in parallel with the next download)
    try {
      const { indexZoneFile } = require('../server/zone-indexer');
      indexZoneFile(tld, todayPath).catch(() => {});
    } catch (_) {}

    // Need both files to diff
    if (!fs.existsSync(yesterdayPath)) {
      console.log(`[CZDS] No yesterday file for .${tld} — need two days of data to diff`);
      continue;
    }

    // Parse both files
    console.log(`[CZDS] Parsing .${tld} zone files...`);
    const [todaySet, yesterdaySet] = await Promise.all([
      extractDomains(todayPath, tld),
      extractDomains(yesterdayPath, tld),
    ]);

    console.log(`[CZDS] .${tld}: ${yesterdaySet.size} yesterday, ${todaySet.size} today`);

    // Dropped = in yesterday, not in today
    const dropped = diffDomains(yesterdaySet, todaySet);
    // Added = in today, not in yesterday (new registrations)
    const added = diffDomains(todaySet, yesterdaySet);

    console.log(`[CZDS] .${tld}: ${dropped.length} dropped, ${added.length} new registrations`);

    for (const domain of dropped) {
      const parsed = parseDomain(domain);
      results.push({
        ...parsed,
        stream: 'just-dropped',
        source: 'CZDS Zone Diff',
        auction_url: null,
      });
    }

    // Record daily stats for this TLD
    try {
      const { recordTldStats } = require('../server/zone-indexer');
      recordTldStats(tld, today, todaySet.size, added.length, dropped.length);
    } catch (_) {}

    // Accumulate new registrations for trending keywords
    const dotTld = '.' + tld;
    for (const domain of added) {
      const baseName = domain.slice(0, domain.lastIndexOf('.'));
      if (!baseName || baseName.includes('.')) continue;
      if (!newRegMap.has(baseName)) newRegMap.set(baseName, new Set());
      newRegMap.get(baseName).add(dotTld);
    }

    // Keep only 2 days per TLD — with 900+ TLDs, disk adds up fast
    cleanOldZones(DATA_DIR, tld, 2);

    await sleep(1000);
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
