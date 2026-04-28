/**
 * ICANN CZDS — Centralized Zone Data Service
 * Diffs zone files day-over-day to find dropped domains.
 *
 * Free account required: https://czds.icann.org
 * Set CZDS_USER and CZDS_PASS in .env
 *
 * Covers: .com, .net, .org, .info, .biz (gTLDs with public zone files)
 * Does NOT cover: .io, .ai, .sh, .bot (ccTLDs — use crt.sh for those)
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '../data/zones');
const TARGET_TLDS = ['com', 'net', 'org'];

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

// Download a zone file and save it
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
    // First field is the domain name (relative or FQDN)
    let name = parts[0].toLowerCase().replace(/\.$/, '');
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

  for (const link of links) {
    // Extract TLD from URL (e.g. .../com.zone.gz)
    const match = link.match(/\/([a-z0-9-]+)\.zone/i);
    if (!match) continue;
    const tld = match[1].toLowerCase();
    if (!TARGET_TLDS.includes(tld)) continue;

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
    console.log(`[CZDS] .${tld}: ${dropped.length} dropped domains`);

    for (const domain of dropped) {
      const parsed = parseDomain(domain);
      results.push({
        ...parsed,
        stream: 'just-dropped',
        source: 'CZDS Zone Diff',
        auction_url: null,
      });
    }

    // Cleanup zone files older than 3 days
    cleanOldZones(DATA_DIR, tld, 3);

    await sleep(1000);
  }

  return results;
}

function cleanOldZones(dir, tld, keepDays) {
  const cutoff = Date.now() - (keepDays * 86400000);
  try {
    fs.readdirSync(dir)
      .filter(f => f.startsWith(`${tld}-`) && f.endsWith('.zone'))
      .forEach(f => {
        const dateStr = f.replace(`${tld}-`, '').replace('.zone', '');
        const d = new Date(dateStr).getTime();
        if (d < cutoff) {
          fs.unlinkSync(path.join(dir, f));
        }
      });
  } catch (_) {}
}

module.exports = { runCZDS };
