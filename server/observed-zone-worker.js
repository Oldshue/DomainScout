"use strict";
// Child process for one observed-zone capture (spawned by
// createObservedZoneSupervisor). Isolated from the CZDS universe worker: its
// own lease, its own health file, its own object-store keys.
const path = require("node:path");
const { createObservedZoneRunner } = require("./observed-zones");
const { startRefreshLeaseHeartbeat } = require("./refresh-lease");
const dataDir =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  process.env.DOMAINSCOUT_DATA_DIR ||
  path.join(__dirname, "../data");
const universeDir =
  process.env.DOMAINSCOUT_UNIVERSE_DIR || path.join(dataDir, "universe");
const [tld, day, mode] = process.argv.slice(2);
const stop = startRefreshLeaseHeartbeat();
const runner = createObservedZoneRunner({
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
runner
  .runZone({ tld, day: day || undefined, force: mode === "force" })
  .then((result) => {
    console.log("[ObservedZones] " + JSON.stringify(result));
    if (!result.complete) process.exitCode = 1;
  })
  .catch((error) => {
    console.error("[ObservedZones] " + error.message);
    process.exitCode = 1;
  })
  .finally(() => stop());
