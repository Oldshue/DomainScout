#!/usr/bin/env node
'use strict';
// Offline reproducible indexing. Network acquisition retains its own immutable source receipts.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {auditMovementCoverage}=require('../server/movement-report-coverage');
const {assessSaleEntry}=require('../server/sale-watch-evidence');
function build({discoveryPath,reportedSalesPath=null,audience='public',movementTapeInputs=[],manifestPaths=[],sourcePreparation=null,from,through,outDir,priorIndexPaths=[],siteObservationsPath=null,reviewsPath=null,hypotheticalsPath=null,notes=[],insights=[],relatedLinks=[],compressIndex=true,hours=null,checkedAt=new Date().toISOString()}){
 if(!['public','internal'].includes(audience))throw Error('Invalid report audience');
 if(sourcePreparation?.accessScope==='organization-internal'&&audience!=='internal')throw Error('Internal-use source preparation cannot enter a public report');
 const end=Date.parse(checkedAt);if(!Number.isFinite(end))throw Error('Invalid checkedAt');
 const rollingWindow=hours===null?null:{hours:Number(hours),startUtc:new Date(end-Number(hours)*3600000).toISOString(),endUtc:new Date(end).toISOString(),precision:'Day-level boundary observations are included as uncertain overlap, not assigned an exact time.'};
 if(rollingWindow){if(!Number.isFinite(Number(hours))||Number(hours)<=0)throw Error('Invalid rolling hours');from=rollingWindow.startUtc.slice(0,10);through=rollingWindow.endUtc.slice(0,10);}
 const raw=fs.readFileSync(discoveryPath),discovery=JSON.parse(raw),manifests=manifestPaths.map(p=>JSON.parse(fs.readFileSync(p)));
 const movementTapes=require('../server/movement-report-tapes').readMovementReportTapes(movementTapeInputs,{from,through,audience});
 discovery.movementHistory=[...(discovery.movementHistory||[]),...movementTapes.entries];
 const audit=auditMovementCoverage({from,through,manifests,discovery,checkedAt,windowStartUtc:rollingWindow?.startUtc||null});
 const supplementaryRaw=siteObservationsPath?fs.readFileSync(siteObservationsPath):null;
 const siteObservations=supplementaryRaw?JSON.parse(supplementaryRaw):null;
 const siteByDomain=new Map((siteObservations?.observations||[]).map(x=>[x.domain,x]));
 const byEvent=new Map();let inputRows=0;
 for(const bucket of ['movementHistory','entries','ruledOut','retiredEntries'])for(const row of discovery[bucket]||[]){
  const day=row.departureDate||row.discovery?.departureDate||row.assessment?.departureDay;
  if(!day||day<from||day>through)continue;inputRows++;
  const domain=String(row.domain||'').toLowerCase(),before=[...new Set(row.sellerNameservers||[])].sort(),after=[...new Set(row.buyerNameservers||[])].sort();
  const id=crypto.createHash('sha256').update(JSON.stringify([domain,day,before,after])).digest('hex');
  const fresh=siteByDomain.get(domain);
  const useFresh=fresh&&Date.parse(fresh.checkedAt)>=Date.parse(row.discovery?.homepage?.checkedAt||row.lastObservedAt||'1970-01-01');
  const homepage=useFresh?{...fresh.homepage,checkedAt:fresh.checkedAt}:row.discovery?.homepage;
  const evidenceEntry=useFresh?{...row,buyerTitle:homepage.title||null,buyerUrl:homepage.finalUrl||row.buyerUrl,discovery:{...row.discovery,homepage}}:row;
  const assessed=assessSaleEntry(evidenceEntry,{now:new Date(checkedAt)});
  const event={id,domain,departureDay:day,windowPrecision:row.sourceReceipt?.intervalDays>1?'multi-day observation interval; exact departure day unknown':'source-day; exact transaction time unknown',windowMembership:row.sourceReceipt?.intervalDays>1?'interval-overlap-uncertain':rollingWindow&&day===from?'boundary-uncertain':'within-requested-date-range',sourceReceipt:row.sourceReceipt||null,beforeNameservers:before,observedDestinationNameservers:after,destinationCheckedAt:row.discovery?.parentDelegation?.checkedAt||row.lastObservedAt||null,venue:row.venue||null,classification:assessed.classification||row.classification||null,tier:assessed.tier||row.tier,sourceUrl:row.sourceUrl||row.discovery?.dnsCoffeeHistoryUrl||null,sourceBucket:bucket,firstObservedAt:row.firstObservedAt||null,lastObservedAt:row.lastObservedAt||null,assessment:assessed.assessment||row.assessment||null,homepage:homepage||null,currentSiteObservation:useFresh?{checkedAt:fresh.checkedAt,observationSha256:fresh.observationSha256}:null,transfer:row.discovery?.transferEvidence||null,rationale:assessed.rationale||row.rationale||null,semanticReview:null};
  const prior=byEvent.get(id);
  if(!prior)byEvent.set(id,event);
  else {
   // A new snapshot of the same NS state is not a new website/transfer probe.
   // Preserve the latest actual inspection and attach the independent tape proof.
   const inspected=x=>!!(x.homepage||x.transfer);
   const evidenceTime=x=>Date.parse(x.homepage?.checkedAt||x.transfer?.observedAt||x.sourceReceipt?.sourceAsOf||x.destinationCheckedAt||x.lastObservedAt||'1970-01-01');
   const preferred=inspected(prior)!==inspected(event)?(inspected(event)?event:prior):(evidenceTime(event)>evidenceTime(prior)?event:prior);
   byEvent.set(id,{...preferred,sourceReceipt:event.sourceReceipt||prior.sourceReceipt||null});
  }
 }
 const {readReportIndex,hashReportIndex,writeReportIndex}=require('../server/movement-report-index-io');
 const priorIndexes=[];
 for(const inputPath of priorIndexPaths){
  const prior=readReportIndex(inputPath);let added=0;
  if(prior.receipt?.audience==='internal'&&audience!=='internal')throw Error('Internal-use prior index cannot enter a public report');
  for(const old of prior.rows||[]){
   const day=old.departureDay||old.departureDate;if(!day||day<from||day>through||!old.domain)continue;inputRows++;
   if(old.observationType==='reported-sale'){
    const reportId=old.id||crypto.createHash('sha256').update(JSON.stringify(['reported-sale',old.sourceUrl,old.domain,day])).digest('hex');
    if(!byEvent.has(reportId)){byEvent.set(reportId,{...old,id:reportId});added++;}continue;
   }
   const domain=String(old.domain).toLowerCase(),before=[...new Set(old.beforeNameservers||old.sellerNameservers||[])].sort(),after=[...new Set(old.observedDestinationNameservers||old.destinationNameservers||[])].sort();
   const id=crypto.createHash('sha256').update(JSON.stringify([domain,day,before,after])).digest('hex');if(byEvent.has(id))continue;
   byEvent.set(id,{id,domain,departureDay:day,windowPrecision:'source-day; exact transaction time unknown',windowMembership:rollingWindow&&day===from?'boundary-uncertain':'within-requested-date-range',beforeNameservers:before,observedDestinationNameservers:after,destinationCheckedAt:old.destinationCheckedAt||old.lastObservedAt||null,venue:old.venue||old.marketplace||null,classification:'historical-observation',tier:'suspected',sourceUrl:old.sourceUrl||null,sourceBucket:'prior-index',firstObservedAt:old.firstObservedAt||null,lastObservedAt:old.lastObservedAt||null,assessment:{counterEvidence:['Earlier indexed state; no present-day sale or buyer-use conclusion is restored.']},homepage:old.homepage||null,transfer:null,rationale:'A distinct before/observed-destination state was retained in an earlier immutable index. It remains inspectable as history; it is not a second transaction or a fresh sale conclusion.',semanticReview:null});added++;
  }
  priorIndexes.push({sha256:hashReportIndex(inputPath),addedStates:added});
 }
 const reportedSales=require('../server/movement-report-sales').readReportedSales(reportedSalesPath,{from,through,audience});
 for(const row of reportedSales.rows){inputRows++;byEvent.set(row.id,row);}
 const rows=[...byEvent.values()].sort((a,b)=>b.departureDay.localeCompare(a.departureDay)||a.domain.localeCompare(b.domain));
 const reviewRecords=reviewsPath?Object.fromEntries(fs.readFileSync(reviewsPath,'utf8').trim().split('\n').filter(Boolean).map(line=>{const [domain,analysis,reviewedAt]=line.split('\t');if(!domain||!analysis)throw Error('Semantic review requires domain and analysis');if(reviewedAt&&!Number.isFinite(Date.parse(reviewedAt)))throw Error('Invalid semantic review timestamp');return [domain,{analysis,reviewedAt:reviewedAt?new Date(reviewedAt).toISOString():null}];})):{};
 const reviews=Object.fromEntries(Object.entries(reviewRecords).map(([domain,r])=>[domain,r.analysis]));
 for(const row of rows)if(reviewRecords[row.domain])row.semanticReview={...reviewRecords[row.domain],method:'analyst semantic hypothesis'};
 const {namingProfile,VERSION:namingVersion}=require('../server/movement-report-semantics');
 const profiles=new Map();let invalidNamingLabels=0;
 const namingLeadClasses=new Set(['reported-sale','seller-departure','likely-sale','acquisition-candidate','transfer-in-progress','transfer-completed']);
 for(const row of rows){
  if(row.semanticReview||!(namingLeadClasses.has(row.classification)||(row.classification==='unconfirmed-move'&&row.assessment?.delegation?.sellerOrigin)))continue;
  if(!profiles.has(row.domain)){
   try{profiles.set(row.domain,namingProfile(row.domain));}
   catch(error){invalidNamingLabels++;profiles.set(row.domain,{version:namingVersion,method:'rule-based preliminary naming hypothesis',status:'unresolved',inputError:'invalid-domain-label',analysis:'The source label requires validation before a lexical buyer-appeal hypothesis can be assigned. No translation, buyer, sale or registration finding has been established.'});}
  }
  row.semanticProfile=profiles.get(row.domain);
 }
 const profiledRows=rows.filter(r=>r.semanticProfile);
 const preliminaryNaming={version:namingVersion,profiledStates:profiledRows.length,profiledDomains:profiles.size,hypothesisStates:profiledRows.filter(r=>r.semanticProfile.status==='preliminary-hypothesis').length,unresolvedStates:profiledRows.filter(r=>r.semanticProfile.status==='unresolved').length,invalidLabels:invalidNamingLabels,scope:'Unreviewed reported sales, clear purchase leads and uncertain seller-origin movements; countercases are not turned into buyer evidence.',implementationSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../server/movement-report-semantics.js'))).digest('hex')};
 const receipt={schema:'domainscout.movement-report-index/v1',audience,preliminaryNaming,sourcePreparation,movementTapes:movementTapes.receipts,reportedSources:reportedSales.receipts,checkedAt,from,through,rollingWindow,priorIndexes,supplementaryObservations:supplementaryRaw?{sha256:crypto.createHash('sha256').update(supplementaryRaw).digest('hex'),checkedAt:siteObservations.checkedAt,count:siteByDomain.size}:null,inputRows,events:rows.length,domains:new Set(rows.map(x=>x.domain)).size,duplicatesCollapsed:inputRows-rows.length,source:{path:discoveryPath,generatedAt:discovery.generatedAt,sha256:crypto.createHash('sha256').update(raw).digest('hex')},audit,reportedSaleRecords:rows.filter(r=>r.observationType==='reported-sale').length,semanticReviewed:rows.filter(r=>r.semanticReview).length,semanticReviewedDomains:new Set(rows.filter(r=>r.semanticReview).map(r=>r.domain)).size};
 fs.mkdirSync(outDir,{recursive:true});const stage=fs.mkdtempSync(path.join(outDir,'.stage-'));try{fs.writeFileSync(path.join(stage,'coverage.json'),JSON.stringify(audit,null,2));writeReportIndex(path.join(stage,'index.json'),receipt,rows);fs.writeFileSync(path.join(stage,'receipt.json'),JSON.stringify(receipt,null,2));const publicReceipt={...receipt,source:{generatedAt:receipt.source.generatedAt,sha256:receipt.source.sha256}};fs.writeFileSync(path.join(stage,'report.html'),require('../server/movement-report-renderer').renderMovementReport({receipt:publicReceipt,rows},{reviews,notes,insights,relatedLinks,compressIndex,hypotheticals:hypotheticalsPath?JSON.parse(fs.readFileSync(hypotheticalsPath)):[]}));for(const name of ['coverage.json','index.json','report.html','receipt.json'])fs.renameSync(path.join(stage,name),path.join(outDir,name));}finally{fs.rmSync(stage,{recursive:true,force:true})}return {receipt,rows};
}
async function main(args=process.argv.slice(2)){
 const get=k=>{const v=args[args.indexOf(k)+1];if(!v||v.startsWith('--'))throw Error('Missing value for '+k);return v;};for(const k of ['--discovery','--out',...(args.includes('--hours')?[]:['--from','--through'])])if(!args.includes(k))throw Error('Required '+k);
 const audience=args.includes('--audience')?get('--audience'):'public',checkedAt=args.includes('--checked-at')?get('--checked-at'):new Date().toISOString(),hours=args.includes('--hours')?Number(get('--hours')):null;
 const end=Date.parse(checkedAt);if(!Number.isFinite(end)||hours!==null&&(!Number.isFinite(hours)||hours<=0))throw Error('Invalid report time window');
 const from=hours===null?get('--from'):new Date(end-hours*3600000).toISOString().slice(0,10),through=hours===null?get('--through'):new Date(end).toISOString().slice(0,10);
 let movementTapeInputs=args.includes('--movement-tapes')?JSON.parse(fs.readFileSync(get('--movement-tapes'),'utf8')):[],manifestPaths=args.includes('--manifests')?get('--manifests').split(','):[],sourcePreparation=null;
 if(args.includes('--archive-cache')){
  if(audience!=='internal')throw Error('Archive source preparation requires --audience internal');
  const prepared=await require('../server/movement-report-sources').prepareMovementReportSources({store:require('../server/recent-registration-corpus').createS3ObjectStore(process.env),cacheDir:get('--archive-cache'),from,through,windowStartUtc:hours===null?null:new Date(end-hours*3600000).toISOString(),existingInputs:movementTapeInputs});
  movementTapeInputs=prepared.movementTapeInputs;manifestPaths=[...new Set([...manifestPaths,...prepared.manifestPaths])];sourcePreparation=prepared.receipt;
 }
 const result=build({audience,reportedSalesPath:args.includes('--reported-sales')?get('--reported-sales'):null,movementTapeInputs,manifestPaths,sourcePreparation,discoveryPath:get('--discovery'),from,through,hours,checkedAt,outDir:get('--out'),priorIndexPaths:args.includes('--prior-indexes')?get('--prior-indexes').split(','):[],siteObservationsPath:args.includes('--site-observations')?get('--site-observations'):null,reviewsPath:args.includes('--reviews')?get('--reviews'):null,hypotheticalsPath:args.includes('--hypotheticals')?get('--hypotheticals'):null});
 console.log(JSON.stringify({events:result.receipt.events,domains:result.receipt.domains,coverageComplete:result.receipt.audit.configuredDailyDiffComplete,sourcePreparation}));if(!result.receipt.audit.researchDailyDiffComplete&&!args.includes('--allow-partial'))process.exitCode=2;
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={build,main};
