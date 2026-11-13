"use strict";
const path = require("node:path");
const { createUniversePuller } = require("./universe-puller");
const { startRefreshLeaseHeartbeat } = require("./refresh-lease");
const dataDir =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  process.env.DOMAINSCOUT_DATA_DIR ||
  path.join(__dirname, "../data");
const universeDir =
  process.env.DOMAINSCOUT_UNIVERSE_DIR || path.join(dataDir, "universe");
// The published day is complete once its tapes are in place. Sale Watch reads
// them into sale_watch.db here as a head start, and every Sale Watch wave runs
// the same import with its own lock retries. A busy sale_watch.db therefore
// must never fail the capture: that discarded a finished day and repeated the
// hour-long restore and summary import on every attempt (2026-11-13).
async function ingestPublishedMovement({ ingest, attempts = 6, delayMs = 5000, log = console, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  for (let attempt = 1; ; attempt++) {
    try {
      await ingest();
      return { ingested: true, attempts: attempt };
    } catch (error) {
      const busy = /database is locked|SQLITE_BUSY/i.test(String(error?.code || "") + " " + String(error?.message || ""));
      if (!busy) throw error;
      if (attempt >= attempts) {
        log.error(`[UniversePull] movement import left to the next Sale Watch wave after ${attempt} busy attempts: ${error.message}`);
        return { ingested: false, attempts: attempt };
      }
      await sleep(delayMs * attempt);
    }
  }
}
if (require.main !== module) {
  module.exports = { ingestPublishedMovement };
  return;
}
const stop = startRefreshLeaseHeartbeat();
const puller = createUniversePuller({
  dataDir,
  universeDir,
  onPublished: async ({ directory }) => {
    const Database = require("better-sqlite3");
    const db = new Database(path.join(dataDir, "sale_watch.db"));
    db.pragma("busy_timeout=30000");
    try {
      const recon = require("./sale-watch-reconstruction");
      await ingestPublishedMovement({
        ingest: async () => {
          recon.ensureReconstructionSchema(db);
          await recon.ingestMovementCandidates(db, { directory });
        },
      });
    } finally {
      db.close();
    }
  },
});
puller
  .runDay({ day: process.argv[2] })
  .then((result) => {
    console.log("[UniversePull] " + JSON.stringify(result));
    if (!result.complete) process.exitCode = 1;
  })
  .catch((error) => {
    console.error("[UniversePull] " + error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    stop();
  });
