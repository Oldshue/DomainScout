#!/usr/bin/env node
'use strict';

// Dev fixture for the Sale Watch day-by-day feed. Boots the REAL server
// (server/index.js) on a given port against a generated fixture Sale Watch
// database: 14 days, about 1,300 ledger rows across every venue table row
// (resale marketplaces, parking, registrar defaults, hosting, an unknown
// venue) and every tier, plus a few stored insights. Auth is satisfied for
// local use with DISABLE_AUTH=1 (the server's existing local switch); nothing
// in production auth changes.
//
// One command:
//   node scripts/dev-sale-watch-feed.js --port 4777
// then open http://127.0.0.1:4777/ and pick the Sale Watch tab (or open it in a
// headless browser at 390x844). Ctrl-C stops the server and removes the
// fixture directory. --fixture-only <dir> writes the database and exits.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repo = path.join(__dirname, '..');
const DAYS = 14;
const PER_DAY = 93; // 14 x 93 = 1,302 rows

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dayMinus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

function sellers() {
  const nsc = require(path.join(repo, 'server/nameserver-classes'));
  const pick = (list, n) => list.filter((e, i, a) => a.findIndex(x => x.provider === e.provider) === i).slice(0, n);
  const ns = e => (e.nameserver.split('.').length > 2 ? [e.nameserver] : [`ns1.${e.nameserver}`, `ns2.${e.nameserver}`]);
  return [
    ...pick(nsc.SELLER_NAMESERVERS, 12).map(e => ({ venue: e.provider, ns: ns(e) })),
    ...pick(nsc.PARKING_NAMESERVERS, 3).map(e => ({ venue: e.provider, ns: ns(e) })),
    ...pick(nsc.REGISTRAR_DEFAULT_NAMESERVERS, 10).map(e => ({ venue: e.provider, ns: ns(e) })),
    ...pick(nsc.HOSTING_NAMESERVERS, 3).map(e => ({ venue: e.provider, ns: ns(e) })),
    { venue: 'Weird Market', ns: ['ns1.weirdmarket.example', 'ns2.weirdmarket.example'] },
  ];
}

const WORDS = ['bright', 'path', 'nova', 'pilot', 'harbor', 'mint', 'cedar', 'atlas', 'lumen', 'forge', 'quill', 'orbit', 'tidal', 'ember', 'vault', 'crisp', 'delta', 'gusto', 'ivory', 'jolly'];
const TLDS = ['com', 'com', 'com', 'ai', 'io', 'co', 'net'];

