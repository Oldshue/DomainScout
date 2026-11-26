'use strict';

// Shared DNS is never a platform (server/nameserver-classes.js
// learnedPlatformDecision). A name that leaves a marketplace for a registrar's
// default nameservers or for shared hosting DNS is where a buyer's name sits
// after a sale: it is admitted as a candidate and reads 'unknown' in the ledger
// until its assessment decides it, never 'Moved to another seller or parking'.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const recon = require('../server/sale-watch-reconstruction');
const store = require('../server/sale-watch-assessments');
const ledger = require('../server/sale-watch-ledger');
const evidence = require('../server/sale-watch-evidence');
const classes = require('../server/nameserver-classes');

const AFTERNIC = ['ns1.afternic.com', 'ns2.afternic.com'];
const GODADDY = ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'];
const CLOUDFLARE = ['norm.ns.cloudflare.com', 'sharon.ns.cloudflare.com'];
const CLOUDFLARE_SMALL = ['amy.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
const JULY = ['ns1.julydns.com', 'ns2.julydns.com'];
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function buildDb(file = ':memory:') {
  const db = new Database(file);
  recon.ensureReconstructionSchema(db);
  return db;
}
function writeTape(dir, day, rows) {
  const folder = path.join(dir, day, 'ns');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'movement.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ day, prevDay: daysAgo(99), zones: 1069, departures: rows.length }));
}
const dep = (domain, to, extra = {}) => ({ domain, selection: 'departures', prev_class: 'seller', today_class: 'other', prev_provider: 'Afternic', prev_ns: AFTERNIC, today_ns: to, ...extra });
const cohort = (prefix, n, to) => Array.from({ length: n }, (_, i) => dep(`${prefix}${String(i).padStart(4, '0')}.com`, to));
const ledgerRows = db => db.prepare(`SELECT domain, verdict, cls, dest, src FROM ${ledger.TABLE} ORDER BY domain`).all()
  .map(r => ({ domain: r.domain, verdict: ledger.VERDICTS[r.verdict], cls: ledger.CLASSIFICATIONS[r.cls], dest: r.dest, src: r.src }));
const verdictCounts = db => { const o = {}; for (const r of ledgerRows(db)) o[r.verdict] = (o[r.verdict] || 0) + 1; return o; };

test('the rule: registrar default never, shared hosting only for a bulk cohort on one exact set, anything else as before', () => {
  assert.equal(classes.sharedDnsClass(GODADDY), 'registrar');
  assert.equal(classes.sharedDnsClass(['ns1.dnsowl.com', 'ns2.dnsowl.com']), 'registrar');
  assert.equal(classes.sharedDnsClass(CLOUDFLARE), 'hosting');
  assert.equal(classes.sharedDnsClass(['ns-1.awsdns-01.org', 'ns-2.awsdns-02.co.uk']), 'hosting');
  assert.equal(classes.sharedDnsClass(['ns1-01.azure-dns.com']), 'hosting');
  assert.equal(classes.sharedDnsClass(['ns1.vercel-dns.com']), 'hosting');
  assert.equal(classes.sharedDnsClass(JULY), null);
  assert.equal(classes.sharedDnsClass(['ns1.sedoparking.com']), null, 'a marketplace host is not shared DNS');
  assert.equal(classes.sharedDnsClass(['ns1.sav.com', 'ns2.sav.com']), null, 'a parking host under a registrar domain is still parking');
  assert.equal(classes.sharedDnsClass(['ns1.pendingrenewaldeletion.com']), null);

  const decide = (hosts, dailyCount, trailingCount = 0) => classes.learnedPlatformDecision(hosts, { dailyCount, trailingCount }).learned;
  assert.equal(decide(GODADDY, 5000, 90000), false, 'registrar default: whatever the volume');
  assert.equal(decide(CLOUDFLARE, classes.SHARED_HOSTING_BULK_THRESHOLD - 1, 5000), false, 'shared hosting below the bulk threshold, trailing volume ignored');
  assert.equal(decide(CLOUDFLARE, classes.SHARED_HOSTING_BULK_THRESHOLD), true);
  assert.equal(decide(CLOUDFLARE.join(','), 2000), true, 'the key form is accepted');
  assert.equal(decide(JULY, classes.LEARNED_PLATFORM_DAILY_THRESHOLD), true, 'an unknown nameserver domain keeps the learned rule');
  assert.equal(decide(JULY, 3, 30), true);
  assert.equal(decide(JULY, 3, 3), false);
  assert.equal(classes.SHARED_HOSTING_BULK_THRESHOLD, 100);
});

test('import: GoDaddy-default and Cloudflare destinations are admitted and unknown; a 2,000-name Cloudflare cohort and a julydns cohort are still moved', async () => {
  const db = buildDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shared-'));
  const day = daysAgo(2);
  writeTape(dir, day, [
    ...cohort('godaddy', 40, GODADDY),
    ...cohort('cfsmall', 12, CLOUDFLARE_SMALL),
    ...cohort('cfbulk', 2000, CLOUDFLARE),
    ...cohort('july', 15, JULY),
    dep('relisted.com', ['ns1.sedoparking.com', 'ns2.sedoparking.com']),
  ]);
  await recon.ingestMovementCandidates(db, { directory: dir, indexSearch: false });
  const rows = ledgerRows(db);
  const of = prefix => rows.filter(r => r.domain.startsWith(prefix));

  assert.equal(of('godaddy').length, 40);
  assert.ok(of('godaddy').every(r => r.verdict === 'unknown' && r.dest === 'GoDaddy default' && r.src === ledger.SRC_IMPORT));
  assert.equal(of('cfsmall').length, 12);
  assert.ok(of('cfsmall').every(r => r.verdict === 'unknown' && r.dest === 'Cloudflare'));
  assert.equal(of('cfbulk').length, 2000);
  assert.ok(of('cfbulk').every(r => r.verdict === 'moved' && r.cls === 'platform-destination'), 'one exact Cloudflare set taking 2,000 names in a day is one operator');
  assert.ok(of('july').every(r => r.verdict === 'moved' && r.cls === 'platform-destination' && r.dest === 'julydns.com'));
  assert.equal(of('relisted')[0].verdict, 'moved');

  // Candidates: the shared-DNS names, and nothing from the excluded cohorts.
  const candidates = db.prepare('SELECT domain FROM sale_watch_candidates').all().map(r => r.domain);
  assert.equal(candidates.length, 52);
  assert.ok(candidates.every(d => /^(godaddy|cfsmall)/.test(d)));
  const summary = JSON.parse(db.prepare('SELECT summary_json FROM sale_watch_movement_imports WHERE day = ?').get(day).summary_json);
  assert.equal(summary.platformExcluded, 2016);
  assert.equal(summary.sharedAdmitted, 52, 'departures the volume rule alone would have excluded are counted');

  // Completeness holds the moment the import ends, and says how many rows wait.
  const page = ledger.readLedgerDaily(db, ledger.normalizeLedgerQuery({ verdict: 'all', window: '14' }));
  const c = page.days.find(d => d.day === day).completeness;
  assert.deepEqual({ expected: c.expected, ledger: c.ledger, difference: c.difference, waiting: c.waiting, missing: c.missing }, { expected: 2068, ledger: 2068, difference: 0, waiting: 52, missing: 0 });
  assert.equal(c.readmission, undefined, 'a day imported under the current rule needs no re-admission');

  // The normal assessment decides them: with no further evidence, unknown (never moved).
  store.storeAssessmentsSync(db);
  const after = ledgerRows(db);
  for (const prefix of ['godaddy', 'cfsmall']) {
    const list = after.filter(r => r.domain.startsWith(prefix));
    assert.ok(list.every(r => ['unknown', 'lead'].includes(r.verdict) && r.src === ledger.SRC_ASSESSMENT), `${prefix}: decided by the assessment`);
    assert.ok(list.every(r => r.verdict !== 'moved' && r.verdict !== 'portfolio'));
    assert.ok(list.every(r => r.dest), 'the destination is kept');
  }
  assert.equal(after.length, 2068, 'one row per departure');
  assert.equal(db.prepare(`SELECT SUM(w) AS w FROM ${ledger.DAYS_TABLE}`).get().w, 0);
  fs.rmSync(dir, { recursive: true });
  db.close();
});

// A seller departure as the import stores it, for the adjudicator.
function entry(domain, to, daysBack, extra = {}) {
  const d = daysAgo(daysBack);
  return {
    domain, tier: 'suspected', sellerNameservers: AFTERNIC, buyerNameservers: to, reportDate: d, venue: 'Afternic', lastObservedAt: new Date().toISOString(),
    discovery: { structurallyMoved: true, departureDate: d, movement: { day: d, prevDay: daysAgo(daysBack + 1), previousClass: 'seller', currentClass: extra.currentClass || 'registrar', currentNameservers: to, cohortSize: extra.cohortSize || 40 }, ...(extra.discovery || {}) },
  };
}
const verdictOf = (e, options = {}) => { const a = evidence.assessSaleEntry(e, { now: new Date(), ...options }); return { verdict: evidence.ledgerVerdict(a), classification: a.classification, basis: a.assessment.basis }; };
const busy = () => ({ dailyCount: 5000, trailingCount: 50000 });

test('adjudicator: a shared-DNS destination is never turned back into moved', () => {
  // A learned-platform lookup that reports huge volume does not make shared DNS a platform.
  assert.equal(verdictOf(entry('gd.com', GODADDY, 8), { learnedPlatformLookup: busy }).verdict, 'unknown');
  assert.equal(verdictOf(entry('cf.com', CLOUDFLARE_SMALL, 8, { currentClass: 'hosting' }), { learnedPlatformLookup: () => ({ dailyCount: 60, trailingCount: 900 }) }).verdict, 'unknown');
  // ... while the same volume on an unknown nameserver domain, or a bulk cohort on one Cloudflare set, still is.
  assert.equal(verdictOf(entry('jl.com', JULY, 8, { currentClass: 'other', cohortSize: 1 }), { learnedPlatformLookup: busy }).classification, 'platform-destination');
  assert.equal(verdictOf(entry('cb.com', CLOUDFLARE, 8, { currentClass: 'hosting' }), { learnedPlatformLookup: () => ({ dailyCount: 2000 }) }).classification, 'platform-destination');

  // The registrar's own parked page on registrar-default DNS is not sale or parking evidence:
  // a site that is not live never downgrades the name.
  const parked = { homepage: { title: 'gd.com', status: 200, parked: true, purpose: { kind: 'sales-lander', forSale: true, offered: false } }, parkingInfrastructure: true, rdap: { checkedAt: new Date().toISOString(), events: [], statuses: [] } };
  assert.equal(verdictOf(entry('gd.com', GODADDY, 8, { discovery: parked })).verdict, 'unknown');
  assert.equal(verdictOf(entry('gd.com', GODADDY, 20, { discovery: parked })).classification, 'likely-sale', 'the existing off-market rule applies once the page is not counted against it');
  // An explicit offer of the domain is still a lander, on any DNS.
  const offered = { homepage: { title: 'gd.com is for sale', status: 200, parked: true, purpose: { kind: 'sales-lander', forSale: true, offered: true } } };
  assert.deepEqual(verdictOf(entry('gd.com', GODADDY, 8, { discovery: offered })), { verdict: 'moved', classification: 'lander-migration', basis: null });
  // A probe stored before `offered` existed keeps its for-sale reading.
  const legacy = { homepage: { title: 'gd.com', status: 200, purpose: { kind: 'sales-lander', forSale: true } } };
  assert.equal(verdictOf(entry('gd.com', GODADDY, 8, { discovery: legacy })).classification, 'lander-migration');
  // Off registrar-default DNS a parked page reads as before.
  assert.equal(verdictOf(entry('ot.com', ['ns1.some-host.net', 'ns2.some-host.net'], 8, { currentClass: 'other', cohortSize: 1, discovery: parked })).classification, 'lander-migration');

  // With evidence it follows the existing rules.
  const at = n => `${daysAgo(n)}T10:00:00Z`;
  const transferred = { rdap: { checkedAt: new Date().toISOString(), transferAt: at(7), events: [{ action: 'transfer', date: at(7) }], statuses: [], registrar: 'GoDaddy.com, LLC' } };
  assert.deepEqual(verdictOf(entry('gd.com', GODADDY, 8, { discovery: transferred })), { verdict: 'sold', classification: 'likely-sale', basis: 'transfer' });
  // Inside the 21-day window after its registration anniversary, no transfer, no built site: expired.
  const anniversary = new Date(Date.now() - 13 * 86400000); anniversary.setUTCFullYear(anniversary.getUTCFullYear() - 3);
  const lapsed = { rdap: { checkedAt: new Date().toISOString(), events: [{ action: 'registration', date: anniversary.toISOString() }], statuses: [] } };
  assert.deepEqual(verdictOf(entry('gd.com', GODADDY, 8, { discovery: lapsed })), { verdict: 'expired', classification: 'expiration', basis: 'anniversary' });
});

test('adjudicator: a re-admitted departure is not called a likely sale before its first check', () => {
  const old = entry('gd.com', GODADDY, 25, { discovery: { readmitted: true } });
  assert.equal(verdictOf(old).verdict, 'unknown', 'no registry record: the anniversary cannot be read yet');
  const checked = entry('gd.com', GODADDY, 25, { discovery: { readmitted: true, rdap: { checkedAt: new Date().toISOString(), events: [], statuses: [] } } });
  assert.equal(verdictOf(checked).classification, 'likely-sale');
  assert.equal(verdictOf(entry('gd.com', GODADDY, 25)).classification, 'likely-sale', 'a departure admitted by the import is unchanged');
});

// A day as the old rule left it: every shared-DNS cohort filed as 'moved', no candidate.
function oldRuleDay(db, dir, day, rows) {
  writeTape(dir, day, rows);
  ledger.ensureLedgerSchema(db);
  db.prepare('INSERT INTO sale_watch_movement_imports VALUES(?,?,?,?,?,?)').run(day, 'old', new Date().toISOString(), rows.length, 0, JSON.stringify({ platformExcluded: rows.length, excludedByPolicy: 0 }));
  for (const r of rows) ledger.recordImportDeparture(db, { domain: r.domain, day, verdict: 'moved', classification: 'platform-destination', dest: classes.registrableNsDomain(r.today_ns[0]) });
  ledger.markImportDay(db, day, 'old');
}

test('backfill: moved rows on shared DNS are re-admitted as candidates for their day and set to unknown; idempotent', async () => {
  const db = buildDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shared-'));
  const day = daysAgo(20);
  const rows = [...cohort('godaddy', 30, GODADDY), ...cohort('cfsmall', 12, CLOUDFLARE_SMALL), ...cohort('cfbulk', 150, CLOUDFLARE), ...cohort('july', 15, JULY), dep('skipped.xyz', GODADDY)];
  oldRuleDay(db, dir, day, rows);
  assert.deepEqual(verdictCounts(db), { moved: 208 });
  const before = ledger.readLedgerDaily(db, ledger.normalizeLedgerQuery({ verdict: 'all', window: '30' }));
  assert.equal(before.days.find(d => d.day === day).completeness.readmission, 'pending');
  assert.equal(before.window.completeness.daysNotReadmitted, 1);

  const first = await ledger.maintainLedger(db, { directory: dir, log: null });
  assert.deepEqual({ days: first.readmitted.days, readmitted: first.readmitted.readmitted, complete: first.readmitted.complete }, { days: 1, readmitted: 42, complete: true });
  assert.deepEqual(verdictCounts(db), { moved: 166, unknown: 42 }, 'the bulk Cloudflare set, julydns and the untracked extension stay as recorded');
  const readmitted = ledgerRows(db).filter(r => r.verdict === 'unknown');
  assert.ok(readmitted.every(r => /^(godaddy|cfsmall)/.test(r.domain) && r.src === ledger.SRC_IMPORT && r.dest));
  assert.equal(readmitted.find(r => r.domain.startsWith('godaddy')).dest, 'GoDaddy default', 'the destination is kept, under its provider name');
  assert.equal(readmitted.find(r => r.domain.startsWith('cfsmall')).dest, 'Cloudflare');
  // Candidates for the recorded day, probed after fresh departures, marked re-admitted.
  const cands = db.prepare('SELECT domain, exit_observed_day, last_stream, state, probe_count, evidence_json FROM sale_watch_candidates').all();
  assert.equal(cands.length, 42);
  assert.ok(cands.every(c => c.exit_observed_day === day && c.last_stream === 'historical-departure' && c.state === 'exited' && c.probe_count === 0));
  const ev = JSON.parse(cands[0].evidence_json);
  assert.equal(ev.discovery.readmitted, true);
  assert.deepEqual(ev.sellerNameservers, AFTERNIC);
  assert.ok(ev.discovery.movement.cohortSize >= 12);

  // Idempotent: the day is done; forcing it through again changes nothing.
  const again = await ledger.maintainLedger(db, { directory: dir, log: null });
  assert.deepEqual({ days: again.readmitted.days, readmitted: again.readmitted.readmitted }, { days: 0, readmitted: 0 });
  db.prepare('DELETE FROM sale_watch_meta WHERE key = ?').run(`${ledger.META_READMIT_PREFIX}${day}`);
  const forced = await ledger.readmitSharedDnsDepartures(db, { directory: dir });
  assert.deepEqual({ days: forced.days, readmitted: forced.readmitted }, { days: 1, readmitted: 0 });
  assert.deepEqual(verdictCounts(db), { moved: 166, unknown: 42 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates').get().n, 42);

  // The normal pipeline assesses them: 20 days on, unchecked, they stay unknown (not a sale, not moved).
  store.storeAssessmentsSync(db);
  assert.deepEqual(verdictCounts(db), { moved: 166, unknown: 42 });
  assert.ok(ledgerRows(db).filter(r => r.verdict === 'unknown').every(r => r.src === ledger.SRC_ASSESSMENT && r.dest));
  const page = ledger.readLedgerDaily(db, ledger.normalizeLedgerQuery({ verdict: 'all', window: '30' }));
  const c = page.days.find(d => d.day === day).completeness;
  assert.deepEqual({ expected: c.expected, ledger: c.ledger, difference: c.difference, waiting: c.waiting, readmission: c.readmission }, { expected: 208, ledger: 208, difference: 0, waiting: 0, readmission: undefined });
  fs.rmSync(dir, { recursive: true });
  db.close();
});

test('backfill: bounded per pass and resumable from the saved position; a day with no tape says so', async () => {
  const db = buildDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shared-'));
  const day = daysAgo(10);
  const gone = daysAgo(11);
  oldRuleDay(db, dir, day, cohort('godaddy', 95, GODADDY));
  oldRuleDay(db, dir, gone, cohort('lost', 20, GODADDY));
  fs.rmSync(path.join(dir, gone), { recursive: true });

  const one = await ledger.readmitSharedDnsDepartures(db, { directory: dir, maxRows: 40, batch: 20 });
  assert.deepEqual({ days: one.days, readmitted: one.readmitted, complete: one.complete }, { days: 0, readmitted: 40, complete: false });
  const saved = JSON.parse(db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(`${ledger.META_READMIT_PREFIX}${day}`).value);
  assert.deepEqual(saved, { tape: 0, line: 40, readmitted: 40 }, 'the position is saved with the batch');
  assert.equal(verdictCounts(db).unknown, 40);

  const two = await ledger.readmitSharedDnsDepartures(db, { directory: dir, maxRows: 40, batch: 20 });
  assert.deepEqual({ readmitted: two.readmitted, complete: two.complete }, { readmitted: 40, complete: false });
  const three = await ledger.readmitSharedDnsDepartures(db, { directory: dir, maxRows: 40, batch: 20 });
  assert.deepEqual({ days: three.days, readmitted: three.readmitted, complete: three.complete, missingTapes: three.missingTapes }, { days: 1, readmitted: 15, complete: true, missingTapes: 1 });
  assert.equal(verdictCounts(db).unknown, 95);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates').get().n, 95, 'no name was admitted twice across passes');
  assert.equal(db.prepare(`SELECT COUNT(DISTINCT domain) AS n FROM ${ledger.TABLE}`).get().n, db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE}`).get().n);

  // The day whose tape is gone keeps its rows as recorded, and the completeness line says so.
  assert.equal(ledgerRows(db).filter(r => r.domain.startsWith('lost')).every(r => r.verdict === 'moved'), true);
  const page = ledger.readLedgerDaily(db, ledger.normalizeLedgerQuery({ verdict: 'all', window: '30' }));
  assert.equal(page.days.find(d => d.day === gone).completeness.readmission, 'no-tape');
  assert.equal(page.days.find(d => d.day === day).completeness.readmission, undefined);
  assert.deepEqual([page.window.completeness.daysWithoutTape, page.window.completeness.daysNotReadmitted], [1, 0]);
  fs.rmSync(dir, { recursive: true });
  db.close();
});

test('backfill: seller departures of the last 14 days are re-admitted only as fast as the waves check them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shared-'));
  const db = buildDb(path.join(dir, 'sale_watch.db'));
  const keys = require('../server/sale-watch-candidate-keys');
  const freshness = require('../server/sale-watch-freshness');
  assert.equal(keys.candidateKeysReady(db), true);
  const day = daysAgo(4);
  oldRuleDay(db, dir, day, cohort('godaddy', 50, GODADDY));

  const one = await ledger.readmitSharedDnsDepartures(db, { directory: dir, sellerBacklog: 30, batch: 10 });
  assert.deepEqual({ readmitted: one.readmitted, sellerAdmitted: one.sellerAdmitted, complete: one.complete }, { readmitted: 30, sellerAdmitted: 30, complete: false });
  assert.equal(freshness.readSellerBacklog(db, Date.now()).unchecked, 30);
  // Each one carries its admission time, so the contract ages it from now, not from its departure day.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${freshness.SELLER_ADMISSIONS_TABLE}`).get().n, 30);
  // No room until the waves have checked them.
  const two = await ledger.readmitSharedDnsDepartures(db, { directory: dir, sellerBacklog: 30, batch: 10 });
  assert.deepEqual({ readmitted: two.readmitted, complete: two.complete }, { readmitted: 0, complete: false });
  db.prepare(`UPDATE sale_watch_candidates SET probe_count = 1, evidence_json = json_set(evidence_json, '$.discovery.rdap', json('{"checkedAt":"2026-11-26T00:00:00Z"}'))`).run();
  assert.equal(freshness.readSellerBacklog(db, Date.now()).unchecked, 0);
  const three = await ledger.readmitSharedDnsDepartures(db, { directory: dir, sellerBacklog: 30, batch: 10 });
  assert.deepEqual({ days: three.days, readmitted: three.readmitted, complete: three.complete }, { days: 1, readmitted: 20, complete: true });
  assert.deepEqual(verdictCounts(db), { unknown: 50 });

  // A day older than the contract window is not bounded by it.
  const older = daysAgo(30);
  oldRuleDay(db, dir, older, cohort('older', 40, GODADDY));
  const four = await ledger.readmitSharedDnsDepartures(db, { directory: dir, sellerBacklog: 5 });
  assert.deepEqual({ days: four.days, readmitted: four.readmitted, sellerAdmitted: four.sellerAdmitted }, { days: 1, readmitted: 40, sellerAdmitted: 0 });
  db.close();
  fs.rmSync(dir, { recursive: true });
});

test('backfill: a candidate of a later departure is left alone and the old day is settled, not left waiting', async () => {
  const db = buildDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shared-'));
  const day = daysAgo(12);
  const later = daysAgo(3);
  oldRuleDay(db, dir, day, cohort('godaddy', 12, GODADDY));
  db.prepare(`INSERT INTO sale_watch_candidates(domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, probe_count, evidence_json, updated_at)
    VALUES('godaddy0000.com', ?, ?, 'zone-seller-departure', ?, 'probing', 2, ?, ?)`).run(later, later, later, JSON.stringify(entry('godaddy0000.com', ['ns1.buyer-host.net'], 3, { currentClass: 'other', cohortSize: 1 })), new Date().toISOString());
  await ledger.readmitSharedDnsDepartures(db, { directory: dir });
  const kept = db.prepare("SELECT exit_observed_day, state, probe_count, last_stream FROM sale_watch_candidates WHERE domain = 'godaddy0000.com'").get();
  assert.deepEqual(kept, { exit_observed_day: later, state: 'probing', probe_count: 2, last_stream: 'zone-seller-departure' });
  const row = db.prepare(`SELECT verdict, src FROM ${ledger.TABLE} WHERE domain = 'godaddy0000.com' AND dayn = ?`).get(ledger.dayNumber(day));
  assert.deepEqual(row, { verdict: ledger.VERDICTS.indexOf('unknown'), src: ledger.SRC_ASSESSMENT });
  assert.equal(db.prepare(`SELECT w FROM ${ledger.DAYS_TABLE} WHERE dayn = ?`).get(ledger.dayNumber(day)).w, 11);
  // Its assessment writes the later day's row; the old day's row stays as the record of that departure.
  store.storeAssessmentsSync(db);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.TABLE} WHERE domain = 'godaddy0000.com'`).get().n, 2);
  fs.rmSync(dir, { recursive: true });
  db.close();
});

test('lock retry: a busy write lock is retried inside the pass with backoff instead of ending the stage', async () => {
  // The helper: SQLITE_BUSY is retried, anything else is thrown at once, and it gives up after its retries.
  const totals = {};
  let calls = 0;
  const value = await ledger.retryBusy(() => { calls += 1; if (calls < 3) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); return 'done'; }, totals, { backoffMs: 1 });
  assert.deepEqual([value, calls, totals.busyRetries], ['done', 3, 2]);
  await assert.rejects(ledger.retryBusy(() => { throw new Error('other'); }, totals, { backoffMs: 1 }), /other/);
  await assert.rejects(ledger.retryBusy(() => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); }, {}, { retries: 2, backoffMs: 1 }), /locked/);

  // The stage: another connection holds the write lock while the pass starts, and releases it shortly after.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shared-'));
  const file = path.join(dir, 'sale_watch.db');
  const db = buildDb(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 0');
  const day = daysAgo(5);
  oldRuleDay(db, dir, day, cohort('godaddy', 25, GODADDY));
  const blocker = new Database(file);
  blocker.pragma('busy_timeout = 0');
  blocker.exec('BEGIN IMMEDIATE');
  setTimeout(() => { blocker.exec('COMMIT'); blocker.close(); }, 400);
  const result = await ledger.maintainLedger(db, { directory: dir, log: null });
  assert.ok(result.busyRetries >= 1, `the pass waited for the lock (${result.busyRetries} retries)`);
  assert.equal(result.readmitted.error, undefined);
  assert.deepEqual({ days: result.readmitted.days, readmitted: result.readmitted.readmitted }, { days: 1, readmitted: 25 });
  assert.deepEqual(verdictCounts(db), { unknown: 25 });
  db.close();
  fs.rmSync(dir, { recursive: true });
});

test('a name that departs again keeps the row of its earlier departure', async () => {
  const db = buildDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shared-'));
  const d1 = daysAgo(6);
  const d2 = daysAgo(2);
  writeTape(dir, d1, [dep('twice.com', ['ns1.first-host.net', 'ns2.first-host.net'])]);
  await recon.ingestMovementCandidates(db, { directory: dir, indexSearch: false });
  store.storeAssessmentsSync(db);
  writeTape(dir, d2, [dep('twice.com', GODADDY)]);
  await recon.ingestMovementCandidates(db, { directory: dir, indexSearch: false });
  store.storeAssessmentsSync(db);
  const rows = db.prepare(`SELECT dayn, dest FROM ${ledger.TABLE} WHERE domain = 'twice.com' ORDER BY dayn`).all();
  assert.deepEqual(rows, [{ dayn: ledger.dayNumber(d1), dest: 'first-host.net' }, { dayn: ledger.dayNumber(d2), dest: 'GoDaddy default' }]);
  const page = ledger.readLedgerDaily(db, ledger.normalizeLedgerQuery({ verdict: 'all', window: '14' }));
  for (const d of [d1, d2]) assert.equal(page.days.find(x => x.day === d).completeness.difference, 0, d);
  fs.rmSync(dir, { recursive: true });
  db.close();
});

test('schema: a ledger from before the waiting count gains the column and its triggers without touching a row', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sale_watch_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE ${ledger.TABLE} (id INTEGER PRIMARY KEY, domain TEXT NOT NULL, dayn INTEGER NOT NULL, verdict INTEGER NOT NULL, cls INTEGER, dest TEXT, src INTEGER NOT NULL DEFAULT 0, words TEXT NOT NULL DEFAULT '');
    CREATE TABLE ${ledger.DAYS_TABLE} (dayn INTEGER PRIMARY KEY, n0 INTEGER NOT NULL DEFAULT 0, n1 INTEGER NOT NULL DEFAULT 0, n2 INTEGER NOT NULL DEFAULT 0, n3 INTEGER NOT NULL DEFAULT 0, n4 INTEGER NOT NULL DEFAULT 0, n5 INTEGER NOT NULL DEFAULT 0);
    CREATE TRIGGER ${ledger.TABLE}_ai AFTER INSERT ON ${ledger.TABLE} BEGIN
      INSERT INTO ${ledger.DAYS_TABLE}(dayn) SELECT new.dayn WHERE NOT EXISTS (SELECT 1 FROM ${ledger.DAYS_TABLE} WHERE dayn = new.dayn);
      UPDATE ${ledger.DAYS_TABLE} SET n4 = n4 + (new.verdict = 4) WHERE dayn = new.dayn;
    END;
    INSERT INTO ${ledger.TABLE}(id, domain, dayn, verdict) VALUES (1, 'old.com', 9800, 4);`);
  ledger.ensureLedgerSchema(db);
  ledger.ensureLedgerSchema(db);
  assert.deepEqual(db.prepare(`SELECT n4, w FROM ${ledger.DAYS_TABLE} WHERE dayn = 9800`).get(), { n4: 1, w: 0 });
  const day = ledger.dayOf(9801);
  const now = new Date(Date.parse(`${day}T12:00:00Z`));
  const waiting = ledger.recordAdmittedDeparture(db, { domain: 'new.com', day, dest: 'GoDaddy default', now });
  assert.equal(waiting.written, true);
  assert.equal(db.prepare(`SELECT w FROM ${ledger.DAYS_TABLE} WHERE dayn = 9801`).get().w, 1);
  // The assessment takes the row over in place, or moves it to another verdict: either way nothing waits.
  ledger.writeLedgerRow(db, { domain: 'new.com', day, verdict: 'unknown', classification: 'unconfirmed-move', now });
  assert.deepEqual(db.prepare(`SELECT n4, w FROM ${ledger.DAYS_TABLE} WHERE dayn = 9801`).get(), { n4: 1, w: 0 });
  assert.equal(db.prepare(`SELECT dest FROM ${ledger.TABLE} WHERE domain = 'new.com'`).get().dest, 'GoDaddy default');
  ledger.recordAdmittedDeparture(db, { domain: 'sold.com', day, dest: 'Cloudflare', now });
  ledger.writeLedgerRow(db, { domain: 'sold.com', day, verdict: 'sold', classification: 'likely-sale', now });
  assert.deepEqual(db.prepare(`SELECT n0, n4, w FROM ${ledger.DAYS_TABLE} WHERE dayn = 9801`).get(), { n0: 1, n4: 1, w: 0 });
  assert.deepEqual(db.prepare(`SELECT verdict, dest FROM ${ledger.TABLE} WHERE domain = 'sold.com'`).all(), [{ verdict: 0, dest: 'Cloudflare' }]);
  db.close();
});
