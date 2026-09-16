"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const {
  PREFIX,
  getJson,
  putJson,
  restoreFile,
  captureZone,
} = require("./universe-snapshots");
const { createS3ObjectStore } = require("./recent-registration-corpus");
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function expectedDay(now = new Date()) {
  return new Date(now.getTime() - (now.getUTCHours() < 7 ? 86400000 : 0))
    .toISOString()
    .slice(0, 10);
}
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + crypto.randomUUID() + ".part";
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}
function materialized(record, dataDir, universeDir) {
  if (!record?.complete || !record.outputs) return false;
  try {
    const ns = JSON.parse(
      fs.readFileSync(path.join(universeDir, record.day, "ns", "summary.json")),
    );
    if (ns.runId !== record.runId) return false;
    for (const [key, relative] of Object.entries({
      movement: "ns/movement.jsonl",
      adds: "tape/adds.tsv",
      drops: "tape/drops.tsv",
    }))
      if (
        fs.statSync(path.join(universeDir, record.day, relative)).size !==
        record.outputs[key].bytes
      )
        return false;
    return (
      fs.statSync(path.join(dataDir, "universe_summary.db")).size ===
      record.summaryBytes
    );
  } catch {
    return false;
  }
}
function createUniversePuller(options = {}) {
  const env = options.env || process.env,
    now = options.now || (() => new Date()),
    log = options.log || console;
  const dataDir = options.dataDir,
    universeDir = options.universeDir;
  const store =
    options.objectStore === undefined
      ? createS3ObjectStore(env)
      : options.objectStore;
  const summary = options.summary || require("./universe-summary");
  const fetchImpl = options.fetchImpl || fetch;
  const prefix = env.DOMAINSCOUT_UNIVERSE_S3_PREFIX || PREFIX;
  const root = path.join(dataDir, "universe"),
    healthPath = path.join(root, "health.json");
  const scratchRoot =
    env.DOMAINSCOUT_UNIVERSE_SCRATCH_DIR ||
    path.join(os.tmpdir(), "domainscout-universe-v2");
  let active = null,
    progress = {};
  let lastProgressWrite = 0;
  function note(value) {
    progress = { ...progress, ...value, at: new Date(now()).toISOString() };
  }
  async function request(url, init = {}) {
    return fetchImpl(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(120000),
    });
  }
  async function runDay({ day = expectedDay(now()) } = {}) {
    if (active) return { skipped: "running" };
    if (!DAY.test(day)) throw Error("Invalid source day");
    if (day !== expectedDay(now()) && !options.allowHistoricalSource)
      throw Error(
        "Live registry downloads cannot reconstruct historical source days",
      );
    active = { day };
    const startedAt = new Date(now()).toISOString();
    let run;
    let stage = "listing";
    const recordPath = path.join(root, "pull", day + ".json");
    const scratch = path.join(scratchRoot, day);
    const previousHealth = await readJson(healthPath).catch(() => null);
    let lastCompleteDay = previousHealth?.lastCompleteDay || null;
    let healthQueue = Promise.resolve();
    async function healthWrite(status, error) {
      const failed = run?.failed || [];
      const value = {
        schema: "domainscout.universe-health/v2",
        status,
        lastCompleteDay,
        lastRun: {
          day,
          startedAt,
          phase: stage,
          finishedAt: ["ok", "incomplete", "failed"].includes(status)
            ? new Date(now()).toISOString()
            : null,
          error: error?.message || null,
        },
        zonesListed: run?.inventory?.length || 0,
        zonesOk: run?.zones?.length || 0,
        failedZones: failed.map((r) => r.tld),
        progress,
        movement: run?.movement || null,
        summary: run?.summary || null,
        retryable: status !== "ok",
        alerts: [
          ...failed.map((r) => `${r.tld}: ${r.error}`),
          ...(error ? [error.message] : []),
          ...(lastCompleteDay !== day
            ? [
                `No complete universe day for ${day}; latest ${lastCompleteDay || "none"}`,
              ]
            : []),
        ],
      };
      healthQueue = healthQueue
        .catch(() => {})
        .then(() => atomicJson(healthPath, value));
      await healthQueue;
      return value;
    }
    let writeQueue = Promise.resolve();
    const checkpoint = () => {
      writeQueue = writeQueue
        .catch(() => {})
        .then(async () => {
          await atomicJson(recordPath, run);
          await putJson(
            store,
            `${prefix}/runs/${day}/${run.runId}/checkpoint.json`,
            run,
          );
          await putJson(store, `${prefix}/pending/${day}.json`, run);
          await healthWrite("running");
        });
      return writeQueue;
    };
    const heartbeat = setInterval(() => {
      if (Date.now() - lastProgressWrite > 10000) {
        lastProgressWrite = Date.now();
        healthWrite("running").catch((e) =>
          log.error?.("[UniversePull] health write:", e.message),
        );
      }
    }, 15000);
    heartbeat.unref?.();
    try {
      if (!store)
        throw Error(
          "Evidence object storage is required for the cloud universe lane",
        );
      const auth = await request(
        "https://account-api.icann.org/api/authenticate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: env.CZDS_USER,
            password: env.CZDS_PASS,
          }),
        },
      );
      if (!auth.ok) throw Error("CZDS authentication HTTP " + auth.status);
      const { accessToken } = await auth.json();
      if (!accessToken) throw Error("CZDS authentication returned no token");
      const listed = await request(
        "https://czds-api.icann.org/czds/downloads/links",
        { headers: { Authorization: "Bearer " + accessToken } },
      );
      if (!listed.ok) throw Error("CZDS inventory HTTP " + listed.status);
      const urls = await listed.json();
      if (!Array.isArray(urls) || !urls.length)
        throw Error("CZDS returned an empty inventory");
      const inventory = urls.map((url) => ({
        url,
        tld: path
          .basename(new URL(url).pathname)
          .replace(/\.zone(?:\.gz)?$/, ""),
      }));
      if (
        inventory.some((r) => !/^[a-z0-9-]+$/.test(r.tld)) ||
        new Set(inventory.map((r) => r.tld)).size !== inventory.length
      )
        throw Error("Invalid or duplicate CZDS zones");
      const local = await readJson(recordPath).catch(() => null);
      const remote =
        local?.schema === "domainscout.zone-universe/v2"
          ? null
          : await getJson(store, `${prefix}/pending/${day}.json`);
      const latest = await getJson(store, prefix + "/latest.json");
      // A complete published receipt outranks an older pending checkpoint.
      // Re-materialization must never overwrite immutable published artifacts.
      const existing = latest?.complete && latest.day === day
        ? latest
        : local?.schema === "domainscout.zone-universe/v2" ? local : remote;
      if (
        env.DOMAINSCOUT_UNIVERSE_REQUIRE_BASELINE === "1" &&
        !latest?.complete
      )
        throw Error(
          "Waiting for the retained complete source archive to finish migration; automatic retry remains enabled",
        );
      if (
        existing?.schema === "domainscout.zone-universe/v2" &&
        materialized(existing, dataDir, universeDir) &&
        latest?.runId === existing.runId
      ) {
        lastCompleteDay = day;
        run = existing;
        stage = "complete";
        return {
          day,
          complete: true,
          skipped: "complete",
          health: await healthWrite("ok"),
        };
      }
      const reusable =
        existing?.schema === "domainscout.zone-universe/v2" &&
        existing.day === day;
      run = reusable
        ? existing
        : {
            schema: "domainscout.zone-universe/v2",
            day,
            runId: crypto.randomUUID(),
            zones: [],
            complete: false,
            startedAt,
          };
      if (run.complete) {
        run = { ...run, runId: crypto.randomUUID(), complete: false };
      }
      // Bind retries to the same immutable baseline, even if another importer
      // publishes a newer pointer while this run is recovering.
      if (!run.previousKey && latest?.complete && latest.day < day)
        run.previousKey = `${prefix}/runs/${latest.day}/${latest.runId}/manifest.json`;
      const previous = run.previousKey
        ? await getJson(store, run.previousKey)
        : null;
      if (
        run.previousKey &&
        (!previous?.complete || !Array.isArray(previous.zones))
      )
        throw Error(
          "Bound complete baseline is missing or invalid; refusing to lose movement history",
        );
      run.inventory = inventory.map((r) => r.tld);
      run.zones = run.zones.filter((r) => run.inventory.includes(r.tld));
      run.failed = [];
      run.complete = false;
      await fsp.mkdir(scratchRoot, { recursive: true });
      // Prior-day scratch contains only disposable projections/partial files;
      // successful zone evidence remains in immutable object-store receipts.
      for (const entry of await fsp.readdir(scratchRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && DAY.test(entry.name) && entry.name < day)
          await fsp.rm(path.join(scratchRoot, entry.name), { recursive: true, force: true });
      }
      await fsp.mkdir(path.join(scratch, "names"), { recursive: true });
      const acceptedNames = new Set(inventory.map(r => r.tld + ".names.gz"));
      for (const file of await fsp.readdir(path.join(scratch, "names"))) {
        if (file.endsWith(".names.gz") && !acceptedNames.has(file))
          await fsp.rm(path.join(scratch, "names", file));
      }
      await checkpoint();
      stage = "capturing";
      let next = 0;
      const pending = inventory.filter(
        (zone) => !run.zones.some((r) => r.tld === zone.tld),
      );
      // Big sources start first; each worker retains only one zone's scratch.
      pending.sort(
        (a, b) =>
          (["com", "net", "org"].includes(b.tld) ? 1 : 0) -
          (["com", "net", "org"].includes(a.tld) ? 1 : 0),
      );
      await Promise.all(
        Array.from(
          {
            length: Math.max(
              1,
              Math.min(
                4,
                Number(env.DOMAINSCOUT_UNIVERSE_PULL_CONCURRENCY) || 2,
              ),
            ),
          },
          async () => {
            while (next < pending.length) {
              const zone = pending[next++];
              let error;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  note({ zone: zone.tld, attempt, phase: "downloading" });
                  const receipt = await (options.captureZone || captureZone)({
                    store,
                    prefix,
                    day,
                    runId: run.runId,
                    zone: zone.tld,
                    scratch,
                    previous: previous?.zones.find((r) => r.tld === zone.tld)
                      ? {
                          ...previous.zones.find((r) => r.tld === zone.tld),
                          day: previous.day,
                        }
                      : null,
                    onProgress: note,
                    signal: AbortSignal.timeout(
                      Number(env.DOMAINSCOUT_UNIVERSE_ZONE_TIMEOUT_MS) ||
                        2 * 3600000,
                    ),
                    openSource: async () => {
                      const controller = new AbortController();
                      let timer = setTimeout(
                        () =>
                          controller.abort(
                            new Error("Registry source idle for 180 seconds"),
                          ),
                        180000,
                      );
                      const res = await request(zone.url, {
                        headers: { Authorization: "Bearer " + accessToken },
                        signal: controller.signal,
                      });
                      if (!res.ok) {
                        clearTimeout(timer);
                        throw Error("Registry download HTTP " + res.status);
                      }
                      const { Transform, Readable } = require("node:stream");
                      const body =
                        typeof res.body.pipe === "function"
                          ? res.body
                          : Readable.fromWeb(res.body);
                      const watcher = new Transform({
                        transform(chunk, enc, cb) {
                          clearTimeout(timer);
                          timer = setTimeout(
                            () =>
                              controller.abort(
                                new Error(
                                  "Registry source stalled for 180 seconds",
                                ),
                              ),
                            180000,
                          );
                          cb(null, chunk);
                        },
                      });
                      body.on("error", (e) => watcher.destroy(e));
                      watcher.on("close", () => {
                        clearTimeout(timer);
                        body.destroy();
                      });
                      body.pipe(watcher);
                      return {
                        body: watcher,
                        lastModified:
                          res.headers?.get?.("last-modified") || null,
                      };
                    },
                  });
                  run.zones.push(receipt);
                  error = null;
                  break;
                } catch (e) {
                  error = e;
                  log.error?.(
                    `[UniversePull] ${zone.tld} attempt ${attempt}: ${e.message}`,
                  );
                }
              }
              if (error)
                run.failed.push({ tld: zone.tld, error: error.message });
              await checkpoint();
            }
          },
        ),
      );
      if (run.failed.length || run.zones.length !== inventory.length) {
        stage = "capturing";
        clearInterval(heartbeat);
        return {
          day,
          complete: false,
          health: await healthWrite("incomplete"),
        };
      }
      // Restarts reconstruct local materializations exclusively from hash-checked
      // immutable objects; an old checkpoint never proves a missing file exists.
      stage = "restoring";
      await healthWrite("running");
      for (const receipt of run.zones) {
        note({ zone: receipt.tld, phase: stage });
        await restoreFile(
          store,
          receipt.names,
          path.join(scratch, "names", receipt.tld + ".names.gz"),
          AbortSignal.timeout(30 * 60000),
        );
      }
      stage = "publishing-movement";
      await healthWrite("running");
      const nsStage = path.join(scratch, "ns"),
        tapeStage = path.join(scratch, "tape");
      await fsp.mkdir(nsStage, { recursive: true });
      await fsp.mkdir(tapeStage, { recursive: true });
      const movement = {
        day,
        runId: run.runId,
        prevDay: previous?.day || null,
        zones: inventory.length,
        complete: true,
        baseline: !previous,
        comparedZones: 0,
        baselineZones: [],
        departures: 0,
        wentLive: 0,
        listed: 0,
        totals: {},
        perZone: {},
      };
      const files = {
        movement: path.join(nsStage, "movement.jsonl"),
        adds: path.join(tapeStage, "adds.tsv"),
        drops: path.join(tapeStage, "drops.tsv"),
      };
      for (const file of Object.values(files)) await fsp.writeFile(file, "");
      const zones = {};
      for (const receipt of run.zones) {
        note({ zone: receipt.tld, phase: stage });
        const d = receipt.diff;
        zones[receipt.tld] = {
          status: d ? "ok" : "no-baseline",
          window_start: d?.prevDay || null,
          baseline_count: d?.counts.prevNames || 0,
          today_count: receipt.labels,
          adds: d?.counts.added || 0,
          drops: d?.counts.dropped || 0,
        };
        if (!d) {
          movement.baselineZones.push(receipt.tld);
          continue;
        }
        movement.comparedZones++;
        movement.perZone[receipt.tld] = d.counts;
        for (const k of ["departures", "wentLive", "listed"])
          movement[k] += d[k];
        for (const [k, v] of Object.entries(d.counts))
          movement.totals[k] = (movement.totals[k] || 0) + v;
        for (const k of ["movement", "adds", "drops"]) {
          const restored = path.join(scratch, "fragment");
          await restoreFile(
            store,
            d[k],
            restored,
            AbortSignal.timeout(10 * 60000),
          );
          await pipeline(
            fs.createReadStream(restored),
            fs.createWriteStream(files[k], { flags: "a" }),
          );
          await fsp.rm(restored);
        }
      }
      await atomicJson(path.join(nsStage, "summary.json"), movement);
      await atomicJson(path.join(tapeStage, "zones.json"), zones);
      // Object-store receipts precede local visibility. Empty baseline tapes are
      // explicit and never report the whole first snapshot as new registrations.
      const { uploadMaybeEmpty } = require("./universe-snapshots");
      run.outputs = {};
      for (const [k, file] of Object.entries(files))
        run.outputs[k] = await uploadMaybeEmpty(
          store,
          `${prefix}/runs/${day}/${run.runId}/${k}`,
          file,
          AbortSignal.timeout(30 * 60000),
        );
      await putJson(
        store,
        `${prefix}/runs/${day}/${run.runId}/movement-summary.json`,
        movement,
      );
      await putJson(
        store,
        `${prefix}/runs/${day}/${run.runId}/zones.json`,
        zones,
      );
      stage = "summary";
      await healthWrite("running");
      const built = await summary.buildUniverseSummaryTape({
        namesDir: path.join(scratch, "names"),
        day,
        outDir: path.join(scratch, "summary"),
        log,
      });
      run.outputs.summary = await store.putFile(
        `${prefix}/runs/${day}/${run.runId}/summary.tsv.gz`,
        built.tapePath,
        "application/gzip",
        { signal: AbortSignal.timeout(2 * 3600000) },
      );
      await summary.importUniverseSummaryTape({
        tapePath: built.tapePath,
        dataDir,
        expectZones: inventory.length,
        requireZones: inventory.map((r) => r.tld),
        log,
      });
      run.summary = { day, zones: built.zones };
      run.summaryBytes = fs.existsSync(
        path.join(dataDir, "universe_summary.db"),
      )
        ? fs.statSync(path.join(dataDir, "universe_summary.db")).size
        : null;
      // Publish each directory once; consumers cannot observe a half-written tape.
      const dayDir = path.join(universeDir, day);
      await fsp.mkdir(dayDir, { recursive: true });
      for (const [name, from] of [
        ["ns", nsStage],
        ["tape", tapeStage],
      ]) {
        const target = path.join(dayDir, name),
          staged = target + ".staging-" + run.runId;
        await fsp.rm(staged, { recursive: true, force: true });
        await fsp.cp(from, staged, { recursive: true });
        if (fs.existsSync(target))
          await fsp.rename(target, target + ".previous-" + Date.now());
        await fsp.rename(staged, target);
      }
      run.movement = movement;
      if (options.onPublished)
        await options.onPublished({ day, directory: universeDir });
      run.finishedAt = new Date(now()).toISOString();
      await checkpoint();
      run.complete = true;
      await putJson(
        store,
        `${prefix}/runs/${day}/${run.runId}/manifest.json`,
        run,
      );
      await putJson(store, prefix + "/latest.json", run);
      await atomicJson(recordPath, run);
      lastCompleteDay = day;
      stage = "complete";
      clearInterval(heartbeat);
      const result = {
        day,
        complete: true,
        ok: run.zones.length,
        failed: 0,
        health: await healthWrite("ok"),
      };
      await fsp.rm(scratch, { recursive: true, force: true });
      return result;
    } catch (error) {
      clearInterval(heartbeat);
      if (run) {
        run.complete = false;
        run.error = error.message;
        await atomicJson(recordPath, run).catch(() => {});
      }
      await healthWrite("failed", error);
      throw error;
    } finally {
      clearInterval(heartbeat);
      active = null;
    }
  }
  async function health() {
    return (
      (await readJson(healthPath)) || {
        status: "unknown",
        alerts: ["Universe lane has not run yet"],
      }
    );
  }
  async function retryIncomplete() {
    const day = expectedDay(now());
    const record = await readJson(path.join(root, "pull", day + ".json")).catch(
      () => null,
    );
    return materialized(record, dataDir, universeDir)
      ? { skipped: "complete" }
      : runDay({ day });
  }
  return { runDay, retryIncomplete, health, isRunning: () => !!active };
}
module.exports = {
  createUniversePuller,
  expectedDay,
  atomicJson,
  readJson,
  materialized,
};
