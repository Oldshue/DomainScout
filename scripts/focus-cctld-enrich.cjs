#!/usr/bin/env node
/**
 * Focused ccTLD enrichment — fast stopgap so the "taken in .ai" filter actually
 * surfaces imminent auctions.
 *
 * WHY THIS EXISTS: the full tlds-worker checks ~286 ccTLD lookups per name at
 * ~5.5k names/hr. It cannot keep the ~505k upcoming-auction base set covered, and
 * its work queue is capped (QUEUE_MAX) + refilled only on full drain, so freshly
 * imminent auctions (e.g. agentframe.com, ending tomorrow) are never ccTLD-checked
 * before they close. The takenIn=ai filter reads ONLY tld_check_cache for ccTLDs,
 * so an unchecked name is invisible — that is why the filter showed ~24 of 667+.
 *
 * This pass checks ONLY a tiny curated ccTLD set (default .ai,.io,.co) — 1-3 DNS
 * lookups per name instead of ~286 — over the upcoming-auction base names that have
 * NO tld_check_cache row yet (additive: never clobbers the richer full-universe
 * rows). Soonest auctions first, so tomorrow's auctions are covered in seconds.
 * The full worker later re-checks these names with its full universe (different
 * source/all_count → still treated as unchecked), restoring complete counts.
 */
const dnsLib = require('dns');
const db = require('../server/db');

const TLDS = String(process.env.FOCUS_TLDS || '.ai,.io,.co')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  .map(t => (t.startsWith('.') ? t : '.' + t));
const SOURCE = 'dns-ns-focused-sibling';
const WINDOW_DAYS = Math.max(1, parseInt(process.env.FOCUS_WINDOW_DAYS || '14', 10));
const CONCURRENCY = Math.max(10, parseInt(process.env.FOCUS_CONCURRENCY || '200', 10));
const DNS_TIMEOUT_MS = Math.max(300, parseInt(process.env.FOCUS_DNS_TIMEOUT_MS || '900', 10));

db.pragma('busy_timeout = 30000');

const UDP_SERVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '1.0.0.1', '8.8.4.4', '149.112.112.112', '208.67.222.222', '208.67.220.220'];
const UDP_RESOLVERS = UDP_SERVERS.map(s => {
  const r = new dnsLib.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  r.setServers([s]);
  return r;
});
let udpIdx = 0;
const DOH = [
  (n) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=NS`,
  (n) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=NS`,
];
let dohIdx = 0;

async function resolveNsUdpOnce(domain) {
  const r = UDP_RESOLVERS[udpIdx++ % UDP_RESOLVERS.length];
  try {
    const ns = await r.resolveNs(domain);
    return (Array.isArray(ns) && ns.length > 0) ? 'yes' : 'no';
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return 'no';
    return 'err';
  }
}
async function resolveNsDohOnce(domain, provider) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DNS_TIMEOUT_MS);
  try {
    const r = await fetch(DOH[provider % DOH.length](domain), { headers: { accept: 'application/dns-json' }, signal: ctrl.signal });
    if (!r.ok) return 'err';
    const j = await r.json();
    if (j.Status === 0) return (Array.isArray(j.Answer) && j.Answer.some(a => a.type === 2)) ? 'yes' : 'no';
    if (j.Status === 3) return 'no';
    return 'err';
  } catch (_) { return 'err'; } finally { clearTimeout(timer); }
}
async function resolveNs(domain, attempts = 4) {
  for (let a = 0; a < attempts; a++) {
    const state = await resolveNsUdpOnce(domain);
    if (state === 'yes') return true;
    if (state === 'no') return false;
    if (a < attempts - 1) await new Promise(r => setTimeout(r, 60 * (a + 1)));
  }
  const doh = await resolveNsDohOnce(domain, dohIdx++);
  if (doh === 'yes') return true;
  if (doh === 'no') return false;
  return null; // unknown — leave uncounted, do not write a false 'not taken'
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sibling_tld_status (
    base_name TEXT NOT NULL,
    tld TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('taken', 'not_taken')),
    source TEXT NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (base_name, tld)
  ) WITHOUT ROWID;
`);
const upsert = db.prepare(`
  INSERT INTO sibling_tld_status (base_name, tld, status, source, checked_at)
  VALUES (@baseName, @tld, @status, @source, datetime('now'))
  ON CONFLICT(base_name, tld) DO UPDATE SET
    status = excluded.status,
    source = excluded.source,
    checked_at = excluded.checked_at
