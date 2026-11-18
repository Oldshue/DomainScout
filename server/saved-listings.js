'use strict';

// A Saved (flagged) name lives as a row in `domains`, while the big venue boards
// (GoDaddy, Namecheap, Dynadot) live in provider snapshots. This module is the one
// place that carries a venue's current listing onto the Saved row, so the Saved
// list always shows where a flagged name is listed today: venue, end, price, URL.
//
// It only ever moves a Saved row forward to a listing that is current now. A name
// that is not in the offered rows is left alone: absence from one venue's board
// says nothing about the others, and the row's past end date already reads as
// "not at auction".

function isCurrentListing(row, nowMs) {
  if (!row || !row.domain || !row.stream) return false;
  if (row.auction_end == null || row.auction_end === '') return row.stream === 'godaddy-closeout';
  const endMs = Date.parse(row.auction_end);
  return Number.isFinite(endMs) && endMs > nowMs;
}

function savedDomains(db) {
  return db.prepare('SELECT id, domain, stream, auction_end FROM domains WHERE saved = 1').all();
}

// rows: an iterable of listing rows (domain, stream, source, auction_end,
// auction_price, auction_url, bid_count). Returns the Saved names that were updated.
function applyCurrentListingsToSaved(db, rows, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const saved = savedDomains(db);
  if (saved.length === 0) return [];
  const wanted = new Map();
  for (const row of saved) {
    if (!wanted.has(row.domain)) wanted.set(row.domain, []);
    wanted.get(row.domain).push(row);
  }
  const matches = new Map();
  for (const row of rows || []) {
    if (!row || !wanted.has(row.domain) || !isCurrentListing(row, nowMs)) continue;
    matches.set(row.domain, row);
  }
  if (matches.size === 0) return [];

  // UNIQUE(domain, stream): when the venue already has an unsaved row for this
  // name, the Saved row (which carries the owner's flag and notes) replaces it.
  const update = db.prepare(`
    UPDATE OR REPLACE domains
    SET stream = @stream,
        source = @source,
        auction_price = @auction_price,
        auction_end = @auction_end,
        auction_url = @auction_url,
        bid_count = @bid_count
    WHERE id = @id AND saved = 1
  `);
  const updated = [];
  db.transaction(() => {
    for (const [domain, listing] of matches) {
      // One Saved row per name carries the listing; keep the most recently listed one.
      const target = wanted.get(domain)
        .slice()
        .sort((a, b) => String(b.auction_end || '').localeCompare(String(a.auction_end || '')))[0];
      const changes = update.run({
        id: target.id,
        stream: listing.stream,
        source: listing.source || null,
        auction_price: listing.auction_price ?? null,
        auction_end: listing.auction_end || null,
        auction_url: listing.auction_url || null,
        bid_count: Number(listing.bid_count) || 0,
      }).changes;
      if (changes) updated.push({ domain, stream: listing.stream, auction_end: listing.auction_end || null });
    }
  })();
  return updated;
}

// A name that is watched by name (the eye) may have no row at all. Its current
// listing is stored as an ordinary venue row so every reader of the stored
// streams (the watchlist, search, the Saved list) sees it.
function upsertCurrentListings(db, rows, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const upsert = db.prepare(`
    INSERT INTO domains
      (domain, tld, stream, source, auction_price, auction_end, auction_url, bid_count,
       length, has_numbers, has_hyphens)
    VALUES
      (@domain, @tld, @stream, @source, @auction_price, @auction_end, @auction_url, @bid_count,
       @length, @has_numbers, @has_hyphens)
    ON CONFLICT(domain, stream) DO UPDATE SET
      source = excluded.source,
      auction_price = excluded.auction_price,
      auction_end = excluded.auction_end,
      auction_url = excluded.auction_url,
      bid_count = excluded.bid_count
  `);
  let written = 0;
  db.transaction(() => {
    for (const row of rows || []) {
      if (!isCurrentListing(row, nowMs) || !row.tld) continue;
      written += upsert.run({
        domain: row.domain,
        tld: row.tld,
        stream: row.stream,
        source: row.source || null,
        auction_price: row.auction_price ?? null,
        auction_end: row.auction_end || null,
        auction_url: row.auction_url || null,
        bid_count: Number(row.bid_count) || 0,
        length: row.length ?? null,
        has_numbers: row.has_numbers ? 1 : 0,
        has_hyphens: row.has_hyphens ? 1 : 0,
      }).changes;
    }
  })();
  return written;
}

module.exports = { applyCurrentListingsToSaved, isCurrentListing, savedDomains, upsertCurrentListings };
