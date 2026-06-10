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

function purgeEndedAuctions(db) {
  // Never delete a user's curated rows — a saved watchlist name (or a skipped one)
  // must survive its auction ending, otherwise the Saved view silently empties out.
  return db.prepare(`
    DELETE FROM domains
    WHERE ${endedAuctionWhere()}
      AND saved = 0 AND skipped = 0
  `).run().changes;
}

module.exports = {
  ACTIVE_AUCTION_STREAMS,
  activeAuctionWhere,
  endedAuctionWhere,
  purgeEndedAuctions,
};
