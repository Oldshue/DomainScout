const ACTIVE_AUCTION_STREAMS = ['godaddy-auction', 'namecheap-auction'];
const ACTIVE_AUCTION_STREAMS_SQL = ACTIVE_AUCTION_STREAMS.map(s => `'${s}'`).join(',');

function activeAuctionWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `(
    ${p}stream NOT IN (${ACTIVE_AUCTION_STREAMS_SQL})
    OR ${p}auction_end IS NULL
    OR datetime(${p}auction_end) > datetime('now')
  )`;
}

function purgeEndedAuctions(db) {
  return db.prepare(`
    DELETE FROM domains
    WHERE stream IN (${ACTIVE_AUCTION_STREAMS_SQL})
      AND auction_end IS NOT NULL
      AND datetime(auction_end) <= datetime('now')
  `).run().changes;
}

module.exports = {
  ACTIVE_AUCTION_STREAMS,
  activeAuctionWhere,
  purgeEndedAuctions,
};
