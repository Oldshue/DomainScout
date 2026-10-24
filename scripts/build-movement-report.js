#!/usr/bin/env node
'use strict';
// Offline reproducible indexing. Network acquisition retains its own immutable source receipts.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {auditMovementCoverage}=require('../server/movement-report-coverage');
const {assessSaleEntry}=require('../server/sale-watch-evidence');
function build({discoveryPath,manifestPaths=[],from,through,outDir,checkedAt=new Date().toISOString()}){
 const raw=fs.readFileSync(discoveryPath),discovery=JSON.parse(raw),manifests=manifestPaths.map(p=>JSON.parse(fs.readFileSync(p)));
 const audit=auditMovementCoverage({from,through,manifests,discovery,checkedAt});
 const byEvent=new Map();let inputRows=0;
 for(const bucket of ['movementHistory','entries','ruledOut','retiredEntries'])for(const row of discovery[bucket]||[]){
  const day=row.departureDate||row.discovery?.departureDate||row.assessment?.departureDay;
  if(!day||day<from||day>through)continue;inputRows++;
  const domain=String(row.domain||'').toLowerCase(),before=[...new Set(row.sellerNameservers||[])].sort(),after=[...new Set(row.buyerNameservers||[])].sort();
  const id=crypto.createHash('sha256').update(JSON.stringify([domain,day,before,after])).digest('hex');
  const assessed=assessSaleEntry(row,{now:new Date(checkedAt)});
  const event={id,domain,departureDay:day,windowPrecision:'source-day; exact transaction time unknown',beforeNameservers:before,observedDestinationNameservers:after,destinationCheckedAt:row.discovery?.parentDelegation?.checkedAt||row.discovery?.homepage?.checkedAt||row.lastObservedAt||null,venue:row.venue||null,classification:assessed.classification||row.classification||null,tier:assessed.tier||row.tier,sourceUrl:row.sourceUrl||row.discovery?.dnsCoffeeHistoryUrl||null,sourceBucket:bucket,firstObservedAt:row.firstObservedAt||null,lastObservedAt:row.lastObservedAt||null,assessment:assessed.assessment||row.assessment||null,homepage:row.discovery?.homepage||null,transfer:row.discovery?.transferEvidence||null,rationale:assessed.rationale||row.rationale||null,semanticReview:null};
  const prior=byEvent.get(id);if(!prior||String(event.lastObservedAt||'')>String(prior.lastObservedAt||''))byEvent.set(id,event);
 }
 const rows=[...byEvent.values()].sort((a,b)=>b.departureDay.localeCompare(a.departureDay)||a.domain.localeCompare(b.domain));
 const receipt={schema:'domainscout.movement-report-index/v1',checkedAt,from,through,inputRows,events:rows.length,domains:new Set(rows.map(x=>x.domain)).size,duplicatesCollapsed:inputRows-rows.length,source:{path:discoveryPath,generatedAt:discovery.generatedAt,sha256:crypto.createHash('sha256').update(raw).digest('hex')},audit,semanticReviewed:0};
 fs.mkdirSync(outDir,{recursive:true});fs.writeFileSync(path.join(outDir,'coverage.json'),JSON.stringify(audit,null,2));fs.writeFileSync(path.join(outDir,'index.json'),JSON.stringify({receipt,rows}));fs.writeFileSync(path.join(outDir,'receipt.json'),JSON.stringify(receipt,null,2));return {receipt,rows};
}
if(require.main===module){const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];for(const k of ['--discovery','--from','--through','--out'])if(!args.includes(k))throw Error('Required '+k);const result=build({discoveryPath:get('--discovery'),from:get('--from'),through:get('--through'),outDir:get('--out'),manifestPaths:args.includes('--manifests')?get('--manifests').split(','):[]});console.log(JSON.stringify({events:result.receipt.events,domains:result.receipt.domains,coverageComplete:result.receipt.audit.configuredDailyDiffComplete}));}
module.exports={build};
