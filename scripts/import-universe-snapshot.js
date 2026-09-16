#!/usr/bin/env node
"use strict";
// Import a retained, dated registry archive through the same cloud snapshot
// primitive as scheduled pulls. Never infer dates by downloading today's feed.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createS3ObjectStore } = require("../server/recent-registration-corpus");
const { atomicJson } = require("../server/universe-puller");
const {
  PREFIX,
  captureZone,
  putJson,
} = require("../server/universe-snapshots");
async function main() {
  const [directory, day] = process.argv.slice(2);
  if (!directory || !/^\d{4}-\d{2}-\d{2}$/.test(day || ""))
    throw Error(
      "usage: import-universe-snapshot.js ARCHIVE_DIRECTORY YYYY-MM-DD",
    );
  const zones = fs
    .readFileSync(path.join(directory, "links.txt"), "utf8")
    .trim()
    .split(/\s+/)
    .map((url) =>
      path.basename(new URL(url).pathname).replace(/\.zone(?:\.gz)?$/, ""),
    );
  if (
    !zones.length ||
    new Set(zones).size !== zones.length ||
    zones.some((z) => !/^[a-z0-9-]+$/.test(z))
  )
    throw Error("Invalid archived zone inventory");
  for (const zone of zones)
    if (!fs.existsSync(path.join(directory, zone + ".zone.gz")))
      throw Error("Archive missing " + zone);
  const store = createS3ObjectStore();
  if (!store) throw Error("Evidence object store required");
  const scratch = path.join(os.tmpdir(), "domainscout-snapshot-import", day);
  await fsp.mkdir(scratch, { recursive: true });
  const progress = path.join(scratch, "manifest.json");
  const manifest = fs.existsSync(progress)
    ? JSON.parse(fs.readFileSync(progress))
    : {
        schema: "domainscout.zone-universe/v2",
        day,
        runId: crypto.randomUUID(),
        inventory: zones,
        zones: [],
        complete: false,
        historicalBaseline: true,
      };
  const pending = zones
    .filter((z) => !manifest.zones.some((r) => r.tld === z))
    .sort(
      (a, b) =>
        fs.statSync(path.join(directory, b + ".zone.gz")).size -
        fs.statSync(path.join(directory, a + ".zone.gz")).size,
    );
  let index = 0;
  let checkpointQueue = Promise.resolve();
  const checkpoint = () => {
    checkpointQueue = checkpointQueue.then(() => atomicJson(progress, manifest));
    return checkpointQueue;
  };
  const concurrency = Math.max(1, Math.min(4, Number(process.env.DOMAINSCOUT_UNIVERSE_PULL_CONCURRENCY) || 2));
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (index < pending.length) {
        const zone = pending[index++];
        console.log("Capturing archived zone", zone);
        const receipt = await captureZone({
          store,
          runId: manifest.runId,
          day,
          zone,
          scratch,
          openSource: async () => ({
            body: fs.createReadStream(path.join(directory, zone + ".zone.gz")),
          }),
          signal: AbortSignal.timeout(3 * 3600000),
        });
        manifest.zones.push(receipt);
        await checkpoint();
        await putJson(
          store,
          `${PREFIX}/runs/${day}/${manifest.runId}/checkpoint.json`,
          manifest,
        );
        await fsp.rm(path.join(scratch, "names", zone + ".names.gz"), {
          force: true,
        });
        if (manifest.zones.length % 25 === 0)
          console.log("Persisted", manifest.zones.length, "/", zones.length);
      }
    }),
  );
  manifest.complete = manifest.zones.length === zones.length;
  manifest.finishedAt = new Date().toISOString();
  if (!manifest.complete) throw Error("Archive import incomplete");
  await putJson(
    store,
    `${PREFIX}/runs/${day}/${manifest.runId}/manifest.json`,
    manifest,
  );
  const { getJson } = require("../server/universe-snapshots");
  const current = await getJson(store, `${PREFIX}/latest.json`);
  if (!current || current.day < day)
    await putJson(store, `${PREFIX}/latest.json`, manifest);
  await checkpoint();
  console.log(
    JSON.stringify({
      complete: true,
      day,
      zones: zones.length,
      runId: manifest.runId,
    }),
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
