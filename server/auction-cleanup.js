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
  const archive = db.prepare(`
    INSERT OR IGNORE INTO drop_events (
      domain, base_name, tld, source, source_kind, source_event_at,
      prior_registered_evidence, released_at, registration_available,
      availability_source, availability_checked_at, observed_at
    )
    SELECT
      d.domain,
      COALESCE(NULLIF(d.base_name, ''),
        CASE
          WHEN instr(d.domain, '.') > 1 THEN substr(d.domain, 1, (
            WITH RECURSIVE dot_positions(position) AS (
              VALUES (instr(d.domain, '.'))
              UNION ALL
              SELECT position + instr(substr(d.domain, position + 1), '.')
              FROM dot_positions
              WHERE instr(substr(d.domain, position + 1), '.') > 0
            )
            SELECT max(position) FROM dot_positions
          ) - 1)
          ELSE d.domain
        END
      ),
      d.tld,
      'auction:' || d.stream,
      'expired-auction-ended',
      d.auction_end,
      json_object(
        'stream', d.stream,
        'source', d.source,
        'auction_end', d.auction_end,
        'discovered_at', d.discovered_at,
        'bid_count', CAST(COALESCE(d.bid_count, 0) AS NUMERIC)
      ),
      NULL, NULL, NULL, NULL, datetime('now')
    FROM domains AS d
    WHERE ${endedAuctionWhere('d')}
      AND COALESCE(d.status, '') <> 'pending-delete'
  `);

  return db.transaction(() => archive.run().changes)();
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
