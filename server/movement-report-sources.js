'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PREFIX,getJson,restoreFile}=require('./universe-snapshots');
const {daysBetween}=require('./movement-report-coverage');
async function fileMatches(file,receipt){
 try{if(fs.statSync(file).size!==receipt.bytes)return false;}catch(e){if(e.code==='ENOENT')return false;throw e;}
 const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex')===receipt.sha256;
}
const iso=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
function assertManifest(m){
 if(m?.schema!=='domainscout.zone-universe/v2'||!/^\d{4}-\d{2}-\d{2}$/.test(m.day||'')||!m.runId)throw Error('Invalid completed capture manifest');
 daysBetween(m.day,m.day);
 const inventory=new Set(m.inventory||[]),zones=new Set((m.zones||[]).map(z=>z.tld));
 if(m.complete!==true||!inventory.size||zones.size!==m.zones.length||inventory.size!==zones.size||[...inventory].some(z=>!zones.has(z))||(m.failed||[]).length)throw Error('Archive capture is not complete across its accessible-zone inventory');
}
function assertObject(receipt){if(!receipt||typeof receipt.key!=='string'||!receipt.key.startsWith(PREFIX+'/runs/')||receipt.key.split('/').includes('..')||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<0||!/^[a-f0-9]{64}$/.test(receipt.sha256||''))throw Error('Invalid movement object receipt');}
async function prepareMovementReportSources({store,cacheDir,from,through,existingInputs=[],windowStartUtc=null,onProgress=()=>{}}){
 daysBetween(from,through);if(windowStartUtc!==null&&(!Number.isFinite(Date.parse(windowStartUtc))||new Date(windowStartUtc).toISOString().slice(0,10)!==from))throw Error('Invalid source window start');if(!store)throw Error('Configured evidence archive is unavailable');if(!cacheDir)throw Error('Source cache directory is required');
 fs.mkdirSync(cacheDir,{recursive:true});const manifests=[],manifestPaths=[],inputs=[],visited=new Set(),available=new Map();let downloaded=0,reused=0;
 for(const input of existingInputs){if(input?.sha256&&input.path){if(!available.has(input.sha256))available.set(input.sha256,[]);available.get(input.sha256).push(input.path);}}
 let key=PREFIX+'/latest.json',lastDay=null;
 for(;;){
  if(visited.has(key))throw Error('Capture archive cursor repeated');visited.add(key);
  const manifest=await getJson(store,key);if(!manifest){if(manifests.length||key!==PREFIX+'/latest.json')throw Error('Capture archive baseline manifest is missing');break;}
  assertManifest(manifest);if(lastDay&&manifest.day>=lastDay)throw Error('Capture archive baseline did not advance to an earlier date');lastDay=manifest.day;manifests.push(manifest);
  if(manifest.day<from||!manifest.previousKey)break;
  if(typeof manifest.previousKey!=='string'||!manifest.previousKey.startsWith(PREFIX+'/runs/')||manifest.previousKey.split('/').includes('..'))throw Error('Invalid capture archive baseline key');key=manifest.previousKey;
 }
 const byDay=new Map(manifests.map(m=>[m.day,m])),selected=manifests.filter(m=>m.day>=from&&m.day<=through);
 for(const manifest of selected){
  const manifestBytes=Buffer.from(JSON.stringify(manifest)),digest=crypto.createHash('sha256').update(manifestBytes).digest('hex'),manifestPath=path.join(cacheDir,'manifest-'+digest+'.json');
  if(!fs.existsSync(manifestPath))fs.writeFileSync(manifestPath,manifestBytes,{flag:'wx'});else if(!fs.readFileSync(manifestPath).equals(manifestBytes))throw Error('Cached manifest integrity mismatch');manifestPaths.push(manifestPath);
  if(windowStartUtc&&manifest.finishedAt&&Date.parse(manifest.finishedAt)<Date.parse(windowStartUtc))continue;
  for(const zone of manifest.zones){
   if(!zone.diff)continue;const receipt=zone.diff.movement;assertObject(receipt);if(!zone.diff.prevDay||zone.diff.prevDay>=manifest.day)throw Error('Invalid movement baseline date');daysBetween(zone.diff.prevDay,manifest.day);
   let file;for(const candidate of available.get(receipt.sha256)||[])if(await fileMatches(candidate,receipt)){file=candidate;break;}
   if(!file){file=path.join(cacheDir,receipt.sha256+'.jsonl');if(await fileMatches(file,receipt))reused++;else{await restoreFile(store,receipt,file);downloaded++;}}else reused++;
   available.set(receipt.sha256,[file]);const baseline=byDay.get(zone.diff.prevDay)?.zones.find(z=>z.tld===zone.tld);
   const input={path:file,day:manifest.day,prevDay:zone.diff.prevDay,zone:zone.tld,sha256:receipt.sha256,bytes:receipt.bytes,expectedChanged:zone.diff.counts?.changed,...(zone.diff.retainsAllRemovedDelegations?{expectedDropped:zone.diff.counts?.dropped}:{}),sourceAsOf:iso(zone.sourceLastModified),baselineAsOf:iso(baseline?.sourceLastModified),observedAt:zone.observedAt||manifest.finishedAt||null,sourceUrl:'https://czds.icann.org/',accessScope:'organization-internal'};inputs.push(input);onProgress({day:manifest.day,zone:zone.tld,verifiedObjects:inputs.length,downloaded,reused});
  }
 }
 const receipt={schema:'domainscout.movement-report-sources/v1',accessScope:'organization-internal',from,through,checkedAt:new Date().toISOString(),archiveManifests:manifests.map(m=>({day:m.day,runId:m.runId,complete:m.complete,sha256:crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex')})),selectedDays:selected.length,capturesBeforeWindow:selected.filter(m=>windowStartUtc&&m.finishedAt&&Date.parse(m.finishedAt)<Date.parse(windowStartUtc)).map(m=>m.day),tapes:inputs.length,downloaded,reused,missingDays:daysBetween(from,through).filter(day=>!selected.some(m=>m.day===day)),notice:'Only published completed captures are consumed. Missing dates and multi-day baselines remain coverage gaps; archive completion does not prove transactions.'};
 return {manifestPaths,movementTapeInputs:inputs,receipt};
}
module.exports={prepareMovementReportSources,fileMatches};
