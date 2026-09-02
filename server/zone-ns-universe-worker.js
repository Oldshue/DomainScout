'use strict';

/**
 * Standalone child-process entry for sale reconstruction stage 3 (zone-wide
 * seller/parking nameserver universe). This never runs inside the web
 * server process — it is spawned the same way server/cctld-index-worker.js
 * is, does its bounded-memory work, prints one JSON summary line, and
 * exits. See server/zone-ns-universe.js for buildZoneUniverseDayToStore,
 * which streams matched hits into SQLite in small batches instead of
 * holding the whole day's domain set in memory.
 */

const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ensureZoneNsUniverseSchema,
  buildZoneUniverseDayToStore,
} = require('./zone-ns-universe');

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH)
  : path.join(__dirname, '../data');

const database = new Database(path.join(dataDir, 'domains.db'));
database.pragma('journal_mode = WAL');
database.pragma('synchronous = NORMAL');
database.pragma('busy_timeout = 60000');

const day = process.env.ZONE_NS_UNIVERSE_DAY || todayUtc();

async function main() {
  ensureZoneNsUniverseSchema(database);

  const result = await buildZoneUniverseDayToStore({
    database,
    day,
    user: process.env.CZDS_USER,
    pass: process.env.CZDS_PASS,
  });

  console.log(JSON.stringify(result));
  return result;
}

main()
  .then((result) => {
    database.close();
    process.exit(result && result.ran ? 0 : 2);
  })
  .catch((err) => {
    console.log(JSON.stringify({ ran: false, day, reason: 'error', error: err.message }));
    try { database.close(); } catch (_) { /* ignore */ }
    process.exit(2);
  });
