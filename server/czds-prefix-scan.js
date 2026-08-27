require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');
const zlib = require('zlib');
const readline = require('readline');
const Database = require('better-sqlite3');
const path = require('path');
const {
  normalizePrefix,
  startPrefixCorpus,
  refreshPrefixMeta,
  finishPrefixCorpus,
  replacePrefixTldHits,
  markPrefixTldFailed,
  isPrefixTldCurrent,
} = require('./research-prefix-index');
const { createEvidenceObjectStore } = require('./evidence-object-store');
const { CloudPrefixCorpusWriter } = require('./cloud-prefix-corpus');

const DATA_BASE = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const ZONE_INDEX_DB = path.join(DATA_BASE, 'zone_index.db');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetries(operation, {
  attempts = 3,
  baseDelayMs = 1000,
  sleepFn = sleep,
  onRetry = () => {},
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error('Retry attempts must be an integer from 1 to 5');
  }
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      onRetry(error, { attempt, nextAttempt: attempt + 1, delayMs });
      await sleepFn(delayMs);
    }
  }
  throw lastError;
}

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function nextPrefix(s) {
  if (!s) return '\uffff';
  const chars = s.split('');
  chars[chars.length - 1] = String.fromCharCode(chars[chars.length - 1].charCodeAt(0) + 1);
  return chars.join('');
}

async function getCZDSToken() {
  const user = process.env.CZDS_USER;
  const pass = process.env.CZDS_PASS;
  if (!user || !pass) throw new Error('CZDS_USER / CZDS_PASS not set in .env');
  const resp = await axios.post(
    'https://account-api.icann.org/api/authenticate',
    { username: user, password: pass },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
  );
  return resp.data.accessToken;
}

