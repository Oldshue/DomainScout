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

const WORDS = ['bright', 'path', 'nova', 'pilot', 'harbor', 'mint', 'cedar', 'atlas', 'lumen', 'forge', 'quill', 'orbit', 'tidal', 'ember', 'vault', 'crisp', 'delta', 'gusto', 'ivory', 'jolly', 'maple', 'river', 'stone', 'cloud', 'spark', 'north', 'field', 'grove', 'haven', 'ocean', 'prism', 'ridge', 'solar', 'swift', 'urban', 'vivid', 'water', 'amber', 'bloom', 'coral'];
const TLDS = ['com', 'com', 'com', 'ai', 'io', 'co', 'net'];

// Production shape (operator probe of the production Sale Watch database, 14
// days): 'probable' about 149 likely-sale, 'transfer' about 156 (99 in
// progress, 57 completed), 'alpha' about 1,273 (likely-sale + 1,199
// acquisition-candidate), plus a much larger 'suspected' view (unconfirmed
// moves) that the feed must never read. Venue strings and proportions are the
// production 14-day alpha counts. About 60% of rows carry a stored
// registration date; a share of those are registered within 90 days.
const VENUE_WEIGHTS = Object.freeze([['Spaceship Parking', 338], ['Afternic', 292], ['Dynadot Parking', 165], ['HugeDomains / NameBright internal', 114], ['HugeDomains / NameBright', 56], ['Atom', 48], ['BrandBucket', 46], ['ParkLogic', 42], ['Sedo', 30], ['Above.com', 28], ['BuyDomains', 24], ['Dan', 22], ['ParkingCrew', 14], ['Atom / Squadhelp', 11], ['Juming', 10], ['Moniker', 9], ['Parktons', 8], ['SSLParking', 4], ['Ztomy', 3], ['Nameshift', 3], ['Epik', 2], ['Efty', 2], ['Bodis', 1], ['Uniregistry Market', 1], ['DCC DNS lander', 1], ['NamePros DNS', 1]]);
const SHAPE = Object.freeze({ likelySale: 149, transferInProgress: 99, transferCompleted: 57, candidate: 1199, suspected: 4000 });

