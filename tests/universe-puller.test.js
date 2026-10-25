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
  assert.equal(latest.movement.windowDays, 5);
  assert.equal(latest.movement.dailyComplete, false);
  assert.equal(latest.movement.retainsAllChangedDelegations, true);
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

test('a changed accessible inventory cannot leave obsolete scratch zones blocking recovery', async t => {
  const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  f.setSummaryFail(true); await assert.rejects(f.puller().runDay());
  delete f.source.net; f.setSummaryFail(false);
  const build=f.options.summary.buildUniverseSummaryTape;
  f.options.summary.buildUniverseSummaryTape=async options=>{
    assert.deepEqual(fs.readdirSync(options.namesDir).filter(n=>n.endsWith('.names.gz')),['com.names.gz']);
    return build(options);
  };
  assert.equal((await f.puller().retryIncomplete()).complete,true);
});

test('interrupted sort work is reclaimed without removing retained source evidence', async t => {
  const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const old=path.join(f.root,'scratch','2026-09-10');
  const current=path.join(f.root,'scratch','2026-09-11','zones','com');
  fs.mkdirSync(old,{recursive:true});fs.writeFileSync(path.join(old,'partial'),'partial');
  fs.mkdirSync(current,{recursive:true});fs.writeFileSync(path.join(current,'sort-orphan'),'partial');
  const unrelated=path.join(f.root,'scratch','retained-notes');fs.mkdirSync(unrelated);
  assert.equal((await f.puller().runDay()).complete,true);
  assert.equal(fs.existsSync(old),false);assert.equal(fs.existsSync(current),false);
  assert.equal(fs.existsSync(unrelated),true);
  assert.equal(JSON.parse(await f.store.get(PREFIX+'/latest.json')).zones.length,2);
});

test('recovery after local and pending receipt loss preserves immutable published artifacts', async t => {
  const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  await f.puller().runDay();
  const first=JSON.parse(await f.store.get(PREFIX+'/latest.json'));
  const key=`${PREFIX}/runs/${first.day}/${first.runId}/manifest.json`;
  const original=Buffer.from(await f.store.get(key));
  const downloads=f.calls.length;
  await fsp.rm(f.options.dataDir,{recursive:true});
  f.store.objects.delete(PREFIX+'/pending/'+first.day+'.json');
  assert.equal((await f.puller().runDay()).complete,true);
  const recovered=JSON.parse(await f.store.get(PREFIX+'/latest.json'));
  assert.notEqual(recovered.runId,first.runId);
  assert.deepEqual(await f.store.get(key),original);
  assert.equal(f.calls.length,downloads);
});

test('an upgraded summary projection reuses immutable zone receipts without redownloading sources', async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await f.puller().runDay();
  const before = JSON.parse((await f.store.get(PREFIX + '/latest.json')).toString());
  const calls = f.calls.length;
  f.options.summary.SUMMARY_PROJECTION_VERSION = 2;
  const build = f.options.summary.buildUniverseSummaryTape;
  f.options.summary.buildUniverseSummaryTape = async args => ({ ...await build(args), projectionVersion: 2 });
  await f.puller().retryIncomplete();
  const after = JSON.parse((await f.store.get(PREFIX + '/latest.json')).toString());
  assert.equal(f.calls.length, calls);
  assert.equal(after.summary.projectionVersion, 2);
  assert.notEqual(after.runId, before.runId);
  assert.equal(after.complete, true);
  assert.deepEqual(after.zones, before.zones);
});

