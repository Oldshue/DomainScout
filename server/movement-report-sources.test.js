'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{Readable}=require('node:stream');
const {prepareMovementReportSources}=require('./movement-report-sources'),{PREFIX}=require('./universe-snapshots');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'movement-archive-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const objects=new Map(),streams=[];
 const manifest=(day,previousDay)=>{const runId='fixture-'+day,previousKey=previousDay?`${PREFIX}/runs/${previousDay}/fixture-${previousDay}/manifest.json`:undefined;const data=Buffer.from(JSON.stringify({domain:'orchard.test',prev_ns:['old.test'],today_ns:['new.test'],day})+'\n'),key=`${PREFIX}/runs/${day}/${runId}/test/movement.jsonl`;objects.set(key,data);const m={schema:'domainscout.zone-universe/v2',day,runId,previousKey,complete:true,inventory:['test'],failed:[],finishedAt:day+'T15:00:00Z',zones:[{tld:'test',observedAt:day+'T14:00:00Z',sourceLastModified:day+'T01:00:00Z',...(previousDay?{diff:{prevDay:previousDay,counts:{changed:1},movement:{key,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')}}}:{})}]};objects.set(`${PREFIX}/runs/${day}/${runId}/manifest.json`,Buffer.from(JSON.stringify(m)));return m;};
 manifest('2026-10-20');manifest('2026-10-21','2026-10-20');const latest=manifest('2026-10-24','2026-10-21');objects.set(PREFIX+'/latest.json',Buffer.from(JSON.stringify(latest)));
 const store={async get(key){if(!objects.has(key))throw Object.assign(Error('Missing'),{code:'ENOENT'});return objects.get(key)},async getStream(key){streams.push(key);if(!objects.has(key))throw Error('Object unavailable');return Readable.from([objects.get(key)])}};
 return {root,objects,streams,store,latest,options:{store,cacheDir:root,from:'2026-10-21',through:'2026-10-24'}};
}
test('discovers completed archive lineage, preserves missing dates and binds baseline source times',async t=>{
 const f=fixture(t),r=await prepareMovementReportSources(f.options);assert.equal(r.movementTapeInputs.length,2);assert.equal(r.manifestPaths.length,2);assert.deepEqual(r.receipt.missingDays,['2026-10-22','2026-10-23']);assert.equal(r.receipt.downloaded,2);assert.equal(r.receipt.archiveManifests.length,3);const latest=r.movementTapeInputs[0];assert.equal(latest.prevDay,'2026-10-21');assert.equal(latest.baselineAsOf,'2026-10-21T01:00:00.000Z');assert.equal(latest.accessScope,'organization-internal');assert.equal(latest.expectedChanged,1);
});
test('reuses verified files and repairs corrupt cache bytes instead of trusting existence',async t=>{
 const f=fixture(t),first=await prepareMovementReportSources(f.options);const second=await prepareMovementReportSources(f.options);assert.equal(second.receipt.downloaded,0);assert.equal(second.receipt.reused,2);fs.writeFileSync(first.movementTapeInputs[0].path,'corrupt');const third=await prepareMovementReportSources(f.options);assert.equal(third.receipt.downloaded,1);assert.equal(third.receipt.reused,1);assert.equal(f.streams.length,3);
});
test('adopts existing verified receipt files without moving or redownloading evidence',async t=>{
 const f=fixture(t),first=await prepareMovementReportSources(f.options),cacheDir=path.join(f.root,'another-cache');const r=await prepareMovementReportSources({...f.options,cacheDir,existingInputs:first.movementTapeInputs});assert.equal(r.receipt.downloaded,0);assert.equal(r.receipt.reused,2);assert.equal(r.movementTapeInputs[0].path,first.movementTapeInputs[0].path);assert.equal(f.streams.length,2);
});
test('rejects partial, failed and inventory-incomplete captures rather than consuming a false latest',async t=>{
 for(const patch of [{complete:false},{failed:['test']},{inventory:['test','missing']}]){const f=fixture(t);f.objects.set(PREFIX+'/latest.json',Buffer.from(JSON.stringify({...f.latest,...patch})));await assert.rejects(prepareMovementReportSources(f.options),/not complete/);assert.equal(f.streams.length,0);}
});
test('broken archive cursors and missing baselines fail closed',async t=>{
 const f=fixture(t);f.objects.set(PREFIX+'/latest.json',Buffer.from(JSON.stringify({...f.latest,previousKey:`${PREFIX}/runs/2026-10-24/fixture-2026-10-24/manifest.json`})));await assert.rejects(prepareMovementReportSources(f.options),/earlier|repeated/);f.objects.delete(f.latest.previousKey);f.objects.set(PREFIX+'/latest.json',Buffer.from(JSON.stringify(f.latest)));await assert.rejects(prepareMovementReportSources(f.options),/baseline manifest is missing/);
});
test('corrupt object streams are never admitted and leave no partial cache file',async t=>{
 const f=fixture(t),key=f.latest.zones[0].diff.movement.key;f.objects.set(key,Buffer.from('wrong bytes'));await assert.rejects(prepareMovementReportSources(f.options),/integrity mismatch/);assert.equal(fs.readdirSync(f.root).some(x=>x.endsWith('.part')||x.endsWith('.jsonl')),false);
});
test('an empty archive writes an explicit whole-window missing-date receipt',async t=>{
 const f=fixture(t);f.objects.clear();const r=await prepareMovementReportSources(f.options);assert.equal(r.receipt.tapes,0);assert.equal(r.receipt.missingDays.length,4);
});
test('captures that finished before a rolling window remain coverage evidence without importing older movements',async t=>{
 const f=fixture(t),r=await prepareMovementReportSources({...f.options,windowStartUtc:'2026-10-21T18:00:00Z'});assert.equal(r.manifestPaths.length,2);assert.equal(r.movementTapeInputs.length,1);assert.deepEqual(r.receipt.capturesBeforeWindow,['2026-10-21']);assert.equal(r.receipt.downloaded,1);assert.equal(r.movementTapeInputs[0].baselineAsOf,'2026-10-21T01:00:00.000Z');
});

const {amendmentPrefix,publishRemovalBackfill}=require('./capture-amendments');
function amendmentFixture(t){
 const f=fixture(t),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 const baseline=JSON.parse(f.objects.get(f.latest.previousKey));baseline.zones[0].snapshot={sha256:hash('before snapshot')};f.objects.set(f.latest.previousKey,Buffer.from(JSON.stringify(baseline)));
 f.latest.zones[0].snapshot={sha256:hash('after snapshot')};f.latest.zones[0].diff.counts.dropped=1;
 for(const key of [PREFIX+'/latest.json',`${PREFIX}/runs/${f.latest.day}/${f.latest.runId}/manifest.json`])f.objects.set(key,Buffer.from(JSON.stringify(f.latest)));
 f.store.putFile=async(key,file)=>{const bytes=fs.readFileSync(file);f.objects.set(key,bytes);return {key,bytes:bytes.length,sha256:hash(bytes)};};
 f.store.put=async(key,bytes)=>f.objects.set(key,Buffer.from(bytes));
 f.store.list=async function*(prefix){for(const [key,bytes]of f.objects)if(key.startsWith(prefix))yield {key,bytes:bytes.length};};
 const row={kind:'dropped',domain:'cedar.test',prev_ns:['ns1.afternic.com'],today_ns:[],today_class:null,window_start:'2026-10-21',window_end:'2026-10-24'},bytes=Buffer.from(JSON.stringify(row)+'\n'),file=path.join(f.root,'recovered.jsonl');fs.writeFileSync(file,bytes);
 const inputs=[{path:file,day:'2026-10-24',prevDay:'2026-10-21',zone:'test',sha256:hash(bytes),bytes:bytes.length,expectedChanged:0,expectedDropped:1}];
 const baselines=new Map([[baseline.day,baseline]]),publish=()=>publishRemovalBackfill({store:f.store,manifest:f.latest,baselines,inputs,reconstructedAt:'2026-10-25T00:00:00Z'});
 function saveAmendment(amendment){const body=Buffer.from(JSON.stringify(amendment)),key=amendmentPrefix(f.latest)+hash(body)+'.json';f.objects.set(key,body);return key;}
 return {...f,hash,baseline,baselines,inputs,row,publish,saveAmendment};
}
test('verified backfills become automatically discoverable without mutating original capture history',async t=>{
 const f=amendmentFixture(t),latest=Buffer.from(f.objects.get(PREFIX+'/latest.json')),published=await f.publish();
 assert.equal(published.removed,1);assert.deepEqual(f.objects.get(PREFIX+'/latest.json'),latest);
 const r=await prepareMovementReportSources(f.options),recovered=r.movementTapeInputs.find(x=>x.amendmentSha256);
 assert.equal(r.movementTapeInputs.length,3);assert.equal(r.manifestPaths.length,2);assert.equal(recovered.expectedChanged,0);assert.equal(recovered.expectedDropped,1);assert.equal(recovered.observedAt,'2026-10-24T14:00:00Z');assert.equal(recovered.baselineAsOf,'2026-10-21T01:00:00.000Z');assert.equal(recovered.reconstructedAt,'2026-10-25T00:00:00Z');assert.equal(recovered.accessScope,'organization-internal');assert.equal(r.receipt.amendments.length,1);assert.equal(r.receipt.removalCoverage[0].unrecoveredRemovals,0);
});
test('missing historical backfills are counted explicitly rather than silently treated as complete',async t=>{
 const f=amendmentFixture(t),r=await prepareMovementReportSources(f.options);assert.equal(r.movementTapeInputs.length,2);assert.equal(r.receipt.removalCoverage[0].unrecoveredRemovals,1);assert.deepEqual(r.receipt.removalCoverage[0].unrecoveredZones,['test']);
});
test('amendment admission rejects wrong captures, snapshots, counts, scope and unsafe object paths',async t=>{
 const patches=[a=>{a.capture.runId='different';},a=>{a.capture.sha256='f'.repeat(64);},a=>{a.accessScope='public';},a=>{a.complete=false;},a=>{a.zones=[];},a=>{a.zones[0].zone='different';},a=>{a.zones[0].expectedDropped=2;},a=>{a.zones[0].baseline.runId='wrong';},a=>{a.zones[0].sourceSnapshotSha256='a'.repeat(64);},a=>{a.zones[0].movement.key=PREFIX+'/runs/../../outside.jsonl';}];
 for(const patch of patches){const f=amendmentFixture(t),published=await f.publish();f.objects.delete(published.key);const amended=JSON.parse(JSON.stringify(published.amendment));patch(amended);f.saveAmendment(amended);await assert.rejects(prepareMovementReportSources(f.options),/Amendment|amendment|Invalid/);}
});
test('manifest and supplemental tape hashes are checked before evidence can be admitted',async t=>{
 const f=amendmentFixture(t),published=await f.publish();f.objects.set(published.key,Buffer.from('corrupt'));await assert.rejects(prepareMovementReportSources(f.options),/manifest integrity/);
 const g=amendmentFixture(t),p=await g.publish();g.objects.set(p.amendment.zones[0].movement.key,Buffer.from('corrupt'));await assert.rejects(prepareMovementReportSources(g.options),/integrity mismatch/);
});
test('identical repeated publications do not duplicate a recovered movement and conflicting bytes fail closed',async t=>{
 const f=amendmentFixture(t);await f.publish();await f.publish();const r=await prepareMovementReportSources(f.options);assert.equal(r.receipt.amendments.length,2);assert.equal(r.movementTapeInputs.length,3);
 const row={...f.row,prev_ns:['ns2.afternic.com']},bytes=Buffer.from(JSON.stringify(row)+'\n');fs.writeFileSync(f.inputs[0].path,bytes);f.inputs[0].bytes=bytes.length;f.inputs[0].sha256=f.hash(bytes);await f.publish();await assert.rejects(prepareMovementReportSources(f.options),/Conflicting removal amendments/);
});
test('publication verifies recovered row semantics and count before publishing a discoverable manifest',async t=>{
 for(const patch of [row=>({...row,kind:'changed'}),row=>({...row,today_ns:['invented.test']}),row=>({...row,window_start:'2026-10-22'})]){const f=amendmentFixture(t),bytes=Buffer.from(JSON.stringify(patch(f.row))+'\n');fs.writeFileSync(f.inputs[0].path,bytes);Object.assign(f.inputs[0],{sha256:f.hash(bytes),bytes:bytes.length});await assert.rejects(f.publish(),/bound delegation removal/);assert.equal([...f.objects.keys()].some(k=>k.startsWith(amendmentPrefix(f.latest))&&k.endsWith('.json')),false);}
});

test('incomplete input sets and wrong recovered row counts cannot be published',async t=>{
 const f=amendmentFixture(t);await assert.rejects(publishRemovalBackfill({store:f.store,manifest:f.latest,baselines:f.baselines,inputs:[],reconstructedAt:'2026-10-25T00:00:00Z'}),/cover all/);
 const bytes=Buffer.from((JSON.stringify(f.row)+'\n').repeat(2));fs.writeFileSync(f.inputs[0].path,bytes);Object.assign(f.inputs[0],{bytes:bytes.length,sha256:f.hash(bytes)});await assert.rejects(f.publish(),/row count/);
 assert.equal([...f.objects.keys()].some(k=>k.startsWith(amendmentPrefix(f.latest))&&k.endsWith('.json')),false);
});
