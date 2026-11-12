'use strict';

// 2026-11-12: under a container memory limit the GoDaddy inventory refresh was
// killed by the kernel on every attempt (its heap ceiling sat above the limit),
// retried every five minutes, overlapped the Sale Watch discovery scan at
// boot, and twice took the container with it. The freshness contract's count
// of unchecked seller departures took 30 s on the cold cache that followed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

const { _test: gd } = require('../scrapers/godaddy');
const gate = require('../server/heavy-job-gate');
const recon = require('../server/sale-watch-reconstruction');
const keys = require('../server/sale-watch-candidate-keys');
const fresh = require('../server/sale-watch-freshness');
const { startSaleWatchDiscoveryScheduler } = require('../server/sale-watch-scheduler');

const CSV = [
  'Domain Name,ItemID,Auction Type,Time Left,Price,Bids,Domain Age,Note',
  'EXAMPLE.COM,1,Bid,08/11/2026 09:00 AM (PDT),$125,7,18,"plain"',
  'QUOTED.COM,2,Bid,08/11/2026 09:00 AM (PDT),"$1,250",0,3,"says ""hello"", twice"',
  'MULTI.COM,3,BuyNow,08/11/2026 09:00 AM (PDT),$11,0,1,"line one\r\nline two"',
  '',
  'ÜMLAUT.NET,4,Bid,08/11/2026 09:00 AM (PDT),$5,1,2,"é—ü"',
].join('\r\n');

function whole(text) {
  const rows = [];
  const parser = gd.createCsvRecordParser(gd.csvItemSink(item => rows.push(item)));
  parser.write(text);
  parser.end();
  return rows;
}

test('the incremental CSV parser yields the same items as the whole-file parser at every split point', () => {
  const expected = gd.parseCsvPayload('x.csv', Buffer.from(CSV)).data;
  assert.equal(expected.length, 4);
  assert.equal(expected[1].note, 'says "hello", twice');
  assert.equal(expected[2].note, 'line one\r\nline two');
  assert.deepEqual(whole(CSV), expected);
  for (let cut = 0; cut <= CSV.length; cut += 1) {
    const rows = [];
    const parser = gd.createCsvRecordParser(gd.csvItemSink(item => rows.push(item)));
    parser.write(CSV.slice(0, cut));
    parser.write(CSV.slice(cut));
    parser.end();
    assert.deepEqual(rows, expected, `split at ${cut}`);
  }
  // One character at a time, and a file that ends inside a closing quote.
  const rows = [];
  const parser = gd.createCsvRecordParser(gd.csvItemSink(item => rows.push(item)));
  for (const ch of `${CSV}\r\nLAST.COM,5,Bid,,$1,0,0,"end"`) parser.write(ch);
  parser.end();
  assert.equal(rows.length, 5);
  assert.equal(rows[4].note, 'end');
});

test('a zipped CSV is inflated in pieces (multi-byte characters intact) for deflated and stored entries', async () => {
  const big = `${CSV}\r\n${Array.from({ length: 20000 }, (_, i) => `n${i}é.com,${i},Bid,,$1,0,0,"ü${i}"`).join('\r\n')}`;
  for (const stored of [false, true]) {
    const zip = new AdmZip();
    zip.addFile('inventory.csv', Buffer.from(big));
    if (stored) zip.getEntries()[0].header.method = 0;
    let text = '';
    let pieces = 0;
    const name = await gd.inflateFirstZipEntry('inventory.csv.zip', zip.toBuffer(), (piece) => { text += piece; pieces += 1; });
    assert.equal(name, 'inventory.csv');
    assert.equal(text, big, stored ? 'stored' : 'deflated');
    assert.ok(pieces >= 2);
  }
  await assert.rejects(async () => gd.inflateFirstZipEntry('empty.zip', new AdmZip().toBuffer(), () => {}), /No entries/);
});

