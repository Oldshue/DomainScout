"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");
const extract = require("./universe-extract");
const { diffZoneDelegations } = require("./zone-ns-movement");
const PREFIX = "domainscout/corpora/zone-universe/v2";
const nodeStream = (body) =>
  typeof body?.pipe === "function" ? body : Readable.fromWeb(body);
async function getJson(store, key) {
  try {
    return JSON.parse((await store.get(key)).toString());
  } catch (e) {
    if (
      e.name === "NoSuchKey" ||
      e.name === "NotFound" ||
      e.$metadata?.httpStatusCode === 404 ||
      e.code === "ENOENT"
    )
      return null;
    throw e;
  }
}
async function putJson(store, key, value) {
  await store.put(key, Buffer.from(JSON.stringify(value)), "application/json");
}
async function restoreFile(store, receipt, file, signal) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const check = new Transform({
    transform(chunk, enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  const part = file + ".part";
  try {
    await pipeline(
      nodeStream(await store.getStream(receipt.key, { signal })),
      check,
      fs.createWriteStream(part),
      { signal },
    );
    if (hash.digest("hex") !== receipt.sha256 || bytes !== receipt.bytes)
      throw new Error("Object integrity mismatch: " + receipt.key);
    await fsp.rename(part, file);
  } finally {
    await fsp.rm(part, { force: true }).catch(() => {});
  }
}
async function writeLine(stream, line) {
  if (!stream.write(line)) await require("node:events").once(stream, "drain");
}
async function captureZone({
  store,
  prefix = PREFIX,
  runId,
  day,
  zone,
  openSource,
  scratch,
  previous,
  onProgress = () => {},
  signal,
}) {
  const dir = path.join(scratch, "zones", zone);
  await fsp.mkdir(dir, { recursive: true });
  const snapshotPath = path.join(dir, "snapshot.gz"),
    namesPath = path.join(scratch, "names", `${zone}.names.gz`);
  await fsp.mkdir(path.dirname(namesPath), { recursive: true });
  let source;
  try {
    for (const sorted of [true, false]) {
      source = await openSource();
      const input = nodeStream(source.body);
      const parser = extract.createDelegationExtractor(zone, {
        validateOrder: sorted,
        onProgress: (bytes) => onProgress({ zone, phase: "extracting", bytes }),
      });
      try {
        if (sorted)
          await pipeline(
            input,
            zlib.createGunzip(),
            parser,
            zlib.createGzip({ level: 1 }),
            fs.createWriteStream(snapshotPath + ".part"),
            { signal },
          );
        else {
          const { PassThrough } = require("node:stream");
          const ns = new PassThrough();
          const producer = pipeline(input, zlib.createGunzip(), parser, ns, {
            signal,
          });
          await Promise.all([
            producer,
            extract.streamSortedGzip({
              input: ns,
              outPath: snapshotPath + ".part",
              tmpDir: dir,
              signal,
            }),
          ]);
        }
        await fsp.rename(snapshotPath + ".part", snapshotPath);
        break;
      } catch (error) {
        input.destroy();
        if (!sorted || error.code !== "UNSORTED_ZONE") throw error;
      }
    }
    onProgress({ zone, phase: "counting" });
    const labels = await extract.snapshotNames({
      snapshotPath,
      outPath: namesPath,
      zone,
      signal,
    });
    const base = `${prefix}/runs/${day}/${runId}/${zone}/${crypto.randomUUID()}`;
    onProgress({ zone, phase: "persisting" });
    const snapshot = await store.putFile(
      base + "/delegations.gz",
      snapshotPath,
      "application/gzip",
      { signal },
    );
    const names = await store.putFile(
      base + "/names.gz",
      namesPath,
      "application/gzip",
      { signal },
    );
    const receipt = {
      tld: zone,
      labels,
      snapshot,
      names,
      observedAt: new Date().toISOString(),
      sourceLastModified: source.lastModified || null,
    };
    if (previous?.snapshot) {
      onProgress({ zone, phase: "diffing" });
      const priorPath = path.join(dir, "previous.gz");
      await restoreFile(store, previous.snapshot, priorPath, signal);
      const movementPath = path.join(dir, "movement.jsonl");
      const addsPath = path.join(dir, "adds.tsv"),
        dropsPath = path.join(dir, "drops.tsv");
      const streams = [movementPath, addsPath, dropsPath].map((file) =>
        fs.createWriteStream(file),
      );
      let ioError;
      for (const stream of streams)
        stream.on("error", (e) => {
          ioError = e;
        });
      let departures = 0,
        wentLive = 0,
        listed = 0;
      try {
        const counts = await diffZoneDelegations({
          prevPath: priorPath,
          todayPath: snapshotPath,
          zone,
          signal,
          onRow: async (row) => {
            if (signal?.aborted) throw signal.reason;
            if (ioError) throw ioError;
            if (row.kind === "added" || row.kind === "dropped") {
              const label = row.name.slice(0, -zone.length - 1);
              if (label && !label.includes("."))
                await writeLine(
                  streams[row.kind === "added" ? 1 : 2],
                  `${label}\t${zone}\t${previous.day}\n`,
                );
            }
            const selections = [];
            if (row.kind === "changed") {
              if (
                ["seller", "parking"].includes(row.prev.klass) &&
                ["hosting", "registrar", "other"].includes(row.today.klass)
              ) {
                selections.push("departures");
                departures++;
              }
              if (
                row.prev.klass !== "hosting" &&
                row.today.klass === "hosting"
              ) {
                selections.push("went-live");
                wentLive++;
              }
              if (
                !["seller", "parking"].includes(row.prev.klass) &&
                ["seller", "parking"].includes(row.today.klass)
              ) {
                selections.push("listed");
                listed++;
              }
            }
            for (const selection of selections)
              await writeLine(
                streams[0],
                JSON.stringify({
                  kind: row.kind,
                  domain: row.name,
                  prev_class: row.prev.klass,
                  today_class: row.today.klass,
                  prev_provider: row.prev.provider,
                  today_provider: row.today.provider,
                  prev_ns: row.prev.ns,
                  today_ns: row.today.ns,
                  selection,
                }) + "\n",
              );
            onProgress({
              zone,
              phase: "diffing",
              rows: departures + wentLive + listed,
            });
          },
        });
        await Promise.all(
          streams.map(
            (s) =>
              new Promise((resolve, reject) => {
                s.once("error", reject);
                s.end(resolve);
              }),
          ),
        );
        if (ioError) throw ioError;
        receipt.diff = {
          prevDay: previous.day,
          counts,
          departures,
          wentLive,
          listed,
          movement: await uploadMaybeEmpty(
            store,
            base + "/movement.jsonl",
            movementPath,
            signal,
          ),
          adds: await uploadMaybeEmpty(
            store,
            base + "/adds.tsv",
            addsPath,
            signal,
          ),
          drops: await uploadMaybeEmpty(
            store,
            base + "/drops.tsv",
            dropsPath,
            signal,
          ),
        };
      } finally {
        for (const stream of streams) stream.destroy();
      }
    }
    return receipt;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
async function uploadMaybeEmpty(store, key, file, signal) {
  if ((await fsp.stat(file)).size)
    return store.putFile(key, file, "text/plain", { signal });
  await store.put(key, Buffer.alloc(0), "text/plain");
  return {
    key,
    bytes: 0,
    sha256: crypto.createHash("sha256").update("").digest("hex"),
  };
}
module.exports = {
  PREFIX,
  getJson,
  putJson,
  restoreFile,
  captureZone,
  uploadMaybeEmpty,
};