`);

// Keep the inverted ccTLD index (used by the takenIn filter fast path) instantly fresh
// for names this pass enriches — so a just-checked imminent auction is filterable now,
// not only after the next materialize rebuild. Table is owned/rebuilt by
// materialize-auction-tlds; create-if-missing guards startup ordering.
db.exec(`CREATE TABLE IF NOT EXISTS cctld_taken_idx (tld TEXT, base_name TEXT, PRIMARY KEY (tld, base_name)) WITHOUT ROWID`);
const idxInsert = db.prepare(`INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name) VALUES (@tld, @baseName)`);
const idxDelete = db.prepare(`DELETE FROM cctld_taken_idx WHERE tld = @tld AND base_name = @baseName`);

// Candidates: distinct base_names of upcoming GoDaddy auctions with NO cache row yet,
// soonest-ending first. Per-stream + merge keeps it on idx_stream_auction_end.
function loadCandidates() {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + WINDOW_DAYS * 86400000).toISOString();
  const freshness = TLDS.map((_tld, index) => `NOT EXISTS (
    SELECT 1 FROM sibling_tld_status s
    WHERE s.base_name = domains.base_name
      AND s.tld = @tld${index}
      AND datetime(s.checked_at) >= datetime('now', '-6 hours')
  )`).join(' OR ');
  const rows = db.prepare(`
    SELECT base_name, MIN(auction_end) AS ae
    FROM domains
    WHERE stream = 'godaddy-auction'
      AND base_name IS NOT NULL AND base_name != ''
      AND auction_end > @now AND auction_end <= @cutoff
      AND (${freshness})
    GROUP BY base_name
    ORDER BY ae ASC
  `).all({
    now,
    cutoff,
    ...Object.fromEntries(TLDS.map((tld, index) => [`tld${index}`, tld])),
  });
  return rows.map(r => r.base_name);
}

async function main() {
  const t0 = Date.now();
  console.log(`[focus] tlds=${TLDS.join(',')} window=${WINDOW_DAYS}d concurrency=${CONCURRENCY}`);
  const names = loadCandidates();
  console.log(`[focus] ${names.length} uncached upcoming-auction base names to check`);
  let done = 0, takenAny = 0;
  let idx = 0;
  const pool = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < names.length) {
      const baseName = names[idx++];
      const taken = [];
      for (const tld of TLDS) {
        const result = await resolveNs(baseName + tld);
        if (result === true) taken.push(tld);
        if (result === null) continue;
        try {
          upsert.run({ baseName, tld, status: result ? 'taken' : 'not_taken', source: SOURCE });
          (result ? idxInsert : idxDelete).run({ tld, baseName });
        } catch (_) { /* busy/locked — skip; next pass will retry */ }
      }
      if (taken.length) takenAny++;
      if (++done % 1000 === 0) {
        const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
        console.log(`[focus] ${done}/${names.length} (${rate}/s), ${takenAny} with a ccTLD taken`);
      }
    }
  });
  await Promise.all(pool);
  console.log(`[focus] DONE ${done} checked, ${takenAny} had >=1 of ${TLDS.join(',')} taken, in ${((Date.now()-t0)/1000/60).toFixed(1)}m`);
}

// FOCUS_LOOP=1 keeps the pass resident: after each sweep it sleeps, then re-scans
// for newly-scraped uncached imminent auctions (loadCandidates only returns names
// with no cache row, so completed names are skipped). This keeps the "taken in .ai"
// filter populated for fresh auctions the slow full-universe worker can't reach in
// time. Run under launchd (com.hamp.domainscout.focuscctld) with KeepAlive.
const LOOP = process.env.FOCUS_LOOP === '1';
const LOOP_SLEEP_MS = Math.max(60000, parseInt(process.env.FOCUS_LOOP_SLEEP_MS || '1800000', 10));

(async () => {
  if (!LOOP) { await main(); process.exit(0); }
  for (;;) {
    try { await main(); } catch (e) { console.error('[focus] pass error:', e.message); }
    console.log(`[focus] sleeping ${(LOOP_SLEEP_MS/60000).toFixed(0)}m before next sweep`);
    await new Promise(r => setTimeout(r, LOOP_SLEEP_MS));
  }
})();