test('one heavy job at a time; a lost release cannot hold the gate forever', () => {
  let t = 0;
  const g = gate.createHeavyJobGate({ now: () => t, maxHoldMs: 1000 });
  const release = g.acquire('a');
  assert.equal(typeof release, 'function');
  assert.equal(g.acquire('b'), null);
  assert.equal(g.current().name, 'a');
  release();
  const second = g.acquire('b');
  assert.ok(second);
  release(); // a stale release from the first holder changes nothing
  assert.equal(g.current().name, 'b');
  t = 1001;
  assert.equal(g.current(), null, 'a holder past the bound is treated as gone');
  assert.ok(g.acquire('c'));
});

test('the child heap ceiling is half the container limit inside its bounds; backoff doubles to an hour', () => {
  const GB = 1024 ** 3;
  assert.equal(gate.childHeapCeilingMb({ limitBytes: 8_000_000_000 }), 3814);
  assert.equal(gate.childHeapCeilingMb({ limitBytes: 5_999_996_928 }), 3072, 'the measured floor');
  assert.equal(gate.childHeapCeilingMb({ limitBytes: 2 * GB }), 3072, 'floor');
  assert.equal(gate.childHeapCeilingMb({ limitBytes: 64 * GB }), 8192, 'cap');
  assert.equal(gate.childHeapCeilingMb({ limitBytes: null }), 8192, 'no container limit');
  assert.equal(gate.childHeapCeilingMb({ explicit: '5000', limitBytes: 8_000_000_000 }), 5000, 'an explicit setting wins');
  assert.equal(gate.containerMemoryLimitBytes(() => '5999996928\n'), 5999996928);
  assert.equal(gate.containerMemoryLimitBytes(() => 'max\n'), null);
  assert.equal(gate.containerMemoryLimitBytes(() => '9223372036854771712\n'), null, 'cgroup v1 unlimited');
  assert.equal(gate.containerMemoryLimitBytes(() => { throw new Error('ENOENT'); }), null);
  const min = 60_000;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(n => gate.failureBackoffMs(n) / min), [0, 5, 10, 20, 40, 60, 60]);
});

test('the Sale Watch discovery scan waits for the gate and retries, and releases it when its child exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-gate-'));
  const out = path.join(dir, 'discovery.json');
  fs.writeFileSync(out, '{}');
  const g = gate.createHeavyJobGate();
  const held = g.acquire('godaddy-inventory-refresh');
  const published = [];
  const scheduler = startSaleWatchDiscoveryScheduler({
    env: { ...process.env, DOMAINSCOUT_SALE_WATCH_DISCOVERY_ENABLED: '1', DOMAINSCOUT_SALE_WATCH_DISCOVERY_PATH: out, DOMAINSCOUT_SALE_WATCH_DISCOVERY_INITIAL_DELAY_MS: '3600000' },
    gate: g, gateRetryMs: 1000, onPublished: e => published.push(e),
  });
  try {
    assert.equal(scheduler.run('test'), false, 'held: the scan does not start');
    assert.equal(g.current().name, 'godaddy-inventory-refresh');
    held();
    const deadline = Date.now() + 15000;
    while (!(g.current() && g.current().name === 'sale-watch-discovery-scan') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(g.current() && g.current().name, 'sale-watch-discovery-scan', 'the retry took the gate');
    scheduler.stop(); // SIGTERM to the child; its exit releases the gate
    while (g.current() && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(g.current(), null);
  } finally {
    scheduler.stop();
  }
});