async function getZoneLinks(token) {
  const resp = await axios.get('https://czds-api.icann.org/czds/downloads/links', {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  return resp.data || [];
}

function tldFromLink(link) {
  const match = String(link || '').match(/\/([a-z0-9-]+)\.zone/i);
  return match ? match[1].toLowerCase() : null;
}

const PRIORITY = [
  'com', 'net', 'org', 'io', 'ai', 'co', 'app', 'dev', 'tech', 'store',
  'xyz', 'online', 'site', 'shop', 'cloud', 'digital', 'software', 'systems',
  'network', 'solutions', 'services', 'agency', 'group', 'company',
];

function sortLinks(links) {
  const pri = new Map(PRIORITY.map((t, i) => [t, i]));
  return [...links].sort((a, b) => {
    const at = tldFromLink(a) || '';
    const bt = tldFromLink(b) || '';
    const ap = pri.has(at) ? pri.get(at) : 10_000;
    const bp = pri.has(bt) ? pri.get(bt) : 10_000;
    if (ap !== bp) return ap - bp;
    return at.localeCompare(bt);
  });
}

function getIndexedDb(dbPath = ZONE_INDEX_DB) {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 10000');
  return db;
}

function indexedTldsForDate(fileDate, dbPath = ZONE_INDEX_DB) {
  let db;
  try {
    db = getIndexedDb(dbPath);
    return new Set(db.prepare('SELECT tld FROM zone_indexed_tlds WHERE file_date = ?').all(fileDate).map(r => r.tld));
  } catch {
    // The local index is only an optimization. Cloud scans must remain able to
    // stream every zone when an ephemeral host has no index yet.
    return new Set();
  } finally {
    db?.close();
  }
}

function indexedTldsSince(minFileDate, dbPath = ZONE_INDEX_DB) {
  let db;
  try {
    db = getIndexedDb(dbPath);
    return new Set(db.prepare('SELECT tld FROM zone_indexed_tlds WHERE file_date >= ?').all(minFileDate).map(r => r.tld));
  } catch {
    return new Set();
  } finally {
    db?.close();
  }
}

function indexedPrefixNames(prefix, tld, fileDate, dbPath = ZONE_INDEX_DB) {
  let db;
  try {
    db = getIndexedDb(dbPath);
    const indexed = db.prepare('SELECT file_date FROM zone_indexed_tlds WHERE tld = ?').get(tld);
    if (!indexed || indexed.file_date !== fileDate) return null;
    const lo = prefix;
    const hi = nextPrefix(prefix);
    return db.prepare(`
      SELECT base_name
      FROM zone_names
      WHERE tld = ? AND base_name >= ? AND base_name < ?
      ORDER BY base_name
    `).all(`.${tld}`, lo, hi).map(r => r.base_name);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function indexedPrefixNamesSince(prefix, tld, minFileDate, dbPath = ZONE_INDEX_DB) {
  let db;
  try {
    db = getIndexedDb(dbPath);
    const indexed = db.prepare('SELECT file_date FROM zone_indexed_tlds WHERE tld = ?').get(tld);
    if (!indexed || indexed.file_date < minFileDate) return null;
    const lo = prefix;
    const hi = nextPrefix(prefix);
    const names = db.prepare(`
      SELECT base_name
      FROM zone_names
      WHERE tld = ? AND base_name >= ? AND base_name < ?
      ORDER BY base_name
    `).all(`.${tld}`, lo, hi).map(r => r.base_name);
    return { fileDate: indexed.file_date, names };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function normalizeZoneName(raw, tld) {
  let name = String(raw || '').toLowerCase();
  if (name.charCodeAt(name.length - 1) === 46) name = name.slice(0, -1);
  if (name.endsWith(`.${tld}`)) name = name.slice(0, -(tld.length + 1));
  if (!name || name.includes('.') || name === tld) return null;
  return name;
}

async function scanDownloadedZone(token, link, tld, prefix) {
  const resp = await axios.get(link, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'stream',
    timeout: 900000,
  });

  const hits = new Set();
  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({
    input: resp.data.pipe(gunzip),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line || line.charCodeAt(0) === 59 || line.charCodeAt(0) === 36) continue;
    const spaceIdx = line.indexOf(' ');
    const tabIdx = line.indexOf('\t');
    const sepIdx = spaceIdx < 0 ? tabIdx : (tabIdx < 0 ? spaceIdx : Math.min(spaceIdx, tabIdx));
    if (sepIdx < 1) continue;
    const name = normalizeZoneName(line.slice(0, sepIdx), tld);
    if (name && name.startsWith(prefix)) hits.add(name);
  }

  return [...hits].sort();
}

async function main() {
  const prefix = normalizePrefix(argValue('prefix'));
  const force = process.argv.includes('--force');
  if (!prefix || prefix.length < 2) throw new Error('Use --prefix=<2+ chars>');

  const today = new Date().toISOString().slice(0, 10);
  const indexedSince = argValue('indexed-since') || today;
  const streamAttempts = Number(argValue('stream-attempts') || 3);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(indexedSince)) throw new Error('Use --indexed-since=YYYY-MM-DD');
  if (!Number.isSafeInteger(streamAttempts) || streamAttempts < 1 || streamAttempts > 5) {
    throw new Error('Use --stream-attempts=<1-5>');
  }
  console.log(`[PrefixScan] Starting CZDS prefix corpus for "${prefix}"`);

  const token = await getCZDSToken();
  const indexedToday = indexedTldsSince(indexedSince);
  const links = sortLinks(await getZoneLinks(token)).sort((a, b) => {
    const at = tldFromLink(a) || '';
    const bt = tldFromLink(b) || '';
    const ai = indexedToday.has(at) ? 0 : 1;
    const bi = indexedToday.has(bt) ? 0 : 1;
    return ai - bi;
  });
  const accessibleTlds = links.map(tldFromLink).filter(Boolean);
  const objectStore = createEvidenceObjectStore();
  const cloudWriter = objectStore
    ? new CloudPrefixCorpusWriter({ store: objectStore, prefix, totalTlds: accessibleTlds.length })
    : null;
  if (cloudWriter) await cloudWriter.start();
  else startPrefixCorpus(prefix, links.length, accessibleTlds);
  console.log(`[PrefixScan] ${links.length} zone links available`);

  let done = 0;
  for (const link of links) {
    const tld = tldFromLink(link);
    if (!tld) continue;
    if (!cloudWriter && !force && isPrefixTldCurrent(prefix, tld, today)) {
      done++;
      continue;
    }

    try {
      const indexed = indexedPrefixNamesSince(prefix, tld, indexedSince);
      let hits = indexed?.names || null;
      if (hits) {
        const source = `zone-index:${indexed.fileDate}`;
        if (cloudWriter) await cloudWriter.recordTld(tld, hits, source);
        else replacePrefixTldHits(prefix, tld, indexed.fileDate, hits, source);
        console.log(`[PrefixScan] .${tld}: ${hits.length.toLocaleString()} hits from ${source}`);
      } else {
        console.log(`[PrefixScan] .${tld}: streaming zone for "${prefix}"...`);
        hits = await withRetries(
          () => scanDownloadedZone(token, link, tld, prefix),
          {
            attempts: streamAttempts,
            onRetry: (error, retry) => console.warn(
              `[PrefixScan] .${tld}: transient stream failure (${String(error?.message || error)}); retry ${retry.nextAttempt}/${streamAttempts} in ${retry.delayMs}ms`,
            ),
          },
        );
        if (cloudWriter) await cloudWriter.recordTld(tld, hits, 'czds-stream');
        else replacePrefixTldHits(prefix, tld, today, hits, 'czds-stream');
        console.log(`[PrefixScan] .${tld}: ${hits.length.toLocaleString()} hits`);
      }
      done++;
      if (done % 25 === 0) {
        if (cloudWriter) await cloudWriter.checkpoint('running');
        else refreshPrefixMeta(prefix, 'running');
      }
    } catch (err) {
      if (cloudWriter) await cloudWriter.recordFailure(tld, err);
      else markPrefixTldFailed(prefix, tld, today, 'failed');
      console.error(`[PrefixScan] .${tld} failed:`, err.message);
    }
    await sleep(150);
  }

  const receipt = cloudWriter
    ? await cloudWriter.finish()
    : finishPrefixCorpus(prefix, 'complete');
  console.log(`[PrefixScan] ${receipt.complete ? 'Complete' : 'Partial'} for "${prefix}": ${receipt.checked_tlds}/${receipt.total_tlds} zones, ${receipt.failed_tlds} failed`);
}

if (require.main === module) {
  main().catch(err => {
    const prefix = normalizePrefix(argValue('prefix'));
    if (prefix) finishPrefixCorpus(prefix, 'failed');
    console.error('[PrefixScan] Failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { indexedPrefixNames, indexedTldsForDate, indexedPrefixNamesSince, indexedTldsSince, withRetries };
