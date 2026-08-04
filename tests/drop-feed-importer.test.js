'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-drop-feed-'));
  const bootstrap = new Database(path.join(dataDir, 'domains.db'));
  bootstrap.exec(`
    CREATE TABLE domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL, base_name TEXT, tld TEXT NOT NULL, stream TEXT NOT NULL,
      source TEXT, status TEXT DEFAULT 'active', auction_end TEXT, auction_price REAL,
      auction_url TEXT, age_years INTEGER, wayback_snapshots INTEGER, wayback_first TEXT,
      wayback_last TEXT, dns_available INTEGER, registration_available INTEGER,
      first_available_at TEXT, availability_checked_at TEXT, availability_source TEXT,
      availability_error TEXT, registry_expiry TEXT, quality_score INTEGER DEFAULT 0,
      quality_reasons TEXT, length INTEGER, has_numbers INTEGER DEFAULT 0,
      has_hyphens INTEGER DEFAULT 0, drop_date TEXT, expiry_date TEXT, whois_checked TEXT,
      discovered_at TEXT DEFAULT (datetime('now')), tlds_taken INTEGER DEFAULT 0,
      tlds_checked_at TEXT, bid_count INTEGER DEFAULT 0, seen INTEGER DEFAULT 0,
      saved INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, notes TEXT,
      UNIQUE(domain, stream)
    );
  `);
  bootstrap.close();
  process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;

  const db = require('../server/db');
  const { coverageDates, getExpiredUniverseCoverage, recordDropAvailability } = require('../server/drop-universe');
  const { projectConfirmedDrops } = require('../server/expired-availability');
  const {
    buildWhoisFreaksUrl,
    coverageCompleteForDay,
    fetchWhoisFreaksStatus,
    parseDroppedPayload,
    syncWhoisFreaksDroppedDay,
  } = require('../server/dropped-feed-importer');

  const emptyCoverage = getExpiredUniverseCoverage({
    days: 14,
    now: new Date('2026-08-04T14:00:00.000Z'),
  });
  assert.strictEqual(emptyCoverage.complete, false);
  assert.strictEqual(emptyCoverage.windowStart, '2026-07-22');
  assert.strictEqual(emptyCoverage.windowEnd, '2026-08-04');

  assert.deepStrictEqual(parseDroppedPayload('domain\nalpha.ai\nalpha.ai\nomega.shop\n'), ['alpha.ai', 'omega.shop']);
  assert.deepStrictEqual(parseDroppedPayload(JSON.stringify({ data: [{ domain_name: 'Beta.AI' }] })), ['beta.ai']);
  const built = buildWhoisFreaksUrl({ apiKey: 'secret', date: '2026-08-04', tlds: ['.ai', '.shop'] });
  assert.strictEqual(built.origin, 'https://files.whoisfreaks.com');
  assert.strictEqual(built.searchParams.get('tlds'), 'ai,shop');

  const providerStatus = await fetchWhoisFreaksStatus({
    fetchImpl: async url => {
      assert.strictEqual(String(url), 'https://files.whoisfreaks.com/v3.4/status');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ dropped: { last_update: '2026-08-04', available_from: '2026-05-02' } }),
      };
    },
  });
  assert.strictEqual(providerStatus.lastUpdate, '2026-08-04');

  const date = coverageDates(1)[0];
  const fakeFetch = async url => {
    assert.strictEqual(url.searchParams.get('date'), date);
    return { ok: true, status: 200, text: async () => JSON.stringify(['alpha.ai', 'beta.ai', 'omega.shop']) };
  };
  const availabilityVerifier = async ({ domains }) => {
    const checkedAt = new Date().toISOString();
    const results = domains.map(domain => ({
      domain,
      dns_available: domain === 'beta.ai' ? 0 : 1,
      registration_available: domain === 'beta.ai' ? 0 : 1,
      availability_checked_at: checkedAt,
      availability_source: 'fixture-registrar',
      registry_expiry: null,
    }));
    for (const result of results) {
      recordDropAvailability({
        domain: result.domain,
        registrationAvailable: result.registration_available,
        availabilitySource: result.availability_source,
        availabilityCheckedAt: result.availability_checked_at,
      });
    }
    projectConfirmedDrops(results);
    return { checked: results.length, available: 2, unavailable: 1, unknown: 0 };
  };

  const summary = await syncWhoisFreaksDroppedDay({
    apiKey: 'fixture', date, tlds: ['.ai', '.shop'], fetchImpl: fakeFetch, availabilityVerifier,
  });
  assert.strictEqual(summary.ingested, 3);
  assert.deepStrictEqual(summary.receipts.map(row => [row.tld, row.status, row.observed, row.available, row.unavailable]), [
    ['.ai', 'complete', 2, 1, 1],
    ['.shop', 'complete', 1, 1, 0],
  ]);
  assert.strictEqual(getExpiredUniverseCoverage({ days: 1, tlds: ['.ai', '.shop'] }).complete, true);
  assert.strictEqual(coverageCompleteForDay({ date, tlds: ['.ai', '.shop'] }), true);
  assert.deepStrictEqual(
    db.prepare("SELECT domain FROM domains WHERE stream = 'just-dropped' AND registration_available = 1 ORDER BY domain").all(),
    [{ domain: 'alpha.ai' }, { domain: 'omega.shop' }]
  );
  assert.strictEqual(
    db.prepare("SELECT SUBSTR(source_event_at,1,10) AS date FROM drop_events WHERE domain = 'alpha.ai'").get().date,
    date,
    'the provider drop day must remain distinct from the later availability-check timestamp'
  );

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('drop-feed-importer.test.js: all assertions passed');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
