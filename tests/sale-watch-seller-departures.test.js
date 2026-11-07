'use strict';

// Production-shaped regressions for 2026-11-07: after a clean wave (3000
// probes, 2000 RDAP checks) only a fraction of the ~500/day seller /
// marketplace departures had been RDAP-checked or probed, because they shared
// last_stream 'zone-seller-departure' with ~70,000/day parking departures and
// the RDAP sweep walked exit day then domain. All on file-backed databases.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const recon = require('../server/sale-watch-reconstruction');
const keys = require('../server/sale-watch-candidate-keys');
const store = require('../server/sale-watch-assessments');
const { rdapSweep } = require('../server/sale-watch-rdap-sweep');
const fresh = require('../server/sale-watch-freshness');

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-seller-'));
  const db = new Database(path.join(dir, 'sale_watch.db'));
  db.pragma('busy_timeout = 30000');
  recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  return db;
}

function prevDay(day) {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10);
}

function insert(db, domain, { day, cls = 'parking', priority = -95, probeCount = 0, next = `${day}T00:00:00.000Z`, cohort = 1, kit = null } = {}) {
  const sellerNs = cls === 'seller' ? ['ns1.afternic.com', 'ns2.afternic.com'] : ['ns1.sedoparking.com', 'ns2.sedoparking.com'];
  const buyerNs = ['ns1.digitalocean.com', 'ns2.digitalocean.com'];
  const evidence = {
    domain, tier: 'suspected', sellerNameservers: sellerNs, buyerNameservers: buyerNs, reportDate: day, venue: cls === 'seller' ? 'Afternic' : 'Sedo',
    discovery: {
      structurallyMoved: true, departureDate: day,
      movement: { day, prevDay: prevDay(day), previousNameservers: sellerNs, currentNameservers: buyerNs, previousClass: cls, currentClass: 'hosting', cohortSize: cohort, source: 'daily-zone-delegation-diff' },
      ...(kit ? { kit: { key: kit, size: 2 } } : {}),
    },
  };
  db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, probe_priority, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, ?, ?, ?, ?)`).run(domain, prevDay(day), day, day, next, probeCount, priority, JSON.stringify(evidence), `${day}T00:00:00Z`);
}

function flood(db, n, days) {
  db.transaction(() => {
    for (let i = 0; i < n; i += 1) insert(db, `a${String(i).padStart(5, '0')}.com`, { day: days[i % days.length] });
  })();
}

const cleanRdap = now => async () => ({ checkedAt: now, registrar: 'Seller Registrar', registrarId: '1', transferAt: null, pendingTransfer: false, statuses: [], events: [] });

test('a flood of parking departures cannot delay a seller departure past one RDAP sweep or one probe wave', async () => {
  const db = open();
  assert.equal(keys.candidateKeysReady(db), true);
  const days = ['2026-11-05', '2026-11-06', '2026-11-07'];
  flood(db, 3000, days);
  const sellers = [];
  db.transaction(() => {
    for (let i = 0; i < 30; i += 1) {
      const d = `zz-seller${i}.com`;
      // A third are destination-kit members (kit tier), which the old urgent tier dropped.
      insert(db, d, { day: days[i % 3], cls: 'seller', priority: i % 3 === 0 ? -45 : -90, kit: i % 3 === 0 ? `kit${i}` : null });
      sellers.push(d);
    }
  })();
  const now = '2026-11-07T12:00:00.000Z';

  // Measurement: the previous sweep order reaches none of them in a 500-row slice.
  const oldOrder = db.prepare(`SELECT domain FROM sale_watch_candidates WHERE state = 'exited' AND probe_count = 0 AND exit_observed_day >= '2026-10-24'
    ORDER BY exit_observed_day DESC, domain ASC LIMIT 500`).all().map(r => r.domain);
  assert.equal(oldOrder.filter(d => sellers.includes(d)).length, 0, 'old order starves seller departures');

  const probeDue = recon.selectDueCandidates(db, { now, limit: 200 }).map(r => r.domain);
  assert.deepEqual(sellers.filter(d => !probeDue.includes(d)), [], 'every seller departure is in the first probe wave');
  assert.deepEqual(probeDue.slice(0, sellers.length).sort(), sellers.slice().sort(), 'seller departures lead the wave');

  const seen = [];
  const inspect = async domain => { seen.push(domain); return cleanRdap(now)(); };
  const r = await rdapSweep(db, { now, limit: 500, minIntervalMs: 0, inspectRdap: inspect });
  assert.equal(r.checked, 500);
  assert.equal(r.seller, 30);
  assert.equal(r.sellerUnchecked, 30);
  assert.deepEqual(sellers.filter(d => !seen.includes(d)), [], 'every seller departure is RDAP-checked in the first sweep');
  // The rest of the budget still serves ordinary rows.
  assert.equal(seen.filter(d => !sellers.includes(d)).length, 470);
  db.close();
});

test('seller departures are rechecked every 12 h and a transfer appearing on day 5 promotes the name to Probably sold', async () => {
  const db = open();
  const domain = 'zz-buyer.com';
  insert(db, domain, { day: '2026-11-02', cls: 'seller', priority: -90 });
  flood(db, 200, ['2026-11-02', '2026-11-03']);
  const t0 = Date.parse('2026-11-02T10:00:00.000Z');
  const transferAt = '2026-11-07T03:00:00Z';
  let checks = 0;
  const inspect = nowIso => async d => {
    if (d === domain) checks += 1;
    const landed = d === domain && Date.parse(nowIso) >= Date.parse(transferAt);
    return { checkedAt: nowIso, registrar: landed ? 'Buyer Registrar' : 'Seller Registrar', registrarId: landed ? '2' : '1', transferAt: landed ? transferAt : null, pendingTransfer: false, statuses: [], events: [] };
  };
  const sweep = ms => rdapSweep(db, { now: new Date(ms).toISOString(), limit: 50, minIntervalMs: 0, inspectRdap: inspect(new Date(ms).toISOString()) });

  await sweep(t0);
  assert.equal(checks, 1);
  // First probe ran; the ladder schedules the next one days out.
  db.prepare("UPDATE sale_watch_candidates SET probe_count = 1, next_probe_at = '2026-11-20T00:00:00.000Z', probe_priority = 3 WHERE domain = ?").run(domain);
  const early = await sweep(t0 + 6 * 3600000);
  assert.equal(early.sellerRechecked, 0, 'not due before 12 h');
  assert.equal(checks, 1);
  for (let h = 12; h < 5 * 24; h += 12) await sweep(t0 + h * 3600000);
  assert.equal(checks, 1 + 9, 'rechecked every 12 h through day 4');
  let row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get(domain);
  assert.equal(row.next_probe_at, '2026-11-20T00:00:00.000Z', 'no promotion without transfer evidence');

  const day5 = t0 + 5 * 24 * 3600000;
  const r = await sweep(day5);
  assert.equal(r.transfers, 1);
  row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get(domain);
  assert.equal(row.probe_priority, 1, 'promoted for an immediate probe');
  assert.equal(row.next_probe_at, new Date(day5).toISOString());
  const due = recon.selectDueCandidates(db, { now: new Date(day5).toISOString(), limit: 20 }).map(x => x.domain);
  assert.equal(due[0], domain, 'the promoted seller departure leads the next probe wave');

  store.assessDomains(db, [domain], { now: new Date(day5) });
  const a = db.prepare('SELECT classification, tier, views FROM sale_watch_assessments WHERE domain = ?').get(domain);
  assert.equal(a.classification, 'likely-sale', JSON.stringify(a));
  assert.ok(db.prepare("SELECT 1 FROM sale_watch_assessment_views WHERE view = 'probable' AND domain = ?").get(domain), 'on the Probably sold view');
  db.close();
});

test('freshness seller-backlog check reads the seller index and goes degraded past 2 h and stale past 6 h', () => {
  const db = open();
  insert(db, 'zz-waiting.com', { day: '2026-11-07', cls: 'seller', priority: -90 });
  insert(db, 'a-parking.com', { day: '2026-11-01', cls: 'parking' });
  db.prepare('INSERT OR REPLACE INTO sale_watch_movement_imports VALUES(?,?,?,?,?,?)').run('2026-11-07', 'sig', '2026-11-07T08:00:00.000Z', 1, 1, '{}');
  const status = nowIso => {
    const sb = fresh.readSellerBacklog(db, Date.parse(nowIso));
    return fresh.evaluateFreshness({ now: nowIso, sellerBacklog: sb }, { now: nowIso }).checks.find(c => c.name === 'seller-backlog');
  };
  const plans = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ${keys.TABLE} k INDEXED BY idx_${keys.TABLE}_seller WHERE ${keys.keySellerSql('k')} AND k.exit_observed_day >= '2026-10-24'`).all().map(r => r.detail);
  assert.ok(plans.some(d => d.includes(`idx_${keys.TABLE}_seller`)), plans.join(' | '));
  assert.equal(fresh.readSellerBacklog(db, Date.parse('2026-11-07T09:00:00Z')).unchecked, 1, 'parking departures are not counted');
  assert.equal(status('2026-11-07T10:00:00.000Z').status, 'ok', 'exactly 2 h');
  assert.equal(status('2026-11-07T10:00:01.000Z').status, 'degraded');
  assert.equal(status('2026-11-07T14:00:00.000Z').status, 'degraded', 'exactly 6 h');
  assert.equal(status('2026-11-07T14:00:01.000Z').status, 'stale');
  assert.equal(fresh.evaluateFreshness({ now: '2026-11-07T14:00:01.000Z', sellerBacklog: fresh.readSellerBacklog(db, Date.parse('2026-11-07T14:00:01.000Z')) }).verdict, 'stale', 'a clean wave cannot hide it');
  // RDAP-checked and probed: no longer a backlog.
  db.prepare("UPDATE sale_watch_candidates SET probe_count = 1, evidence_json = json_set(evidence_json, '$.discovery.rdapCheckedAt', '2026-11-07T14:10:00.000Z') WHERE domain = 'zz-waiting.com'").run();
  assert.equal(status('2026-11-07T14:20:00.000Z').status, 'ok');
  db.close();
});
