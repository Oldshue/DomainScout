"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  fsp = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  zlib = require("node:zlib"),
  crypto = require("node:crypto");
const { Readable } = require("node:stream");
const {
  createUniversePuller,
  expectedDay,
} = require("../server/universe-puller");
const { PREFIX } = require("../server/universe-snapshots");
function memoryStore() {
  const objects = new Map();
  return {
    objects,
    get: async (key) => {
      if (!objects.has(key))
        throw Object.assign(Error("missing"), { code: "ENOENT" });
      return objects.get(key);
    },
    put: async (key, body) => objects.set(key, Buffer.from(body)),
    getStream: async function (key) {
      return Readable.from(await this.get(key));
    },
    putFile: async function (key, file) {
      const body = await fsp.readFile(file);
      objects.set(key, body);
      return {
        key,
        bytes: body.length,
        sha256: crypto.createHash("sha256").update(body).digest("hex"),
      };
    },
  };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zone-recovery-"));
  let day = "2026-09-11",
    fail = null,
    summaryFail = false;
  const calls = [];
  const store = memoryStore();
  const source = {
    com: "alpha.com. 3600 IN NS ns1.dan.com.\nbeta.com. 3600 IN NS ns1.example.com.\n",
    net: "orchard.net. 3600 IN NS ns1.example.net.\n",
  };
  const env = {
    CZDS_USER: "u",
    CZDS_PASS: "p",
    DOMAINSCOUT_UNIVERSE_PULL_CONCURRENCY: "1",
    DOMAINSCOUT_UNIVERSE_SCRATCH_DIR: path.join(root, "scratch"),
  };
  const options = {
    dataDir: path.join(root, "data"),
    universeDir: path.join(root, "work"),
    env,
    objectStore: store,
    now: () => new Date(day + "T12:00:00Z"),
    log: { log() {}, error() {} },
    fetchImpl: async (url) => {
      if (url.includes("authenticate"))
        return { ok: true, json: async () => ({ accessToken: "fixture" }) };
      if (url.endsWith("/links"))
        return {
          ok: true,
          json: async () =>
            Object.keys(source).map(
              (z) => `https://czds-api.icann.org/czds/downloads/${z}.zone`,
            ),
        };
      const zone = path.basename(url, ".zone");
      calls.push(zone);
      if (zone === fail) return { ok: false, status: 503 };
      return { ok: true, body: Readable.from(zlib.gzipSync(source[zone])) };
    },
    summary: {
      buildUniverseSummaryTape: async ({ outDir, day }) => {
        if (summaryFail) throw Error("summary unavailable");
        await fsp.mkdir(outDir, { recursive: true });
        const tapePath = path.join(outDir, "summary.gz");
        await fsp.writeFile(tapePath, zlib.gzipSync("fixture"));
        return { tapePath, zones: Object.keys(source).length };
      },
      importUniverseSummaryTape: async () => {},
    },
  };
  return {
    root,
    store,
    source,
    calls,
    options,
    puller: () => createUniversePuller(options),
    setDay: (d) => (day = d),
    setFail: (z) => (fail = z),
    setSummaryFail: (v) => (summaryFail = v),
  };
}
test("complete cloud chain writes real movement, registration tape and durable source receipts", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  assert.equal((await f.puller().runDay()).complete, true);
  const initial = JSON.parse(
    (await f.store.get(PREFIX + "/latest.json")).toString(),
  );
  assert.equal(initial.movement.baseline, true);
  assert.equal(initial.movement.departures, 0);
  f.setDay("2026-09-16");
  f.source.com =
    "alpha.com. 3600 IN NS ns1.hosting.example.\ngamma.com. 3600 IN NS ns1.example.com.\n";
  assert.equal((await f.puller().runDay()).complete, true);
  const latest = JSON.parse(
    (await f.store.get(PREFIX + "/latest.json")).toString(),
  );
  assert.equal(latest.movement.prevDay, "2026-09-11");
  assert.equal(latest.movement.departures, 1);
  assert.equal(latest.movement.comparedZones, 2);
  const rows = fs
    .readFileSync(
      path.join(f.root, "work/2026-09-16/ns/movement.jsonl"),
      "utf8",
    )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows[0].domain, "alpha.com");
  assert.deepEqual(rows[0].prev_ns, ["ns1.dan.com"]);
  assert.match(
    fs.readFileSync(path.join(f.root, "work/2026-09-16/tape/adds.tsv"), "utf8"),
    /gamma\tcom\t2026-09-11/,
  );
});
test("failed zone does not publish and a restarted process downloads only unfinished zones", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.setFail("net");
  assert.equal((await f.puller().runDay()).complete, false);
  assert.equal(f.store.objects.has(PREFIX + "/latest.json"), false);
  assert.equal(f.calls.filter((z) => z === "com").length, 1);
  f.setFail(null);
  assert.equal((await f.puller().retryIncomplete()).complete, true);
  assert.equal(f.calls.filter((z) => z === "com").length, 1);
  assert.equal(f.calls.filter((z) => z === "net").length, 4);
});
test("downstream failure stays incomplete and retries finalization without downloading again", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.setSummaryFail(true);
  await assert.rejects(f.puller().runDay(), /summary unavailable/);
  assert.equal(f.store.objects.has(PREFIX + "/latest.json"), false);
  const before = f.calls.length;
  f.setSummaryFail(false);
  assert.equal((await f.puller().retryIncomplete()).complete, true);
  assert.equal(f.calls.length, before);
});
test("lost local checkpoint restores captured sources from object storage", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.setFail("net");
  await f.puller().runDay();
  await fsp.rm(f.options.dataDir, { recursive: true });
  await fsp.rm(path.join(f.root, "scratch"), { recursive: true });
  f.setFail(null);
  await f.puller().retryIncomplete();
  assert.equal(f.calls.filter((z) => z === "com").length, 1);
});
test("digest mismatch prevents publishing corrupt evidence", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.setSummaryFail(true);
  await assert.rejects(f.puller().runDay());
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(f.options.dataDir, "universe/pull/2026-09-11.json"),
    ),
  );
  f.store.objects.set(manifest.zones[0].names.key, Buffer.from("corrupted"));
  f.setSummaryFail(false);
  await assert.rejects(f.puller().retryIncomplete(), /integrity/);
  assert.equal(f.store.objects.has(PREFIX + "/latest.json"), false);
});
test("concurrent force does not bypass active run and past dates cannot fetch present data", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const p = f.puller(),
    first = p.runDay();
  assert.deepEqual(await p.runDay({ force: true }), { skipped: "running" });
  await first;
  await assert.rejects(p.runDay({ day: "2026-09-09" }), /historical/);
});
test("startup before source rollover resumes yesterday rather than waiting all night", () => {
  assert.equal(expectedDay(new Date("2026-09-16T02:00:00Z")), "2026-09-15");
  assert.equal(expectedDay(new Date("2026-09-16T07:00:00Z")), "2026-09-16");
});
module.exports = { memoryStore };

