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