function venueNameservers(venue) {
  const nsc = require(path.join(repo, 'server/nameserver-classes'));
  const e = [...nsc.SELLER_NAMESERVERS, ...nsc.PARKING_NAMESERVERS].find(x => x.provider === venue);
  const host = e.nameserver;
  return host.split('.').length > 2 ? [host] : [`ns1.${host}`, `ns2.${host}`];
}

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
  const observed = `${today}T04:00:00Z`;
  const venuePool = VENUE_WEIGHTS.flatMap(([v, w]) => Array(w).fill(v));
  const nsOf = new Map(VENUE_WEIGHTS.map(([v]) => [v, venueNameservers(v)]));
  const put = db.prepare(`INSERT OR IGNORE INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 1, ?, ?)`);
  const kinds = [];
  for (const [kind, n] of Object.entries(SHAPE)) for (let i = 0; i < n; i += 1) kinds.push(kind);
  const seen = new Set();
  const candidates = [];
  db.transaction(() => {
    kinds.forEach((kind, n) => {
      const day = dayMinus(today, n % DAYS);
      const venue = venuePool[(n * 7919) % venuePool.length];
      const ns = nsOf.get(venue);
      const w1 = WORDS[n % WORDS.length];
      const w2 = WORDS[Math.floor(n / WORDS.length) % WORDS.length];
      // Candidates and half the likely-sale names are clean dictionary pairs
      // (alpha quality); suspected moves carry digits like most real noise.
      const clean = kind === 'candidate' || (kind === 'likelySale' && n % 2 === 0);
      let label = clean ? `${w1}${w2}` : `${w1}${w2}${n}`;
      let domain = `${label}.${TLDS[Math.floor(n / (WORDS.length * WORDS.length)) % TLDS.length]}`;
      for (let k = 0; seen.has(domain); k += 1) domain = `${label}.${TLDS[(k + 1) % TLDS.length]}`;
      if (seen.has(domain)) { label = `${label}${n}`; domain = `${label}.com`; }
      seen.add(domain);
      const rdap = { registrar: ['GoDaddy', 'Namecheap', 'Porkbun', 'Dynadot'][n % 4], checkedAt: observed };
      if (n % 5 < 3) rdap.createdAt = n % 4 === 0 ? `${dayMinus(day, 20 + (n % 60))}T00:00:00Z` : `${1996 + (n % 27)}-03-01T00:00:00Z`;
      const discovery = { movement: { day, prevDay: dayMinus(day, 1), previousNameservers: ns, currentNameservers: ['ns1.host.example'], source: 'daily-zone-delegation-diff' }, structurallyMoved: true, departureDate: day, priorSiteEvidence: { status: 'parked' }, rdap };
      const ev = { domain, tier: 'suspected', reportDate: day, venue, sellerNameservers: ns, buyerNameservers: ['ns1.host.example'], lastObservedAt: observed, discovery };
      if (kind === 'likelySale') { discovery.transferEvidence = { registrarChanged: true, observedAt: `${day}T05:00:00Z` }; ev.classification = 'likely-sale'; }
      if (kind === 'transferInProgress') Object.assign(rdap, { pendingTransfer: 1, statuses: ['pending transfer'] });
      if (kind === 'transferCompleted') { discovery.transferEvidence = { registrarChanged: true, observedAt: `${day}T05:00:00Z` }; discovery.movement.cohortSize = 12; }
      if (kind === 'candidate') {
        const title = `${w1[0].toUpperCase()}${w1.slice(1)}${w2[0].toUpperCase()}${w2.slice(1)}`;
        Object.assign(discovery, { buyerUse: true, homepage: { active: true, parked: false, placeholder: false, status: 200, title: `${title} team planning`, description: 'Plan your work together', finalUrl: `https://${domain}/` } });
        ev.buyerTitle = title; ev.buyerUrl = `https://${domain}/`; ev.classification = 'acquisition-candidate';
        candidates.push(domain);
      }
      const json = JSON.stringify(ev);
      put.run(domain, day, day, day, day, json, `${day}T06:00:00Z`);
      search.writeSearchDocument(db, domain, json);
    });
  })();
  store.storeAssessmentsSync(db, { now });
  ins.ensureInsightSchema(db);
  const rows = candidates.slice(0, 8).map((domain, i) => ({
    domain, tape: 'aftermarket', construction: 'two-word', category: ['career coaching', 'fintech', 'ai tooling', 'home services'][i % 4],
    buyerType: 'small-business', signal: 'strong', registeredYear: 2004 + i, wordCount: 2, buyerUrl: `https://${domain}/`,
    lesson: 'Plain two-word names are selling to small operating businesses.',
  }));
  const checked = ins.validateInsightPayload({ schema: ins.WRITE_SCHEMA, source: { kind: 'agentforge-run', runId: 'dev-fixture', model: 'none' }, rows });
  ins.writeInsights(db, { source: { kind: 'agentforge-run', runId: 'dev-fixture', model: 'none' }, rows: checked.valid });
  const count = db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates').get().n;
  const views = db.prepare(`SELECT v.view, a.classification, COUNT(*) AS n FROM sale_watch_assessment_views v JOIN sale_watch_assessments a ON a.domain = v.domain
    WHERE v.view IN ('probable', 'transfer', 'alpha', 'suspected') GROUP BY v.view, a.classification ORDER BY v.view, n DESC`).all();
  db.close();
  return { rows: count, insights: checked.valid.length, views };
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
  // A local fixture screen starts no scraper, scheduler, wave or outbound request.
  Object.assign(env, {
    DOMAINSCOUT_BACKGROUND_JOBS: '0',
    DOMAINSCOUT_BACKGROUND_BULK_REFRESH_ENABLED: '0',
    DOMAINSCOUT_OWNER_NAMES_ENABLED: '0',
    DOMAINSCOUT_OWNER_NAMES_DNS_ENABLED: '0',
    DOMAINSCOUT_CT_LAUNCHES_ENABLED: '0',
    DOMAINSCOUT_LIVE_SITES_ENABLED: '0',
    DOMAINSCOUT_GODADDY_STARTUP_PREWARM: '0',
  });
  for (const k of ['DOMAINSCOUT_UNIVERSE_PULL_ENABLED', 'DOMAINSCOUT_HEAVY_REFRESH_CRON_ENABLED', 'DOMAINSCOUT_CZDS_SYNC_CRON_ENABLED', 'DOMAINSCOUT_DROP_FEED_ENABLED', 'DOMAINSCOUT_TLD_ACCURACY_WORKER', 'ENABLE_TLDS_WORKER', 'CZDS_USER', 'CZDS_PASS']) delete env[k];
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