test("unordered whitespace/case-varied zones are canonicalized before comparing", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.source.com =
    "zebra.com. 3600 IN NS B.NS.EXAMPLE.\nalpha.com. 3600 IN NS A.NS.EXAMPLE.\n";
  await f.puller().runDay();
  const latest = JSON.parse(
    (await f.store.get(PREFIX + "/latest.json")).toString(),
  );
  const names = zlib
    .gunzipSync(
      await f.store.get(latest.zones.find((r) => r.tld === "com").names.key),
    )
    .toString();
  assert.equal(names, "alpha\nzebra\n");
});

test(
  "a stalled compressed source is aborted and never produces a receipt",
  { timeout: 3000 },
  async (t) => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("source deadline")),
      30,
    );
    try {
      await assert.rejects(
        require("../server/universe-snapshots").captureZone({
          store: f.store,
          day: "2026-09-11",
          runId: "stalled",
          zone: "com",
          scratch: f.root,
          signal: controller.signal,
          openSource: async () => ({ body: new Readable({ read() {} }) }),
        }),
        /abort/i,
      );
      assert.equal(f.store.objects.size, 0);
    } finally {
      clearTimeout(timer);
    }
  },
);

test("a missing bound baseline fails closed instead of silently resetting history", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await f.puller().runDay();
  const baseline = JSON.parse(await f.store.get(PREFIX + "/latest.json"));
  f.store.objects.delete(
    `${PREFIX}/runs/${baseline.day}/${baseline.runId}/manifest.json`,
  );
  f.setDay("2026-09-12");
  await assert.rejects(f.puller().runDay(), /baseline is missing/);
  assert.equal(
    JSON.parse(await f.store.get(PREFIX + "/latest.json")).day,
    "2026-09-11",
  );
});

test('suffix removal re-sorts label prefixes before the all-zone summary merge', async t => {
  const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  f.source.com='a-b.com. 3600 IN NS ns.example.com.\na.com. 3600 IN NS ns.example.com.\n';
  await f.puller().runDay();
  const latest=JSON.parse(await f.store.get(PREFIX+'/latest.json'));
  assert.equal(zlib.gunzipSync(await f.store.get(latest.zones.find(r=>r.tld==='com').names.key)).toString(),'a\na-b\n');
});