test("complete consecutive snapshots retain ordinary changes and an unbuilt Afternic departure", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.source.com = "inferencevalley.com. 3600 IN NS ns1.afternic.com.\norchard.com. 3600 IN NS ns1.example.com.\n";
  await f.puller().runDay();
  f.setDay("2026-09-12");
  f.source.com = "inferencevalley.com. 3600 IN NS ns1.buyer.example.\norchard.com. 3600 IN NS ns2.example.com.\n";
  await f.puller().runDay();
  const latest = JSON.parse((await f.store.get(PREFIX + "/latest.json")).toString());
  assert.equal(latest.movement.dailyComplete, true);
  const rows=fs.readFileSync(path.join(f.root,"work/2026-09-12/ns/movement.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length,2);
  const lead=rows.find(r=>r.domain==='inferencevalley.com');
  assert.equal(lead.selection,'departures');
  assert.deepEqual(lead.prev_ns,['ns1.afternic.com']);
  assert.equal(lead.window_start,'2026-09-11');
  assert.equal(lead.window_end,'2026-09-12');
  assert.equal(rows.find(r=>r.domain==='orchard.com').selection,'changed');
});
test('cloud summary can remain durable without building a redundant local SQLite mirror', async t=>{
 const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));f.options.env.DOMAINSCOUT_UNIVERSE_MATERIALIZE_SUMMARY='0';let imports=0;f.options.summary.importUniverseSummaryTape=async()=>{imports++;};
 assert.equal((await f.puller().runDay()).complete,true);const m=JSON.parse((await f.store.get(PREFIX+'/latest.json')).toString());
 assert.equal(imports,0);assert.equal(m.summary.materializedLocally,false);assert.ok(m.outputs.summary.sha256);assert.ok(f.store.objects.has(m.outputs.summary.key));
 const {materialized}=require('../server/universe-puller');assert.equal(materialized(m,f.options.dataDir,f.options.universeDir,1,false),true);assert.equal(materialized(m,f.options.dataDir,f.options.universeDir,1,true),false);assert.equal((await f.puller().retryIncomplete()).skipped,'complete');
});
test('a corrupt streamed baseline never publishes a successful new day',async t=>{
 const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));await f.puller().runDay();const initial=JSON.parse((await f.store.get(PREFIX+'/latest.json')).toString());
 const key=`${PREFIX}/runs/${initial.day}/${initial.runId}/manifest.json`;const prior=JSON.parse((await f.store.get(key)).toString());prior.zones.find(z=>z.tld==='com').snapshot.sha256='0'.repeat(64);await f.store.put(key,JSON.stringify(prior));
 f.setDay('2026-09-12');const result=await f.puller().runDay();assert.equal(result.complete,false);assert.ok(result.health.alerts.some(x=>x.includes('Object integrity mismatch')), JSON.stringify(result.health.alerts));assert.equal(JSON.parse((await f.store.get(PREFIX+'/latest.json')).toString()).day,'2026-09-11');
});
test('low disk reserve stops bulk capture before downloads and preserves the prior published pointer',async t=>{
 const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));await f.puller().runDay();f.setDay('2026-09-12');f.options.freeSpaceBytes=()=>1024;f.options.env.DOMAINSCOUT_UNIVERSE_MIN_FREE_BYTES='2048';const before=f.calls.length;
 await assert.rejects(f.puller().runDay(),/preserve disk reserve/);assert.equal(f.calls.length,before);assert.equal(JSON.parse((await f.store.get(PREFIX+'/latest.json')).toString()).day,'2026-09-11');
});