function buildFixture(dir) {
  const Database = require('better-sqlite3');
  const recon = require(path.join(repo, 'server/sale-watch-reconstruction'));
  const search = require(path.join(repo, 'server/sale-watch-search'));
  const store = require(path.join(repo, 'server/sale-watch-assessments'));
  const ins = require(path.join(repo, 'server/sale-watch-insights'));
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'sale_watch.db'));
  recon.ensureReconstructionSchema(db);
  search.ensureSearchSchema(db);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const venues = sellers();
  const put = db.prepare(`INSERT OR IGNORE INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 1, ?, ?)`);
  const domains = [];
  db.transaction(() => {
    let n = 0;
    for (let d = 0; d < DAYS; d += 1) {
      const day = dayMinus(today, d);
      for (let i = 0; i < PER_DAY; i += 1, n += 1) {
        const seller = venues[n % venues.length];
        const label = `${WORDS[n % WORDS.length]}${WORDS[(n * 7 + 3) % WORDS.length]}${n % 5 === 0 ? `-${n % 97}` : n % 11 === 0 ? String(n % 9) : ''}${n}`;
        const domain = `${label}.${TLDS[n % TLDS.length]}`;
        const kind = n % 4; // 0 built + transfer, 1 registrar change, 2 pending transfer, 3 quiet
        const discovery = { movement: { day, prevDay: dayMinus(day, 1), previousNameservers: seller.ns, currentNameservers: ['ns1.host.example'], source: 'daily-zone-delegation-diff' }, structurallyMoved: true, departureDate: day, priorSiteEvidence: { status: 'parked' },
          rdap: { registrar: ['GoDaddy', 'Namecheap', 'Porkbun', 'Dynadot'][n % 4], events: [{ eventAction: 'registration', eventDate: `${1996 + (n % 29)}-03-01T00:00:00Z` }] } };
        if (kind === 0) Object.assign(discovery, { buyerUse: true, transferEvidence: { registrarChanged: true, observedAt: `${day}T05:00:00Z` }, homepage: { active: true, parked: false, placeholder: false, status: 200, title: `${label} team planning`, finalUrl: `https://${domain}/` } });
        if (kind === 1) discovery.transferEvidence = { registrarChanged: true, observedAt: `${day}T05:00:00Z` };
        if (kind === 2) discovery.rdap = { ...discovery.rdap, pendingTransfer: 1, statuses: ['pending transfer'] };
        if (n % 17 === 0) discovery.otherExtensions = { count: n % 23, verified: true };
        const ev = { domain, tier: 'suspected', reportDate: day, venue: seller.venue, sellerNameservers: seller.ns, buyerNameservers: ['ns1.host.example'], buyerTitle: kind === 0 ? label : undefined, discovery };
        const json = JSON.stringify(ev);
        put.run(domain, day, day, day, day, json, `${day}T06:00:00Z`);
        search.writeSearchDocument(db, domain, json);
        domains.push({ domain, kind });
      }
    }
  })();
  store.storeAssessmentsSync(db, { now });
  ins.ensureInsightSchema(db);
  const rows = domains.filter(x => x.kind === 0).slice(0, 8).map((x, i) => ({
    domain: x.domain, tape: 'aftermarket', construction: 'two-word', category: ['career coaching', 'fintech', 'ai tooling', 'home services'][i % 4],
    buyerType: 'small-business', signal: 'strong', registeredYear: 2004 + i, wordCount: 2, buyerUrl: `https://${x.domain}/`,
    lesson: 'Plain two-word names are selling to small operating businesses.',
  }));
  const checked = ins.validateInsightPayload({ schema: ins.WRITE_SCHEMA, source: { kind: 'agentforge-run', runId: 'dev-fixture', model: 'none' }, rows });
  ins.writeInsights(db, { source: { kind: 'agentforge-run', runId: 'dev-fixture', model: 'none' }, rows: checked.valid });
  const count = db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates').get().n;
  db.close();
  return { rows: count, insights: checked.valid.length };
}

async function main() {
  const only = arg('--fixture-only', null);
  if (only) { console.log(JSON.stringify(buildFixture(only))); return; }
  const port = Number(arg('--port', process.env.PORT || '4777'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-sale-watch-feed-'));
  const made = buildFixture(dir);
  console.log(`[dev-sale-watch-feed] fixture ${dir}: ${made.rows} ledger rows, ${made.insights} insights`);
  const env = { ...process.env, PORT: String(port), DISABLE_AUTH: '1', RAILWAY_VOLUME_MOUNT_PATH: dir, DOMAINSCOUT_UNIVERSE_DIR: path.join(dir, 'universe') };
  delete env.DOMAINSCOUT_SALE_WATCH_RECON_ENABLED;
  // The server spawns helpers that outlive SIGTERM: run it as its own group.
  const child = spawn(process.execPath, ['server/index.js'], { cwd: repo, env, stdio: 'inherit', detached: true });
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  process.on('exit', stop);
  child.on('exit', code => { stop(); process.exit(code || 0); });
  console.log(`[dev-sale-watch-feed] open http://127.0.0.1:${port}/ (Sale Watch tab) once /api/health reports saleWatchMigration ready`);
}

main().catch(error => { console.error(error); process.exit(1); });
