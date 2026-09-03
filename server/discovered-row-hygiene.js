'use strict';

const MALFORMED_DOMAIN_ROW_SQL = "(domain LIKE '%@%' OR domain LIKE '% %' OR domain GLOB '*[^a-z0-9.-]*' OR base_name LIKE '%.%' OR base_name LIKE '-%' OR base_name LIKE '%-' OR LENGTH(base_name) < 2 OR LENGTH(base_name) > 63 OR base_name GLOB '*[^a-z0-9-]*')";

function purgeMalformedDiscoveredRows(db, { stream = 'discovered', log = console } = {}) {
  try {
    const countStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM domains WHERE stream = ? AND ${MALFORMED_DOMAIN_ROW_SQL}`
    );
    const deleteStmt = db.prepare(
      `DELETE FROM domains WHERE stream = ? AND ${MALFORMED_DOMAIN_ROW_SQL}`
    );

    const run = db.transaction((streamName) => {
      const matched = countStmt.get(streamName).n;
      const result = deleteStmt.run(streamName);
      return { matched, deleted: result.changes };
    });

    const { matched, deleted } = run(stream);

    if (deleted > 0) {
      log.log(`[DiscoveredHygiene] purged ${deleted} malformed ${stream} rows`);
    }

    return { stream, matched, deleted };
  } catch (error) {
    return { stream, matched: 0, deleted: 0, error: String(error && error.message || error) };
  }
}

module.exports = { MALFORMED_DOMAIN_ROW_SQL, purgeMalformedDiscoveredRows };