test('capture retains a removed seller delegation with its before nameservers and no invented destination',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'zone-removed-capture-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const store=memoryStore(),before=zlib.gzipSync('inferencevalley.com. 1 IN NS ns1.afternic.com.\norchard.com. 1 IN NS ns1.example.test.\n'),key=PREFIX+'/fixture/before.gz';await store.put(key,before);const snapshot={key,bytes:before.length,sha256:crypto.createHash('sha256').update(before).digest('hex')};const {captureZone}=require('../server/universe-snapshots');const result=await captureZone({store,runId:'fixture',day:'2026-10-24',zone:'com',scratch:root,previous:{day:'2026-10-23',snapshot},openSource:async()=>({body:Readable.from([zlib.gzipSync('orchard.com. 1 IN NS ns1.example.test.\n')])})});assert.equal(result.diff.counts.dropped,1);assert.equal(result.diff.retainsAllRemovedDelegations,true);const rows=store.objects.get(result.diff.movement.key).toString().trim().split('\n').map(JSON.parse);assert.equal(rows.length,1);assert.equal(rows[0].kind,'dropped');assert.deepEqual(rows[0].prev_ns,['ns1.afternic.com']);assert.deepEqual(rows[0].today_ns,[]);assert.equal(rows[0].today_class,null);assert.equal(rows[0].selection,'delegation-removed');
});
test('historical removal recovery verifies the full baseline and every declared removed name',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'zone-removal-recover-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const store=memoryStore();const put=async(key,bytes)=>{await store.put(key,bytes);return{key,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}};const snapshot=await put('before.gz',zlib.gzipSync('inferencevalley.com. 1 IN NS ns1.afternic.com.\norchard.com. 1 IN NS ns1.example.test.\n'));const drops=await put('drops.tsv',Buffer.from('inferencevalley\tcom\t2026-10-23\n'));const {recoverRemovedDelegations}=require('../server/movement-removal-recovery');const options={store,zone:'com',day:'2026-10-24',prevDay:'2026-10-23',drops,baselineSnapshot:snapshot,expectedDropped:1,outPath:path.join(root,'removed.jsonl')};const r=await recoverRemovedDelegations(options);assert.equal(r.removed,1);assert.equal(r.baselineNamesVisited,2);assert.equal(r.sellerOrParking,1);const row=JSON.parse(await fsp.readFile(r.path,'utf8'));assert.equal(row.kind,'dropped');assert.deepEqual(row.prev_ns,['ns1.afternic.com']);assert.deepEqual(row.today_ns,[]);const badPath=path.join(root,'corrupt.jsonl');await assert.rejects(recoverRemovedDelegations({...options,outPath:badPath,baselineSnapshot:{...snapshot,sha256:'0'.repeat(64)}}),/integrity mismatch/);assert.equal(fs.existsSync(badPath),false);assert.equal(fs.existsSync(badPath+'.part'),false);await assert.rejects(recoverRemovedDelegations({...options,outPath:path.join(root,'missing.jsonl'),expectedDropped:2}),/count mismatch/);
});

test('snapshot recovery retains additional label levels omitted from a legacy drop list',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'zone-removal-levels-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const store=memoryStore(),put=async(key,text)=>{const bytes=zlib.gzipSync(text);await store.put(key,bytes);return {key,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}};
 const baselineSnapshot=await put('before.gz','ai.community.name. 1 IN NS ns1.afternic.com.\norchard.name. 1 IN NS ns1.example.test.\n'),currentSnapshot=await put('after.gz','orchard.name. 1 IN NS ns1.example.test.\n'),{recoverRemovedDelegations}=require('../server/movement-removal-recovery');const opts={store,zone:'name',day:'2026-10-24',prevDay:'2026-10-21',baselineSnapshot,currentSnapshot,expectedDropped:1,outPath:path.join(root,'removed.jsonl')},r=await recoverRemovedDelegations(opts);assert.equal(r.removed,1);const row=JSON.parse(fs.readFileSync(r.path));assert.equal(row.domain,'ai.community.name');assert.deepEqual(row.prev_ns,['ns1.afternic.com']);assert.deepEqual(row.today_ns,[]);await assert.rejects(recoverRemovedDelegations({...opts,outPath:path.join(root,'corrupt.jsonl'),currentSnapshot:{...currentSnapshot,sha256:'0'.repeat(64)}}),/integrity mismatch/);
});


