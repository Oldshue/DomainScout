require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
// Prefer IPv4: on networks with broken IPv6 (e.g. travel/hotel wifi), node tries the
// IPv6 address first and hangs until timeout, while curl falls back to IPv4. This made
// every CZDS auth/links call "time out" and look like an ICANN outage. Force IPv4.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}
// Disable Happy Eyeballs: on a slow travel network it races IPv4/IPv6 and aborts the
// connect early ("connect ETIMEDOUT") even when a single IPv4 connect would succeed if
// given the full timeout. Force one clean IPv4 connection attempt.
try { require('net').setDefaultAutoSelectFamily(false); } catch {}

// Travel/hotel wifi drops out for seconds at a time. A momentary ENETUNREACH /
// ECONNRESET surfaces as an 'error' event on an orphan TLSSocket that escapes
// axios's promise and would otherwise crash the whole pass. For a long unattended
// batch job, a transient network blip must never kill the process — log it and
// exit cleanly so the restart loop resumes (coverage-first skips done zones).
const TRANSIENT_NET = new Set([
  'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND',
]);
function handleFatal(label, err) {
  const code = err && err.code;
  if (code && TRANSIENT_NET.has(code)) {
    console.error(`[CZDS] transient network ${code} (${label}) — exiting for clean restart, progress is saved`);
    process.exit(75); // EX_TEMPFAIL: restart loop will resume
  }
  console.error(`[CZDS] fatal ${label}:`, err && err.stack ? err.stack : err);
  process.exit(1);
}
process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => handleFatal('unhandledRejection', err));

const { runCZDS } = require('../scrapers/czds');
const { indexAllPendingZoneFiles, getZoneIndexStats, rebuildNameSummary } = require('./zone-indexer');
const { importCzdsDropCandidates } = require('./czds-drop-importer');
const { refreshExpiredAvailability } = require('./expired-availability');

function readNumberArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  if (!arg) return undefined;
  const n = Number(arg.slice(prefix.length));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readStringArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : undefined;
}

async function main() {
  const full = process.argv.includes('--full');
  const maxTlds = readNumberArg('max-tlds');
  const maxZoneMb = readNumberArg('max-zone-mb');
  const tlds = readStringArg('tlds');

  console.log(`[CZDS Worker] Starting ${full ? 'full' : 'fast'} sync`);
  await runCZDS({
    fast: !full,
    includeHeavy: full,
    maxTlds,
    maxZoneMb,
    tlds,
  });
  const zonesBefore = getZoneIndexStats().tlds;
  await indexAllPendingZoneFiles();

  let stats = getZoneIndexStats();
  // Single-pass GROUP BY rebuild whenever new zones were bulk-loaded (or summary empty).
  // Bulk-load runs with CZDS_UNSAFE_DIRECT_INDEX=1 (skips per-zone summary work); this is
  // the one rebuild at the end — not the per-zone random-I/O grind that took days.
  const newZones = stats.tlds - zonesBefore;
  const summaryWasDeferred = process.env.CZDS_SKIP_SUMMARY_REFRESH === '1';
  if (stats.names > 0 && (stats.summaryNames === 0 || newZones > 0 || summaryWasDeferred)) {
    console.log(`[CZDS Worker] ${newZones} new zone(s) loaded; rebuilding name_summary once after zone work...`);
    rebuildNameSummary();
    stats = getZoneIndexStats();
  }

  if (process.env.DOMAINSCOUT_CZDS_POST_IMPORT !== '0') {
    try {
      const importedDrops = importCzdsDropCandidates();
      if (importedDrops.selected > 0) {
        const tlds = Object.entries(importedDrops.byTld || {})
          .filter(([, count]) => Number(count || 0) > 0)
          .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
          .map(([tld]) => tld);
        console.log(
          `[CZDS Worker] Imported ${importedDrops.selected.toLocaleString()} dropped candidate rows ` +
          `(${Object.entries(importedDrops.byTld || {}).map(([tld, n]) => `${tld}:${n}`).join(', ')})`
        );
        const availability = await refreshExpiredAvailability({
          tlds,
          limit: process.env.DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_LIMIT || 2000,
          concurrency: process.env.DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_CONCURRENCY || 2,
          delayMs: process.env.DOMAINSCOUT_CZDS_EXPIRED_AVAILABILITY_DELAY_MS || 1000,
        });
        console.log(`[CZDS Worker] Expired availability after drop import: ${JSON.stringify(availability)}`);
      }
    } catch (err) {
      console.error('[CZDS Worker] Post-import expired availability skipped:', err.message);
    }
  }

  console.log(`[CZDS Worker] Complete: ${stats.tlds} TLDs, ${stats.names.toLocaleString()} names indexed`);
}

main().catch(err => {
  console.error('[CZDS Worker] Failed:', err.message);
  process.exitCode = 1;
});
