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
const { runMarketplaces }= require('../scrapers/marketplaces');
const { runWhoisExpiry } = require('../scrapers/whois-expiry');
const { enrichDomains }  = require('../enrichment');

const insert = db.prepare(`
  INSERT OR IGNORE INTO domains
    (domain, tld, stream, source, auction_price, auction_end, auction_url,
     length, has_numbers, has_hyphens, drop_date)
  VALUES
    (@domain, @tld, @stream, @source, @auction_price, @auction_end, @auction_url,
     @length, @has_numbers, @has_hyphens, @drop_date)
`);

const updateEnrichment = db.prepare(`
  UPDATE domains SET
    dns_available = @dns_available,
    wayback_snapshots = @wayback_snapshots,
    wayback_first = @wayback_first,
    wayback_last = @wayback_last,
    age_years = @age_years,
    expiry_date = COALESCE(@expiry_date, expiry_date)
  WHERE domain = @domain
`);

const logRun = db.prepare(`
  INSERT INTO scrape_log (stream, domains_found, domains_new, error)
  VALUES (@stream, @domains_found, @domains_new, @error)
`);

function insertDomains(domains) {
  let newCount = 0;
  const run = db.transaction((items) => {
    for (const d of items) {
      if (!d || !d.domain || !d.tld) continue;
      const info = insert.run({
        domain: d.domain,
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
      });
      if (info.changes > 0) newCount++;
    }
  });
  run(domains);
  return newCount;
}

async function enrichStream(streamName, limit = 50) {
  const toEnrich = db.prepare(`
    SELECT domain FROM domains
    WHERE stream = ? AND dns_available IS NULL
    ORDER BY discovered_at DESC LIMIT ?
  `).all(streamName, limit).map(r => r.domain);

  if (toEnrich.length === 0) return;

  console.log(`  Enriching ${toEnrich.length} new ${streamName} domains...`);
  const enriched = await enrichDomains(toEnrich, { concurrency: 4, delayMs: 300 });

  db.transaction((items) => {
    for (const e of items) updateEnrichment.run({
      domain: e.domain,
      dns_available: e.dns_available,
      wayback_snapshots: e.wayback_snapshots,
      wayback_first: e.wayback_first,
      wayback_last: e.wayback_last,
      age_years: e.age_years,
      expiry_date: e.expiry_date || null,
    });
  })(enriched);
}

async function scrapeAll() {
  console.log('\n=== DomainScout Scrape ===', new Date().toISOString());

  // Run all sources in parallel where possible
  console.log('Starting sources...');

  const [czdsDropped, ctDiscovered, auctionDomains, marketDomains] = await Promise.allSettled([
    runCZDS(),
    runCRTSH(),      // now returns "discovered" stream (ccTLD seed for RDAP polling)
    runAuctions(),
    runMarketplaces(),
  ]).then(r => r.map(p => p.status === 'fulfilled' ? p.value : []));

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
  const pendingDomains = auctionDomains.filter(d => d.stream === 'pending-delete');
  const auctionOnly    = auctionDomains.filter(d => d.stream === 'godaddy-auction');
  const marketplaceFromAuctions = auctionDomains.filter(d => d.stream === 'marketplace');
  const allMarket = [...marketDomains, ...marketplaceFromAuctions];

  // Insert all streams
  const streamData = [
    { name: 'just-dropped',    domains: droppedUniq },
    { name: 'discovered',      domains: discoveredUniq },
    { name: 'pending-delete',  domains: pendingDomains },
    { name: 'godaddy-auction', domains: auctionOnly },
    { name: 'marketplace',     domains: allMarket },
  ];

  // Phase 1: insert all streams immediately (no blocking network calls)
  const summary = {};
  for (const { name, domains } of streamData) {
    const newCount = insertDomains(domains);
    logRun.run({ stream: name, domains_found: domains.length, domains_new: newCount, error: null });
    console.log(`  ${name}: ${domains.length} found, ${newCount} new`);
    summary[name] = { found: domains.length, new: newCount };
  }

  // Phase 2: enrich new domains (DNS/Wayback) — after all inserts so nothing blocks
  for (const { name } of streamData) {
    await enrichStream(name, 20);
  }

  // WHOIS expiry pass — seeds from Tranco, polls unpolled .io/.ai/.sh/.bot for expiry dates
  console.log('[WHOIS] Running expiry poll pass...');
  try {
    const whoisResult = await runWhoisExpiry(db, { maxPoll: 150, daysThreshold: 90 });
    summary['whois-expiry'] = { pending: whoisResult.pending.length };
  } catch (err) {
    console.error('[WHOIS] Error:', err.message);
    summary['whois-expiry'] = { error: err.message };
  }

  console.log('=== Done ===\n');
  return summary;
}

// Run directly
if (require.main === module) {
  scrapeAll()
    .then(s => { console.log('Summary:', s); process.exit(0); })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { scrapeAll };