test("daily health distinguishes a manual capture from configured UTC automation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "universe-readiness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "universe"), { recursive: true });
  const healthFile = path.join(dataDir, "universe", "health.json");
  fs.writeFileSync(healthFile, JSON.stringify({ status: "ok", lastCompleteDay: "2026-10-24" }));
  const env = {};
  const options = { dataDir, universeDir: path.join(root, "work"), env,
    now: () => new Date("2026-10-25T06:59:00Z"), objectStore: null };
  let h = await createUniversePuller(options).health();
  assert.equal(h.status, "ok");
  assert.equal(h.automation.lastCaptureCurrent, true);
  assert.equal(h.automation.ready, false);
  assert.deepEqual(h.automation.boundaries, ["scheduled_collection_disabled", "registry_credentials_missing", "archive_storage_missing"]);
  env.DOMAINSCOUT_UNIVERSE_PULL_ENABLED = "1";
  env.CZDS_USER = "private-user"; env.CZDS_PASS = "private-password";
  h = await createUniversePuller({ ...options, objectStore: memoryStore() }).health();
  assert.equal(h.automation.ready, true);
  assert.equal(h.automation.timezone, "UTC");
  assert.equal(h.automation.schedule, "5 7 * * *");
  assert.equal(JSON.stringify(h).includes("private-"), false);
  h = await createUniversePuller({ ...options, objectStore: memoryStore(), now: () => new Date("2026-10-25T07:05:00Z") }).health();
  assert.equal(h.automation.configurationReady, true);
  assert.equal(h.automation.ready, false);
  assert.equal(h.automation.expectedSourceDay, "2026-10-25");
  assert.deepEqual(h.automation.boundaries, ["current_source_day_not_complete"]);
  fs.writeFileSync(healthFile, JSON.stringify({ status: "incomplete", lastCompleteDay: "2026-10-24" }));
  h = await createUniversePuller({ ...options, objectStore: memoryStore() }).health();
  assert.equal(h.automation.ready, false);
});

