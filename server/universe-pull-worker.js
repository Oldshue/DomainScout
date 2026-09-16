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
      recon.ensureReconstructionSchema(db);
      await recon.ingestMovementCandidates(db, { directory });
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
