const ACTIVE_AUCTION_STREAMS = ['godaddy-auction', 'namecheap-auction'];
const ACTIVE_AUCTION_STREAMS_SQL = ACTIVE_AUCTION_STREAMS.map(s => `'${s}'`).join(',');

function activeAuctionWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  const nowIso = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  return `(
    ${p}stream NOT IN (${ACTIVE_AUCTION_STREAMS_SQL})
    OR ${p}auction_end IS NULL
    OR ${p}auction_end > ${nowIso}
  )`;
}

function endedAuctionWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `(
    ${p}stream IN (${ACTIVE_AUCTION_STREAMS_SQL})
    AND ${p}auction_end IS NOT NULL
    AND ${p}auction_end <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )`;
}

function archiveEndedAuctions(db) {
  const rows = db.prepare(`
    SELECT domain, base_name, tld, stream, source, auction_end, discovered_at, bid_count
    FROM domains
    WHERE ${endedAuctionWhere()}
      AND COALESCE(status, '') <> 'pending-delete'
  `).all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO drop_events (
      domain, base_name, tld, source, source_kind, source_event_at,
      prior_registered_evidence, released_at, registration_available,
      availability_source, availability_checked_at, observed_at
    ) VALUES (
      @domain, @base_name, @tld, @archive_source, 'expired-auction-ended', @auction_end,
      @prior_registered_evidence, NULL, NULL, NULL, NULL, datetime('now')
    )
  `);

  return db.transaction(() => {
    let inserted = 0;
    for (const row of rows) {
      const dotIndex = row.domain.lastIndexOf('.');
      const baseName = row.base_name || (dotIndex > 0 ? row.domain.slice(0, dotIndex) : row.domain);
      const evidence = JSON.stringify({
        stream: row.stream,
        source: row.source ?? null,
        auction_end: row.auction_end,
        discovered_at: row.discovered_at ?? null,
        bid_count: Number(row.bid_count || 0),
      });
      inserted += insert.run({
        ...row,
        base_name: baseName,
        archive_source: `auction:${row.stream}`,
        prior_registered_evidence: evidence,
      }).changes;
    }
    return inserted;
  })();
}

function purgeEndedAuctions(db) {
  return archiveEndedAuctions(db);
}

module.exports = {
  ACTIVE_AUCTION_STREAMS,
  activeAuctionWhere,
  archiveEndedAuctions,
  endedAuctionWhere,
  purgeEndedAuctions,
};