test('the unchecked-seller count reads the partial index once the indexer worker has built it, with the same answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-unchecked-'));
  const db = new Database(path.join(dir, 'sale_watch.db'));
  recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  const insert = db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, probe_priority, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, ?, -90, ?, ?)`);
  const day = '2026-11-10';
  for (let i = 0; i < 40; i += 1) {
    const checked = i % 4 !== 0; // 10 unchecked
    const evidence = { domain: `s${i}.com`, discovery: { departureDate: day, ...(checked ? { rdapCheckedAt: `${day}T10:00:00.000Z` } : {}),
      movement: { day, previousClass: 'seller', currentClass: 'hosting', previousNameservers: ['ns1.afternic.com'], currentNameservers: ['ns1.digitalocean.com'] } } };
    insert.run(`s${i}.com`, day, day, day, `${day}T00:00:00.000Z`, checked ? 1 : 0, JSON.stringify(evidence), `${day}T00:00:00Z`);
  }
  const nowMs = Date.parse('2026-11-12T12:00:00Z');
  const before = fresh.readSellerBacklog(db, nowMs);
  assert.equal(before.unchecked, 10);
  assert.equal(keys.sellerUncheckedIndexReady(db), false);
  assert.equal(keys.ensureSellerUncheckedIndex(db), true);
  assert.equal(keys.ensureSellerUncheckedIndex(db), false, 'a no-op once built');
  assert.deepEqual(fresh.readSellerBacklog(db, nowMs), before);
  const T = keys.TABLE;
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ${T} k INDEXED BY ${keys.SELLER_UNCHECKED_INDEX} WHERE ${keys.keySellerUncheckedSql('k')} AND k.exit_observed_day >= '2026-10-29'`).all().map(r => r.detail).join(' | ');
  assert.match(plan, new RegExp(`USING INDEX ${keys.SELLER_UNCHECKED_INDEX} `), plan);
  // The index follows the rows: a check removes one, a new departure adds one.
  db.prepare("UPDATE sale_watch_candidates SET probe_count = 1, evidence_json = json_set(evidence_json, '$.discovery.rdapCheckedAt', '2026-11-12T11:00:00.000Z') WHERE domain = 's0.com'").run();
  assert.equal(fresh.readSellerBacklog(db, nowMs).unchecked, 9);
  db.close();
});

// 2026-11-12: the search stage issued a DELETE per id range to purge orphaned
// documents even when there were none: ~1,100 back-to-back write locks that
// starved the probe wave's writes for 50-73 s on a cold cache.
test('the search stage takes no write lock when there is nothing to purge or index, and still purges an orphan', async () => {
  const search = require('../server/sale-watch-search');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-purge-'));
  const file = path.join(dir, 'sale_watch.db');
  const db = new Database(file);
  recon.configureSaleWatchDb(db);
  recon.ensureReconstructionSchema(db);
  const insert = db.prepare(`INSERT INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, '2026-11-10', '2026-11-10', 'zone-seller-departure', '2026-11-10', 'exited', '2026-11-10T00:00:00.000Z', 0, ?, '2026-11-10T00:00:00Z')`);
  for (let i = 0; i < 30; i += 1) {
    insert.run(`p${i}.com`, JSON.stringify({ domain: `p${i}.com`, discovery: { departureDate: '2026-11-10', movement: { day: '2026-11-10', previousClass: 'seller', currentClass: 'hosting' } } }));
  }
  const opts = { now: new Date('2026-11-12T00:00:00Z'), destinationDays: false, chunk: 7 };
  assert.equal((await search.ensureSearchIndex(db, opts)).indexed, 30);

  const holder = new Database(file);
  holder.prepare('BEGIN IMMEDIATE').run();
  db.pragma('busy_timeout = 0');
  const held = await search.ensureSearchIndex(db, opts); // would throw "database is locked" on any write
  assert.deepEqual([held.purged, held.indexed], [0, 0]);
  holder.prepare('COMMIT').run();
  holder.close();

  db.pragma('busy_timeout = 30000');
  const docs = () => db.prepare("SELECT COUNT(*) AS n FROM sale_watch_search_docs WHERE domain = 'p3.com'").get().n;
  db.exec('DROP TRIGGER IF EXISTS sale_watch_search_docs_candidate_ad');
  db.prepare("DELETE FROM sale_watch_candidates WHERE domain = 'p3.com'").run();
  const before = docs();
  const after = await search.ensureSearchIndex(db, opts);
  assert.equal(after.purged, before, 'every orphaned document is purged');
  assert.equal(docs(), 0);
  db.close();
});