test('streaming capture replays verified archive bytes without a local delegation snapshot', async t => {
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'zone-streamed-capture-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 const store=memoryStore(),zoneDir=path.join(root,'zones','com');let streamed=0,replays=0;
 store.putStream=async function(key,input){const chunks=[];for await(const chunk of input){assert.equal(fs.existsSync(path.join(zoneDir,'snapshot.gz.part')),false);chunks.push(Buffer.from(chunk));}const body=Buffer.concat(chunks);this.objects.set(key,body);streamed++;return {key,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')};};
 const getStream=store.getStream;store.getStream=async function(...args){replays++;return getStream.apply(this,args);};
 const before=zlib.gzipSync('inferencevalley.com. 1 IN NS ns1.afternic.com.\norchard.com. 1 IN NS ns1.example.test.\n'),key=PREFIX+'/fixture/streamed-before.gz';await store.put(key,before);
 const snapshot={key,bytes:before.length,sha256:crypto.createHash('sha256').update(before).digest('hex')};
 const result=await require('../server/universe-snapshots').captureZone({store,runId:'fixture',day:'2026-10-24',zone:'com',scratch:root,previous:{day:'2026-10-23',snapshot},openSource:async()=>({body:Readable.from([zlib.gzipSync('orchard.com. 1 IN NS ns2.example.test.\n')])})});
 assert.equal(streamed,1);assert.equal(replays,3);assert.equal(result.labels,1);assert.equal(result.diff.counts.dropped,1);assert.equal(result.diff.counts.changed,1);assert.equal(fs.existsSync(zoneDir),false);
 const rows=store.objects.get(result.diff.movement.key).toString().trim().split('\n').map(JSON.parse);assert.ok(rows.some(r=>r.domain==='inferencevalley.com'&&r.kind==='dropped'&&r.prev_ns[0]==='ns1.afternic.com'&&r.today_ns.length===0));
});

test('streamed snapshot corruption cannot return a successful zone receipt',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'zone-streamed-corruption-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const store=memoryStore();
 store.putStream=async function(key,input){const chunks=[];for await(const c of input)chunks.push(c);const body=Buffer.concat(chunks);this.objects.set(key,Buffer.concat([body,Buffer.from('corrupt')]));return {key,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')};};
 await assert.rejects(require('../server/universe-snapshots').captureZone({store,runId:'fixture',day:'2026-10-24',zone:'com',scratch:root,openSource:async()=>({body:Readable.from([zlib.gzipSync('orchard.com. 1 IN NS ns1.example.test.\n')])})}),/integrity|incorrect|gzip|header|unexpected/i);
 assert.equal(fs.existsSync(path.join(root,'zones','com')),false);
});

test('unsorted input retains the existing guarded sort fallback with a streaming-capable store',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'zone-streamed-sort-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const store=memoryStore();let opens=0,streamAttempts=0;
 store.putStream=async function(key,input){streamAttempts++;for await(const c of input){}throw Error('An unsorted source must not complete its first upload');};
 const result=await require('../server/universe-snapshots').captureZone({store,runId:'fixture',day:'2026-10-24',zone:'com',scratch:root,openSource:async()=>{opens++;return {body:Readable.from([zlib.gzipSync('zebra.com. 1 IN NS ns1.example.test.\napple.com. 1 IN NS ns1.example.test.\n')])};}});
 assert.equal(opens,2);assert.equal(streamAttempts,1);assert.equal(result.labels,2);assert.equal(fs.existsSync(path.join(root,'zones','com')),false);
});

test('a corrupt second replay cannot publish a movement tape after names were extracted',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'zone-streamed-late-corruption-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const store=memoryStore();let currentReads=0;
 store.putStream=async function(key,input){const chunks=[];for await(const c of input)chunks.push(c);const body=Buffer.concat(chunks);this.objects.set(key,body);return {key,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')};};
 const getStream=store.getStream;store.getStream=async function(key){if(key.endsWith('/delegations.gz')&&++currentReads===2)return Readable.from([Buffer.concat([this.objects.get(key),Buffer.from('corrupt')])]);return getStream.call(this,key);};
 const body=zlib.gzipSync('orchard.com. 1 IN NS ns1.afternic.com.\n'),key=PREFIX+'/fixture/late-before.gz';await store.put(key,body);const previous={day:'2026-10-23',snapshot:{key,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')}};
 await assert.rejects(require('../server/universe-snapshots').captureZone({store,runId:'fixture',day:'2026-10-24',zone:'com',scratch:root,previous,openSource:async()=>({body:Readable.from([zlib.gzipSync('orchard.com. 1 IN NS ns2.example.test.\n')])})}),/integrity|incorrect|gzip|header|unexpected/i);
 assert.equal(currentReads,2);assert.equal([...store.objects.keys()].some(k=>k.endsWith('/movement.jsonl')),false);
});

test('failed current-snapshot GET closes the already opened baseline stream',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'zone-replay-get-failed-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const store=memoryStore();let reads=0,prior;
 store.putStream=async function(key,input){const chunks=[];for await(const c of input)chunks.push(c);const body=Buffer.concat(chunks);this.objects.set(key,body);return {key,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')};};
 const getStream=store.getStream;store.getStream=async function(key){if(key.endsWith('/delegations.gz')&&++reads===2)throw Error('current replay GET failed');const stream=await getStream.call(this,key);if(key.endsWith('/before.gz'))prior=stream;return stream;};
 const body=zlib.gzipSync('orchard.com. 1 IN NS ns1.afternic.com.\n'),key=PREFIX+'/fixture/before.gz';await store.put(key,body);const previous={day:'2026-10-23',snapshot:{key,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')}};
 await assert.rejects(require('../server/universe-snapshots').captureZone({store,runId:'fixture',day:'2026-10-24',zone:'com',scratch:root,previous,openSource:async()=>({body:Readable.from([zlib.gzipSync('orchard.com. 1 IN NS ns2.example.test.\n')])})}),/current replay GET failed/);assert.equal(prior.destroyed,true);
});

test('an unread verified response retains a network error for its eventual consumer',async()=>{
 const source=new(require('node:stream').PassThrough)(),store={getStream:async()=>source};
 const checked=await require('../server/universe-snapshots').verifiedObjectStream(store,{key:'fixture',bytes:1,sha256:'a'.repeat(64)});
 source.destroy(Error('network response failed'));await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(async()=>{for await(const chunk of checked){}},/network response failed/);assert.equal(source.destroyed,true);
});
