"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { pipeline, finished } = require("node:stream/promises");
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
// A long archive read can lose its connection mid-body (the object service
// closes the response; Node reports "aborted"). When the store can read from an
// offset, continue from the last verified byte instead of failing the caller:
// the digest still covers every byte exactly once, so a resumed read is as
// strict as an uninterrupted one. Each resume must follow progress; a store
// that keeps failing at the same offset is a real failure.
const RESUME_LIMIT = 4;
const RESUME_DELAYS_MS = [1000, 5000, 15000, 30000];
async function verifiedObjectStream(store, receipt, signal, { resumeDelaysMs = RESUME_DELAYS_MS, onResume = () => {} } = {}) {
  const resumable = store.resumableReads === true;
  let failure = null;
  const open = async (start) => {
    const stream = nodeStream(await store.getStream(receipt.key, start ? { signal, start } : { signal }));
    failure = null;
    // Keep an early failure for the consumer instead of an unhandled event.
    stream.on('error', error => { failure = failure || error; });
    return stream;
  };
  let source = await open(0);
  // Validate EOF before exposing successful stream completion. A detached pipe
  // can otherwise turn a late digest error into an incidental premature-close.
  const checked = Readable.from((async function* () {
    const hash = crypto.createHash("sha256");
    let bytes = 0, stalled = 0;
    try {
      for (;;) {
        const before = bytes;
        let error = null;
        try {
          for await (const chunk of source) { hash.update(chunk); bytes += chunk.length; yield chunk; }
          error = failure;
        } catch (e) { error = e; }
        // Every expected byte arrived: the digest below is the verdict.
        if (bytes >= receipt.bytes && (!error || resumable)) break;
        // A response that ends early without an error is the same dropped connection.
        if (!resumable || signal?.aborted || bytes > receipt.bytes) { if (error) throw error; break; }
        stalled = bytes > before ? 0 : stalled + 1;
        if (stalled >= RESUME_LIMIT) throw error || Error("Object read ended early: " + receipt.key);
        source.destroy();
        onResume({ key: receipt.key, bytes, error: error?.message || "ended early" });
        const wait = resumeDelaysMs[Math.min(stalled, resumeDelaysMs.length - 1)] || 0;
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        if (signal?.aborted) throw signal.reason || error || Error("aborted");
        try { source = await open(bytes); }
        catch (e) { if (signal?.aborted) throw e; failure = e; source = Readable.from([]); }
      }
      if (hash.digest("hex") !== receipt.sha256 || bytes !== receipt.bytes)
        throw Error("Object integrity mismatch: " + receipt.key);
    } finally { source.destroy(); }
  })(), { objectMode: false });
  // Destroy must close the response even if the lazy generator never started.
  checked.once('close', () => source.destroy());
  if (!resumable) source.on('error', error => checked.destroy(error));
  // Retain the error state for the eventual consumer without an unhandled
  // event while a caller is acquiring another response for a merge.
  checked.on('error', () => {});
  if (signal) require('node:stream').addAbortSignal(signal, checked);
  return checked;
}
async function restoreFile(store, receipt, file, signal) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const part = file + ".part";
  try {
    await pipeline(await verifiedObjectStream(store, receipt, signal), fs.createWriteStream(part), { signal });
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
  resume = null,
  onPartial = null,
}) {
  // A zone whose snapshot and names already reached the archive (an earlier
  // attempt, or another capture host) continues from those objects: only the
  // comparison with the previous day is left, and nothing is uploaded twice.
  const resumed = isCapturedSource(resume, zone) ? resume : null;
  const dir = path.join(scratch, "zones", zone);
  // Only this zone's disposable workspace; persisted receipts live in S3.
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const snapshotPath = path.join(dir, "snapshot.gz"),
    namesPath = path.join(scratch, "names", `${zone}.names.gz`);
  await fsp.mkdir(path.dirname(namesPath), { recursive: true });
  const base = `${prefix}/runs/${day}/${runId}/${zone}/${crypto.randomUUID()}`;
  let source = resumed ? { lastModified: resumed.sourceLastModified || null } : undefined,
    snapshot = resumed?.snapshot,
    streamedSnapshot = !!resumed;
  try {
    for (const sorted of resumed ? [] : [true, false]) {
      source = await openSource();
      const input = nodeStream(source.body);
      const parser = extract.createDelegationExtractor(zone, {
        validateOrder: sorted,
        onProgress: (bytes) => onProgress({ zone, phase: "extracting", bytes }),
      });
      try {
        if (sorted && store.putStream) {
          const compressed = new (require("node:stream").PassThrough)();
          const producing = pipeline(input, zlib.createGunzip(), parser, zlib.createGzip({ level: 1 }), compressed, { signal });
          const uploading = store.putStream(base + "/delegations.gz", compressed, "application/gzip", { signal });
          const jobs = [producing, uploading];
          try {
            const results = await Promise.all(jobs);
            snapshot = results[1]; streamedSnapshot = true;
          } catch (error) {
            input.destroy(error); compressed.destroy(error);
            await Promise.allSettled(jobs); throw error;
          }
        } else if (sorted) {
          await pipeline(input, zlib.createGunzip(), parser, zlib.createGzip({ level: 1 }), fs.createWriteStream(snapshotPath + ".part"), { signal });
        } else {
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
        if (!streamedSnapshot) await fsp.rename(snapshotPath + ".part", snapshotPath);
        break;
      } catch (error) {
        input.destroy();
        if (!sorted || error.code !== "UNSORTED_ZONE") throw error;
      }
    }
    let labels = resumed?.labels,
      names = resumed?.names,
      observedAt = resumed?.observedAt;
    if (!resumed) {
      onProgress({ zone, phase: "counting" });
      labels = await extract.snapshotNames({
        snapshotPath: streamedSnapshot ? await verifiedObjectStream(store, snapshot, signal) : snapshotPath,
        outPath: namesPath,
        tmpDir: dir,
        zone,
        signal,
      });
      onProgress({ zone, phase: "persisting" });
      snapshot = snapshot || await store.putFile(
        base + "/delegations.gz",
        snapshotPath,
        "application/gzip",
        { signal },
      );
      names = await store.putFile(
        base + "/names.gz",
        namesPath,
        "application/gzip",
        { signal },
      );
      observedAt = new Date().toISOString();
      // The source is now durable. Tell the caller before the long comparison
      // so a failure there never repeats the download or the uploads.
      if (onPartial)
        await onPartial({ tld: zone, labels, snapshot, names, observedAt, sourceLastModified: source.lastModified || null });
    }
    const receipt = {
      tld: zone,
      labels,
      snapshot,
      names,
      observedAt,
      sourceLastModified: source.lastModified || null,
    };
    if (previous?.snapshot) {
      onProgress({ zone, phase: "diffing" });
      // Merge directly against the verified immutable object; do not duplicate
      // a multi-gigabyte baseline on the collector disk.
      const priorSource = await verifiedObjectStream(store, previous.snapshot, signal);
      let todaySource = null;
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
        todaySource = streamedSnapshot ? await verifiedObjectStream(store, snapshot, signal) : null;
        const counts = await diffZoneDelegations({
          prevPath: priorSource,
          todayPath: todaySource || snapshotPath,
          zone,
          signal,
          onRow: async (row) => {
            if (signal?.aborted) throw signal.reason;
            if (ioError) throw ioError;
            if (row.kind === "added" || row.kind === "dropped") {
              const label = row.name.slice(0, -zone.length - 1);
              if (label)
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
            // Retain every changed delegation, including migration/expiry counterevidence.
            // Existing selections remain compatible with downstream departure readers.
            if (row.kind === 'changed' && !selections.length) selections.push('changed');
            if (row.kind === 'dropped') selections.push('delegation-removed');
            for (const selection of selections)
              await writeLine(
                streams[0],
                JSON.stringify({
                  kind: row.kind,
                  window_start: previous.day,
                  window_end: day,
                  domain: row.name,
                  prev_class: row.prev.klass,
                  today_class: row.today?.klass ?? null,
                  prev_provider: row.prev.provider,
                  today_provider: row.today?.provider ?? null,
                  prev_ns: row.prev.ns,
                  today_ns: row.today?.ns || [],
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
          retainsAllRemovedDelegations: true,
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
        priorSource.destroy();
        todaySource?.destroy();
        for (const stream of streams) stream.destroy();
        await Promise.all(streams.map(stream => finished(stream).catch(() => {})));
      }
    }
    return receipt;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
const storedObject = (o) =>
  !!o && typeof o.key === "string" && !!o.key && Number.isSafeInteger(o.bytes) && o.bytes >= 0 && /^[0-9a-f]{64}$/.test(o.sha256 || "");
function isCapturedSource(value, zone) {
  return !!value && value.tld === zone && Number.isSafeInteger(value.labels) && value.labels >= 0 &&
    storedObject(value.snapshot) && storedObject(value.names) && typeof value.observedAt === "string";
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
  verifiedObjectStream,
  PREFIX,
  getJson,
  putJson,
  restoreFile,
  captureZone,
  isCapturedSource,
  uploadMaybeEmpty,
};
