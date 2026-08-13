/**
 * Scrape runner — all primary sources, no expireddomains.net dependency
 *
 * Sources:
 *   - CZDS zone file diff → just-dropped (.com/.net/.org)
 *   - crt.sh CT logs     → just-dropped (.io/.ai/.sh/.bot)
 *   - Auctions           → NameJet, Dynadot, Pool, DropCatch, GoDaddy
 *   - Marketplaces       → Sedo, Dan.com, Afternic
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const db = require('./db');
const { runCZDS }        = require('../scrapers/czds');
const { runCRTSH }       = require('../scrapers/crtsh');
const { runAuctions }    = require('../scrapers/auctions');
const { scrapeNamecheap }= require('../scrapers/namecheap');
const { scrapeGoDaddy }  = require('../scrapers/godaddy');
const { runMarketplaces }= require('../scrapers/marketplaces');
const { runWhoisExpiry } = require('../scrapers/whois-expiry');
const { enrichDomains, checkTldsTaken } = require('../enrichment');
const { indexAllPendingZoneFiles }      = require('./zone-indexer');
const { purgeEndedAuctions }            = require('./auction-cleanup');
const {
  recordGoDaddyRefreshEvent,
  validateGoDaddyInventorySnapshot,
  writeGoDaddyInventoryCache,
} = require('./godaddy-cache');
require('./provider-snapshot-registry');
const {
  publishLargeProviderSnapshot,
  recordLargeProviderRefreshEvent,
  validateLargeProviderSnapshot,
} = require('./large-provider-snapshot');
const { getSupportedTldUniverse }        = require('./tld-universe');
const { refreshExpiredAvailability }     = require('./expired-availability');
const { importCzdsDropCandidates }       = require('./czds-drop-importer');
const { startRefreshLeaseHeartbeat }     = require('./refresh-lease');

// Each coordinator-owned refresh child maintains its own liveness receipt. The
// parent can safely reap a process whose event loop has stopped advancing rather
// than treating an alive-but-wedged PID as permanent ownership of the lane.
const stopRefreshLeaseHeartbeat = startRefreshLeaseHeartbeat(process.env);
process.once('exit', stopRefreshLeaseHeartbeat);

const insert = db.prepare(`
  INSERT OR IGNORE INTO domains
    (domain, base_name, tld, stream, source, auction_price, auction_end, auction_url,
     length, has_numbers, has_hyphens, drop_date, expiry_date,
     tlds_taken, tlds_checked_at, bid_count, age_years)
  VALUES
    (@domain, @base_name, @tld, @stream, @source, @auction_price, @auction_end, @auction_url,
     @length, @has_numbers, @has_hyphens, @drop_date,
     @expiry_date,
     @tlds_taken, @tlds_checked_at, @bid_count, @age_years)
`);

// For non-GoDaddy auction re-scrapes: update mutable fields
const updateAuction = db.prepare(`
  UPDATE domains SET auction_price = @auction_price, bid_count = @bid_count,
    auction_end = @auction_end, stream = @stream
  WHERE domain = @domain AND stream = @stream
`);

// GoDaddy-specific: UPDATE across BOTH GoDaddy streams (handles reclassification auction↔closeout)
// Only used when the domain already has a GoDaddy row — prevents cross-stream duplicate rows
const gdUpdate = db.prepare(`
  UPDATE domains SET auction_price = @auction_price, bid_count = @bid_count,
    auction_end = @auction_end, stream = @stream, source = @source,
    tlds_taken = COALESCE(@tlds_taken, tlds_taken),
    tlds_checked_at = COALESCE(@tlds_checked_at, tlds_checked_at),
    age_years = COALESCE(@age_years, age_years)
  WHERE domain = @domain AND stream IN ('godaddy-auction', 'godaddy-closeout')
`);

const updateEnrichment = db.prepare(`
  UPDATE domains SET
    dns_available = COALESCE(@dns_available, dns_available),
    wayback_snapshots = @wayback_snapshots,
    wayback_first = @wayback_first,
    wayback_last = @wayback_last,
    age_years = @age_years,
    expiry_date = COALESCE(@expiry_date, expiry_date),
    registration_available = COALESCE(@registration_available, registration_available),
    first_available_at = CASE
      WHEN @registration_available = 1 THEN COALESCE(first_available_at, @availability_checked_at)
      WHEN @registration_available = 0 THEN NULL
      ELSE first_available_at
    END,
    availability_checked_at = @availability_checked_at,
    availability_source = @availability_source,
    availability_error = @availability_error
  WHERE domain = @domain
`);

const logRun = db.prepare(`
  INSERT INTO scrape_log (stream, domains_found, domains_new, error)
  VALUES (@stream, @domains_found, @domains_new, @error)
`);

function namecheapSnapshotOptions() {
  const configuredFloor = Math.max(1, Number(process.env.NAMECHEAP_MIN_ACTIVE_ROWS) || 100000);
  const previous = db.prepare(`
    SELECT domains_found
    FROM scrape_log
    WHERE stream = 'namecheap-auction' AND error IS NULL
    ORDER BY ran_at DESC LIMIT 1
  `).get();
  const priorFloor = Math.floor(Math.max(0, Number(previous?.domains_found) || 0) * 0.9);
  return { minRows: Math.max(configuredFloor, priorFloor) };
}

function purgeStreamMissingFromSnapshot(streamName, domains) {
  if (!streamName || !Array.isArray(domains) || domains.length === 0) return 0;
  const uniqueDomains = [...new Set(domains.map(d => d?.domain).filter(Boolean))];
  if (uniqueDomains.length === 0) return 0;

  const run = db.transaction((items) => {
    db.exec('DROP TABLE IF EXISTS temp.current_stream_snapshot');
    db.exec('CREATE TEMP TABLE current_stream_snapshot (domain TEXT PRIMARY KEY)');
    const insertSnapshot = db.prepare('INSERT OR IGNORE INTO current_stream_snapshot (domain) VALUES (?)');
    for (const domain of items) insertSnapshot.run(domain);
    // Keep the user's saved/skipped marker, but immediately remove missing lots
    // from every active-auction projection.
    db.prepare(`
      UPDATE domains
      SET auction_end = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE stream = ?
        AND domain NOT IN (SELECT domain FROM current_stream_snapshot)
        AND (saved <> 0 OR skipped <> 0)
    `).run(streamName);
    const purged = db.prepare(`
      DELETE FROM domains
      WHERE stream = ?
        AND domain NOT IN (SELECT domain FROM current_stream_snapshot)
        AND saved = 0 AND skipped = 0
    `).run(streamName).changes;
    db.exec('DROP TABLE IF EXISTS temp.current_stream_snapshot');
    return purged;
  });

  return run(uniqueDomains);
}

function baseNameFromDomain(domain) {
  const d = String(domain || '').toLowerCase();
  const dot = d.lastIndexOf('.');
  return dot > 0 ? d.slice(0, dot) : d;
}

function hydrateTldCountsFromVerifiedCache(domains) {
  if (!Array.isArray(domains) || domains.length === 0) return domains;

  const bases = [...new Set(domains.map(d => d.base_name || baseNameFromDomain(d.domain)).filter(Boolean))];
  if (bases.length === 0) return domains;

  const counts = new Map();
  const universe = getSupportedTldUniverse();
  for (let i = 0; i < bases.length; i += 900) {
    const batch = bases.slice(i, i + 900);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT base_name, count, checked_at
      FROM tld_check_cache
      WHERE all_count = ?
        AND source = ?
        AND base_name IN (${placeholders})
    `).all(universe.count, universe.source, ...batch);
    for (const row of rows) counts.set(row.base_name, row);
  }

  for (const d of domains) {
    const baseName = d.base_name || baseNameFromDomain(d.domain);
    const row = counts.get(baseName);
    if (!row) continue;
    d.tlds_taken = Number(row.count || 0);
    d.tlds_checked_at = row.checked_at || null;
  }

  return domains;
}

function insertDomains(domains, { updateExisting = false, gdUpsert = false, batchSize = 10000 } = {}) {
  let newCount = 0;
  const run = db.transaction((items) => {
    let batchNewCount = 0;
    for (const d of items) {
      if (!d || !d.domain || !d.tld) continue;

      if (gdUpsert) {
        // GoDaddy upsert: UPDATE across both GoDaddy streams first (corrects stream misclassification
        // without creating duplicate rows). Only INSERT if no GoDaddy row exists at all.
        const r = gdUpdate.run({
          domain: d.domain,
          stream: d.stream,
          source: d.source || null,
          auction_price: d.auction_price || null,
          bid_count: d.bid_count || 0,
          auction_end: d.auction_end || null,
          tlds_taken: d.tlds_taken != null ? d.tlds_taken : null,
          tlds_checked_at: d.tlds_checked_at || null,
          age_years: d.age_years != null ? d.age_years : null,
        });
        if (r.changes === 0) {
          // Brand new domain — insert fresh
          const r2 = insert.run({
            domain: d.domain,
            base_name: d.base_name || baseNameFromDomain(d.domain),
            tld: d.tld,
            stream: d.stream,
            source: d.source || null,
            auction_price: d.auction_price || null,
            auction_end: d.auction_end || null,
            auction_url: d.auction_url || null,
            length: d.length || d.domain.length,
            has_numbers: d.has_numbers || 0,
            has_hyphens: d.has_hyphens || 0,
            drop_date: null,
            expiry_date: null,
            tlds_taken: d.tlds_taken != null ? d.tlds_taken : null,
            tlds_checked_at: d.tlds_checked_at || null,
            bid_count: d.bid_count || 0,
            age_years: d.age_years != null ? d.age_years : null,
          });
          if (r2.changes > 0) batchNewCount++;
        }
        continue;
      }

      const info = insert.run({
        domain: d.domain,
        base_name: d.base_name || baseNameFromDomain(d.domain),
        tld: d.tld,
        stream: d.stream,
        source: d.source || null,
        auction_price: d.auction_price || null,
        auction_end: d.auction_end || null,
        auction_url: d.auction_url || null,
        length: d.length || d.domain.length,
        has_numbers: d.has_numbers || 0,
        has_hyphens: d.has_hyphens || 0,
        drop_date: d.drop_date || null,
        expiry_date: d.expiry_date || null,
        tlds_taken: d.tlds_taken != null ? d.tlds_taken : null,
        tlds_checked_at: d.tlds_checked_at || null,
        bid_count: d.bid_count || 0,
        age_years: d.age_years != null ? d.age_years : null,
      });
      if (info.changes > 0) {
        batchNewCount++;
      } else if (updateExisting && d.auction_end) {
        updateAuction.run({
          domain: d.domain,
          stream: d.stream,
          auction_price: d.auction_price || null,
          bid_count: d.bid_count || 0,
          auction_end: d.auction_end,
        });
      }
    }
    return batchNewCount;
  });
  for (let i = 0; i < domains.length; i += batchSize) {
    newCount += run(domains.slice(i, i + batchSize));
  }
  return newCount;
}

async function updateTldsTaken() {
  // Priority: short names (≤10 chars) with history first, then anything unchecked
  // 300 per run — 30 batches of 10 parallel DNS checks
  const toCheck = db.prepare(`
    SELECT DISTINCT SUBSTR(domain, 1, INSTR(domain, '.') - 1) AS base_name
    FROM domains
    WHERE tlds_checked_at IS NULL
    ORDER BY
      CASE WHEN length <= 10 AND (age_years > 0 OR wayback_snapshots > 0) THEN 0 ELSE 1 END ASC,
      length ASC,
      discovered_at DESC
    LIMIT 300
  `).all().map(r => r.base_name);

  if (toCheck.length === 0) {
    console.log('  tlds_taken: all base names up to date');
    return;
  }

  console.log(`  tlds_taken: DNS-checking ${toCheck.length} base names across ~160 TLDs...`);

  const update = db.prepare(`
    UPDATE domains SET tlds_taken = ?, tlds_checked_at = datetime('now')
    WHERE SUBSTR(domain, 1, INSTR(domain, '.') - 1) = ?
  `);
  const updateBaseCount = db.prepare(`
    INSERT INTO base_tld_counts (base_name, tld_count, source, updated_at)
    VALUES (?, ?, 'legacy-dns', datetime('now'))
    ON CONFLICT(base_name) DO UPDATE SET
      tld_count = MAX(base_tld_counts.tld_count, excluded.tld_count),
      source = CASE
        WHEN excluded.tld_count >= base_tld_counts.tld_count THEN excluded.source
        ELSE base_tld_counts.source
      END,
      updated_at = excluded.updated_at
  `);

  // 10 base names in parallel — each spawns ~160 DNS NS lookups internally
  for (let i = 0; i < toCheck.length; i += 10) {
    const batch = toCheck.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (baseName) => ({ baseName, count: await checkTldsTaken(baseName) }))
    );
    db.transaction(() => {
      for (const { baseName, count } of results) {
        update.run(count, baseName);
        updateBaseCount.run(baseName, count);
      }
    })();
    if (i + 10 < toCheck.length) await new Promise(r => setTimeout(r, 200));
  }

  console.log(`  tlds_taken: checked ${toCheck.length} base names`);
}

async function enrichStream(streamName, limit = 50) {
  const toEnrich = db.prepare(`
    SELECT domain FROM domains
    WHERE stream = ?
      AND (registration_available IS NULL OR availability_checked_at IS NULL)
    ORDER BY discovered_at DESC LIMIT ?
  `).all(streamName, limit).map(r => r.domain);

  if (toEnrich.length === 0) return;

  console.log(`  Enriching ${toEnrich.length} new ${streamName} domains...`);
  const enriched = await enrichDomains(toEnrich, { concurrency: 4, delayMs: 300 });

  db.transaction((items) => {
    for (const e of items) updateEnrichment.run({
      domain: e.domain,
      dns_available: e.dns_available,
      registration_available: e.registration_available,
      availability_checked_at: e.availability_checked_at || null,
      availability_source: e.availability_source || null,
      availability_error: e.availability_error || null,
      wayback_snapshots: e.wayback_snapshots,
      wayback_first: e.wayback_first,
      wayback_last: e.wayback_last,
      age_years: e.age_years,
      expiry_date: e.expiry_date || null,
    });
  })(enriched);
}

function insertStreamSnapshots(streamData, summary) {
  const auctionStreams = new Set(['namecheap-auction', 'marketplace', 'godaddy-premium']);
  const gdStreams = new Set(['godaddy-auction', 'godaddy-closeout']);

  for (const { name, domains } of streamData) {
    const publish = () => {
      const newCount = insertDomains(domains, {
        updateExisting: auctionStreams.has(name),
        gdUpsert: gdStreams.has(name),
      });
      let purgedMissing = 0;
      if ((gdStreams.has(name) || name === 'namecheap-auction') && domains.length > 0) {
        purgedMissing = purgeStreamMissingFromSnapshot(name, domains);
      }
      logRun.run({ stream: name, domains_found: domains.length, domains_new: newCount, error: null });
      return { newCount, purgedMissing };
    };
    // A complete Namecheap cursor chain becomes visible in one SQLite commit.
    // Readers continue seeing the previous validated snapshot while the import runs.
    const { newCount, purgedMissing } = name === 'namecheap-auction'
      ? db.transaction(publish)()
      : publish();
    console.log(`  ${name}: ${domains.length} found, ${newCount} new${purgedMissing ? `, ${purgedMissing} stale purged` : ''}`);
    summary[name] = { found: domains.length, new: newCount, purgedMissing };
  }
}

async function refreshGoDaddyInventory(summary = {}, options = {}) {
  const importDb = options.importDb !== false;
  const startedAt = new Date().toISOString();
  for (const stream of ['godaddy-auction', 'godaddy-closeout']) {
    recordGoDaddyRefreshEvent(stream, {
      status: 'running',
      reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'unspecified',
      startedAt,
    });
  }
  try {
    console.log('[GoDaddy] Refreshing bulk inventory...');
    const godaddyDomains = await scrapeGoDaddy();
    const snapshotEvidence = godaddyDomains.snapshotEvidence || {};
    if (importDb) hydrateTldCountsFromVerifiedCache(godaddyDomains);
    const godaddyAuctions = godaddyDomains.filter(d => d.stream === 'godaddy-auction');
    const godaddyCloseouts = godaddyDomains.filter(d => d.stream === 'godaddy-closeout');
    const auctionValidation = validateGoDaddyInventorySnapshot('godaddy-auction', godaddyAuctions);
    const closeoutValidation = validateGoDaddyInventorySnapshot('godaddy-closeout', godaddyCloseouts);
    if (!auctionValidation.ok || !closeoutValidation.ok) {
      throw new Error(`GoDaddy snapshot validation failed: ${[
        ...auctionValidation.errors.map(error => `auction ${error}`),
        ...closeoutValidation.errors.map(error => `closeout ${error}`),
      ].join('; ')}`);
    }
    const generatedAt = new Date().toISOString();
    writeGoDaddyInventoryCache('godaddy-auction', godaddyAuctions, {
      generatedAt,
      evidence: snapshotEvidence.auction || null,
      validation: auctionValidation,
    });
    writeGoDaddyInventoryCache('godaddy-closeout', godaddyCloseouts, {
      generatedAt,
      evidence: snapshotEvidence.closeout || null,
      validation: closeoutValidation,
    });
    for (const [stream, validation] of [
      ['godaddy-auction', auctionValidation],
      ['godaddy-closeout', closeoutValidation],
    ]) {
      recordGoDaddyRefreshEvent(stream, {
        status: 'succeeded',
        reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'unspecified',
        startedAt,
        completedAt: generatedAt,
        count: validation.count,
      });
    }
    if (importDb) {
      insertStreamSnapshots([
        { name: 'godaddy-auction', domains: godaddyAuctions },
        { name: 'godaddy-closeout', domains: godaddyCloseouts },
      ], summary);
    } else {
      logRun.run({ stream: 'godaddy-auction', domains_found: godaddyAuctions.length, domains_new: 0, error: null });
      logRun.run({ stream: 'godaddy-closeout', domains_found: godaddyCloseouts.length, domains_new: 0, error: null });
      summary['godaddy-auction'] = { found: godaddyAuctions.length, new: 0, cacheOnly: true };
      summary['godaddy-closeout'] = { found: godaddyCloseouts.length, new: 0, cacheOnly: true };
      console.log(`  GoDaddy cache-only refresh: ${godaddyAuctions.length} auctions, ${godaddyCloseouts.length} closeouts`);
    }
  } catch (err) {
    console.error('[GoDaddy] Error:', err.message);
    const completedAt = new Date().toISOString();
    for (const stream of ['godaddy-auction', 'godaddy-closeout']) {
      recordGoDaddyRefreshEvent(stream, {
        status: 'failed',
        reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'unspecified',
        startedAt,
        completedAt,
        error: String(err.message || err).slice(0, 1000),
      });
    }
    logRun.run({ stream: 'godaddy-auction', domains_found: 0, domains_new: 0, error: err.message });
    summary['godaddy-auction'] = { error: err.message };
    if (options.failOnError) throw err;
  }
  return summary;
}

async function refreshNamecheapInventory(summary = {}) {
  const stream = 'namecheap-auction';
  const startedAt = new Date().toISOString();
  recordLargeProviderRefreshEvent(stream, {
    status: 'running',
    reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'unspecified',
    startedAt,
  });
  try {
    const domains = await scrapeNamecheap(namecheapSnapshotOptions());
    const validation = validateLargeProviderSnapshot(stream, domains);
    if (!validation.ok) throw new Error(`Namecheap snapshot validation failed: ${validation.errors.join('; ')}`);
    const completedAt = new Date().toISOString();
    const manifest = publishLargeProviderSnapshot(stream, domains, {
      generatedAt: completedAt,
      evidence: domains.snapshotEvidence || null,
      validation,
    });
    recordLargeProviderRefreshEvent(stream, {
      status: 'succeeded',
      reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'unspecified',
      startedAt,
      completedAt,
      count: manifest.count,
      snapshotSha256: manifest.snapshotSha256,
    });
    // Freshness and UI publication end at the atomic pointer swap above. Shared-domain
    // enrichment/materialization is deliberately decoupled so it can run later without
    // delaying or invalidating the provider's complete current inventory.
    summary[stream] = { found: manifest.count, new: 0, compactSnapshot: true, published: true };
    console.log(`  ${stream}: ${manifest.count} current rows atomically published`);
    return summary;
  } catch (err) {
    recordLargeProviderRefreshEvent(stream, {
      status: 'failed',
      reason: process.env.DOMAINSCOUT_SCRAPE_REASON || 'unspecified',
      startedAt,
      completedAt: new Date().toISOString(),
      error: String(err.message || err).slice(0, 1000),
    });
    logRun.run({
      stream,
      domains_found: 0,
      domains_new: 0,
      error: err.message,
    });
    summary[stream] = { found: 0, new: 0, published: false, error: err.message };
    throw err;
  }
}

async function scrapeAll(options = {}) {
  const includeCZDS = options.includeCZDS === true;
  console.log('\n=== DomainScout Scrape ===', new Date().toISOString());
  const summary = {};

  // GoDaddy bulk feeds are large, high-value auction data. Insert them first so
  // the app and agents can query current auctions while slower sources continue.
  await refreshGoDaddyInventory(summary);

  // Run remaining sources in parallel where possible
  console.log(`Starting sources${includeCZDS ? ' + CZDS zone sync' : ''}...`);

  const sourceResults = await Promise.allSettled([
    includeCZDS ? runCZDS() : Promise.resolve([]),
    runCRTSH(),      // now returns "discovered" stream (ccTLD seed for RDAP polling)
    runAuctions({ includeGoDaddy: false, includeNamecheap: false }),
    runMarketplaces(),
  ]);
  const [czdsResult, ctResult, auctionResult, marketResult] = sourceResults;
  const czdsDropped = czdsResult.status === 'fulfilled' ? czdsResult.value : [];
  const ctDiscovered = ctResult.status === 'fulfilled' ? ctResult.value : [];
  const auctionDomains = auctionResult.status === 'fulfilled' ? auctionResult.value : [];
  const marketDomains = marketResult.status === 'fulfilled' ? marketResult.value : [];

  // CZDS zone-file diffs = definitive just-dropped (.com/.net/.org)
  const droppedSeen = new Set();
  const droppedUniq = czdsDropped.filter(d => {
    if (!d || droppedSeen.has(d.domain)) return false;
    droppedSeen.add(d.domain);
    return true;
  });

  // crt.sh = discovery seed for .ai/.io/.sh/.bot (feeds RDAP expiry poll)
  const discoveredSeen = new Set();
  const discoveredUniq = ctDiscovered.filter(d => {
    if (!d || discoveredSeen.has(d.domain)) return false;
    discoveredSeen.add(d.domain);
    return true;
  });

  // Separate auctions by stream
  const pendingDomains    = auctionDomains.filter(d => d.stream === 'pending-delete');
  const premiumDomains    = auctionDomains.filter(d => d.stream === 'godaddy-premium');
  const marketplaceFromAuctions = auctionDomains.filter(d => d.stream === 'marketplace');
  const allMarket = [...marketDomains, ...marketplaceFromAuctions];

  // Insert all streams
  const streamData = [
    { name: 'just-dropped',      domains: droppedUniq },
    { name: 'discovered',        domains: discoveredUniq },
    { name: 'pending-delete',    domains: pendingDomains },
    { name: 'godaddy-premium',   domains: premiumDomains },
    { name: 'marketplace',       domains: allMarket },
  ];

  // Phase 1: insert all streams immediately (no blocking network calls)
  insertStreamSnapshots(streamData, summary);
  if (includeCZDS) {
    try {
      const importedDrops = importCzdsDropCandidates();
      summary['czds-drop-import'] = importedDrops;
      if (importedDrops.imported > 0) {
        console.log(`  CZDS drop import: ${importedDrops.imported.toLocaleString()} just-dropped candidates`);
      }
    } catch (err) {
      summary['czds-drop-import'] = { error: err.message };
      console.error('[CZDS Drop Import] Error:', err.message);
    }
  }

  const purgedEndedAuctions = purgeEndedAuctions(db);
  if (purgedEndedAuctions > 0) {
    console.log(`  ended auctions: purged ${purgedEndedAuctions.toLocaleString()} rows`);
  }
  summary['ended-auctions'] = { purged: purgedEndedAuctions };

  // Accurate TLD totals are maintained by server/tlds-worker.js. The legacy
  // per-scrape DNS refresher is opt-in so it cannot repopulate stale sortable
  // counts without a full tld_check_cache row.
  if (process.env.DOMAINSCOUT_LEGACY_TLD_REFRESH === '1') {
    await updateTldsTaken();
  } else {
    console.log('  tlds_taken: accurate backfill handled by TLD accuracy worker');
  }

  // Phase 2: enrich new domains (DNS/Wayback) — after all inserts so nothing blocks
  for (const { name } of streamData) {
    await enrichStream(name, 20);
  }

  // WHOIS expiry pass — seeds from Tranco, polls unpolled .io/.ai/.sh/.bot for expiry dates
  console.log('[WHOIS] Running expiry poll pass...');
  try {
    const whoisResult = await runWhoisExpiry(db, { maxPoll: 5000, daysThreshold: 90 });
    summary['whois-expiry'] = { pending: whoisResult.pending.length };
  } catch (err) {
    console.error('[WHOIS] Error:', err.message);
    summary['whois-expiry'] = { error: err.message };
  }

  console.log('[ExpiredAvailability] Confirming due dropped/expired domains...');
  try {
    summary['expired-availability'] = await refreshExpiredAvailability();
  } catch (err) {
    console.error('[ExpiredAvailability] Error:', err.message);
    summary['expired-availability'] = { error: err.message };
  }

  if (includeCZDS) {
    console.log('[ZoneIndex] Triggering zone file indexing...');
    indexAllPendingZoneFiles().catch(err => console.error('[ZoneIndex post-scrape]', err.message));
  }

  console.log('=== Done ===\n');
  return summary;
}

// Run directly
if (require.main === module) {
  let run;
  if (process.argv.includes('--expired-availability')) {
    run = refreshExpiredAvailability();
  } else if (process.argv.includes('--czds-drop-import')) {
    run = Promise.resolve(importCzdsDropCandidates());
  } else if (process.argv.includes('--godaddy-only') || process.argv.includes('--godaddy-cache-only')) {
    run = refreshGoDaddyInventory({}, {
      importDb: !process.argv.includes('--godaddy-cache-only'),
      failOnError: true,
    });
  } else if (process.argv.includes('--namecheap-only')) {
    run = refreshNamecheapInventory({});
  } else {
    run = scrapeAll({ includeCZDS: process.argv.includes('--czds') });
  }
  run
    .then(s => { console.log('Summary:', s); process.exit(0); })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { scrapeAll, refreshGoDaddyInventory, refreshNamecheapInventory, refreshExpiredAvailability };
