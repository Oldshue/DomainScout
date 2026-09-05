'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { websitePurpose, rdapEvidence, assessSaleEntry } = require('../server/sale-watch-evidence');
const { inspectHomepage } = require('../server/sale-watch-discovery');
const { readSaleWatchLedger } = require('../server/sale-watch');
const { mergeDiscoveryHistory } = require('../scripts/update-sale-watch-sales');
const now = new Date('2026-09-05T20:00:00Z');
function entry(overrides = {}) { return { domain:'workbench.com',tier:'probable',reportDate:'2026-09-04',lastObservedAt:now.toISOString(),sellerNameservers:['ns1.dan.com'],buyerUrl:'https://workbench.com',discovery:{structurallyMoved:true,buyerUse:true,departureDate:'2026-09-04',homepage:{active:true,status:200,title:'Workbench — team planning',finalUrl:'https://workbench.com'},rdap:{lastChangedAt:'2026-09-04T00:00:00Z',statuses:['client transfer prohibited'],checkedAt:now.toISOString()}},...overrides }; }
test('IvyLake portfolio redirect is never a buyer regardless of title and RDAP update',()=>{
 const e=entry();e.buyerUrl='https://www.ivylake.com/domains/workbench-com';e.discovery.homepage.finalUrl=e.buyerUrl;e.discovery.homepage.title='Workbench.com — team planning | IvyLake';
 const result=assessSaleEntry(e,{now});assert.equal(result.tier,'excluded');assert.equal(result.classification,'lander-migration');assert.equal(result.assessment.buyerUse,false);
});
test('unrelated custom storefront classified from visible purchase language, not hard-coded name',()=>{
 assert.equal(websitePurpose({title:'CopperCove.com — Your next company',finalUrl:'https://harbor.example/asset/coppercove',html:'<main><h1>Premium domain name</h1><button>Make an offer</button></main>'}).kind,'sales-lander');
 assert.equal(websitePurpose({title:'GardenStore — tools',html:'<main>Garden tools for sale. Buy now</main>'}).kind,'operating');
 assert.equal(websitePurpose({title:'Team inbox',html:'<script>domain for sale</script><main>Shared customer inbox</main>'}).kind,'operating');
 assert.equal(websitePurpose({title:'IvyLake news',finalUrl:'https://ivylake.com.attacker.example'}).forSale,false);
});
test('HTTP errors, challenges, thin/default pages never establish buyer use',async()=>{
 for(const [status,title] of [[403,'Workbench'],[404,'Workbench'],[200,'Just a moment'],[200,'My WordPress'],[200,'Workbench coming soon']]) {
  const fetchImpl=async url=>({ok:true,status,url:String(url),text:async()=>`<title>${title}</title>`});
  const result=await inspectHomepage('workbench.com',fetchImpl);assert.equal(result.active,false,`${status} ${title}`);
 }
});
test('RDAP transfer events stay separate from generic updates and transfer locks',()=>{
 const rdap=rdapEvidence({events:[{eventAction:'last changed',eventDate:'2026-09-04'},{eventAction:'transfer',eventDate:'2026-09-02'}],status:['clientTransferProhibited']});
 assert.equal(rdap.transferAt,'2026-09-02');assert.equal(rdap.lastChangedAt,'2026-09-04');assert.equal(rdap.pendingTransfer,false);assert.equal(rdap.transferLocked,true);
 assert.equal(rdapEvidence({status:['pending transfer']}).pendingTransfer,true);
});
test('DNS + title + MX + RDAP last change is unconfirmed, never probable sale',()=>{
 const e=entry();e.discovery.mx=['aspmx.l.google.com'];const result=assessSaleEntry(e,{now});assert.equal(result.tier,'suspected');assert.equal(result.assessment.transfer.pending,false);
});
test('explicit pending transfer is visible even before DNS leaves a lander',()=>{
 const e=entry();e.discovery.stillSellerDelegated=true;e.discovery.structurallyMoved=false;e.discovery.rdap.statuses=['pendingTransfer'];const result=assessSaleEntry(e,{now});assert.equal(result.tier,'transfer');assert.equal(result.assessment.buyerUse,false);
});
test('recent completed transfer plus seller departure and operating use qualifies as likely, not verified',()=>{
 const e=entry();e.discovery.rdap.transferAt='2026-09-04';const result=assessSaleEntry(e,{now});assert.equal(result.tier,'probable');assert.equal(result.classification,'likely-sale');
 e.discovery.homepage.finalUrl='https://ivylake.com/domains/workbench-com';assert.equal(assessSaleEntry(e,{now}).tier,'excluded');
});
test('old transfer, stale observations and parking-only origin cannot qualify as likely sale',()=>{
 const e=entry();e.discovery.rdap.transferAt='2024-09-04';assert.equal(assessSaleEntry(e,{now}).tier,'suspected');e.discovery.rdap.transferAt='2026-09-04';e.lastObservedAt='2026-08-30';assert.equal(assessSaleEntry(e,{now}).tier,'suspected');e.lastObservedAt=now.toISOString();e.sellerNameservers=['ns1.bodis.com'];assert.notEqual(assessSaleEntry(e,{now}).tier,'probable');
});
test('observed IANA registrar change is preserved as independent dated evidence',()=>{
 const previous=entry();previous.discovery.rdap.registrarId='100';previous.discovery.rdap.registrar='First Registrar';previous.lastObservedAt='2026-09-04T00:00:00Z';const current=entry();current.discovery.rdap.registrarId='200';current.discovery.rdap.registrar='Second Registrar';
 const result=assessSaleEntry(current,{now,previous});assert.equal(result.tier,'probable');assert.equal(result.assessment.transfer.fromRegistrar,'First Registrar');assert.equal(assessSaleEntry(result,{now}).tier,'probable');
});
test('legacy dynamic labels are re-adjudicated, exclusions retained, reported seed preserved',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sale-evidence-'));const seed=path.join(dir,'seed.json'),dynamic=path.join(dir,'dynamic.json');const bad=entry();bad.discovery.homepage.finalUrl='https://ivylake.com/domains/workbench-com';fs.writeFileSync(seed,JSON.stringify({entries:[{domain:'reported.com',tier:'verified',sourceUrl:'https://reports.example/sale',rationale:'independent report'}]}));fs.writeFileSync(dynamic,JSON.stringify({entries:[bad]}));const ledger=readSaleWatchLedger(seed,dynamic);assert.equal(ledger.counts.verified,1);assert.equal(ledger.entries.some(e=>e.domain===bad.domain),false);assert.equal(ledger.excludedEntries[0].domain,bad.domain);fs.rmSync(dir,{recursive:true});
});
test('fresh supporting recheck supersedes retired history; new domains do not inherit old first-observed date',()=>{
 const result=mergeDiscoveryHistory({generatedAt:'2020-01-01',entries:[],retiredEntries:[{domain:'workbench.com'}]},{generatedAt:now.toISOString(),entries:[entry()],ruledOut:[],coverage:{}});assert.equal(result.retiredEntries.length,0);assert.equal(result.entries[0].firstObservedAt,now.toISOString());
});

test('provider rate limits remain visible and cannot promote an uncertain move',()=>{
 const e=entry();e.discovery.rdap.error='429 Too Many Requests';const result=assessSaleEntry(e,{now});assert.equal(result.tier,'suspected');assert.ok(result.assessment.counterEvidence.some(s=>s.includes('429')));
});

test('authenticated cloud reconstruction delivery keeps credentials in headers and rejects redirects',async()=>{
 const {readCloudLedger}=require('../server/sale-watch-cloud');let seen;
 const result=await readCloudLedger({env:{DOMAINSCOUT_SALE_WATCH_CLOUD_URL:'https://cloud.example'},token:'fixture-secret',query:'unrelated',fetchImpl:async(url,init)=>{seen={url,init};return new Response(JSON.stringify({schema:'domainscout.sale-watch-ledger/v1',entries:[]}));}});
 assert.ok(result.ledger);assert.equal(seen.init.headers['x-domainscout-token'],'fixture-secret');assert.equal(seen.init.redirect,'error');assert.ok(!seen.url.includes('fixture-secret'));
 const failed=await readCloudLedger({env:{DOMAINSCOUT_SALE_WATCH_CLOUD_URL:'https://cloud.example'},token:'fixture-secret',query:'failure',fetchImpl:async()=>new Response('',{status:503})});assert.match(failed.error,/503/);
 assert.equal(await readCloudLedger({env:{RAILWAY_PROJECT_ID:'cloud'},token:'fixture-secret',fetchImpl:()=>{throw Error('recursive request')}}),null);
});

test('later observations retain registrar-change evidence, while coordinated migrations stay candidates',()=>{
 const previous=entry();previous.discovery.rdap.registrarId='100';previous.lastObservedAt='2026-09-04T00:00:00Z';
 const current=entry();current.discovery.rdap.registrarId='200';
 const changed=assessSaleEntry(current,{now,previous});assert.equal(changed.tier,'probable');
 const later=entry();later.discovery.rdap.registrarId='200';
 assert.equal(assessSaleEntry(later,{now,previous:changed}).tier,'probable');
 later.discovery.movement={cohortSize:20};
 const grouped=assessSaleEntry(later,{now,previous:changed});assert.equal(grouped.classification,'transfer-completed');assert.notEqual(grouped.tier,'probable');assert.ok(grouped.assessment.counterEvidence.some(x=>x.includes('20 departures')));
});

test('optional existing Railway SSH credential recovery is bounded and retains secrets only in memory',async()=>{
 const {readRailwayCredential}=require('../server/sale-watch-cloud');let command;
 const value=await readRailwayCredential({DOMAINSCOUT_SALE_WATCH_RAILWAY_PROJECT:'owner-project'},async(...args)=>{command=args;return {stdout:'ssh notice\n'+JSON.stringify({domainScoutReadToken:'fixture-read-secret'})+'\n'};});
 assert.equal(value,'fixture-read-secret');assert.equal(command[1][2],'owner-project');assert.equal(command[2].timeout,30000);assert.equal(command[2].maxBuffer,65536);assert.ok(!JSON.stringify(command).includes('fixture-read-secret'));
});

test('RDAP uses the IANA registry endpoint and honors registry cooldown',async()=>{
 const {inspectRdap}=require('../server/sale-watch-discovery');const seen=[];
 const fetchImpl=async url=>{seen.push(url);if(url.includes('iana.org'))return new Response(JSON.stringify({services:[[['example'],['https://registry.example/rdap/']]]}));return new Response(JSON.stringify({status:['pending transfer'],events:[]}));};
 const r=await inspectRdap('copper.example',fetchImpl);assert.equal(r.pendingTransfer,true);assert.equal(r.sourceUrl,'https://registry.example/rdap/domain/copper.example');assert.equal(seen.length,2);
 const limited=async url=>url.includes('iana.org')?new Response(JSON.stringify({services:[[['limited'],['https://registry.limited/']]]})):new Response('',{status:429,headers:{'retry-after':'7200'}});
 const a=await inspectRdap('one.limited',limited);assert.ok(Date.parse(a.retryAt)>Date.now()+7100000);const b=await inspectRdap('two.limited',limited);assert.match(b.error,/retry scheduled/);
});

test('pending transfer followed by a changed registrar remains visible before buyer launch',()=>{
 const previous=entry();previous.discovery.rdap={registrar:'Earlier Registrar',statuses:['pending transfer']};previous.lastObservedAt='2026-09-03T00:00:00Z';
 const current=entry();current.reportDate='2026-08-29';current.discovery.departureDate='2026-08-29';current.discovery.homepage.placeholder=true;current.discovery.buyerUse=false;current.discovery.rdap={registrar:'Receiving Registrar',registrarId:'200',statuses:['client transfer prohibited'],checkedAt:now.toISOString()};
 const result=assessSaleEntry(current,{now,previous});assert.equal(result.classification,'transfer-completed');assert.equal(result.assessment.transfer.fromRegistrar,'Earlier Registrar');assert.equal(assessSaleEntry(result,{now}).classification,'transfer-completed');assert.notEqual(result.tier,'probable');
});

test('loading, multilingual construction and host welcome pages remain transfer leads, not acquisitions',()=>{
 for(const title of ['Loading','Placeholder - Antagonist','Site en construction','En construcción','Website in aanbouw','Welcome to workbench.com']){
  const e=entry();e.discovery.homepage.title=title;e.discovery.rdap.transferAt='2026-09-04';
  const result=assessSaleEntry(e,{now});assert.equal(result.classification,'transfer-completed',title);assert.equal(result.assessment.buyerUse,false,title);
 }
});
test('unrelated branding at the exact domain cannot establish end-user adoption',()=>{
 const e=entry();e.discovery.homepage.title='Another Brand — online games';e.discovery.sameHost=true;e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});assert.equal(result.classification,'transfer-completed');assert.equal(result.assessment.identity.aligned,false);assert.ok(result.assessment.counterEvidence.some(x=>x.includes('branding')));
 delete e.discovery.rdap.transferAt;assert.equal(assessSaleEntry(e,{now}).classification,'unconfirmed-move');
});
test('matching branded redirects and primary headings preserve positive acquisition evidence',()=>{
 const e=entry();e.discovery.homepage.finalUrl='https://workbench.net';e.discovery.homepage.title='Team planning tools';e.discovery.rdap.transferAt='2026-09-04';
 assert.equal(assessSaleEntry(e,{now}).classification,'likely-sale');
 e.discovery.homepage.finalUrl='https://workbench.com';e.discovery.homepage.brandText='Workbench for coordinated teams';assert.equal(assessSaleEntry(e,{now}).classification,'likely-sale');
});
test('ParkLogic origins are parking evidence even with matching brand and transfer',()=>{
 const e=entry();e.sellerNameservers=['ns1.gm111.parklogic.com','ns2.gm111.parklogic.com'];e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});assert.equal(result.classification,'transfer-completed');assert.equal(result.assessment.parkingOrigin,true);
});
test('fresh homepage captures bounded visible branding without keeping scripts as identity',async()=>{
 const fetchImpl=async url=>({ok:true,status:200,url:String(url),text:async()=>'<title>Team software</title><meta property="og:site_name" content="Workbench"><h1>Plan your work</h1><script>Fake identity</script>'});
 const result=await inspectHomepage('workbench.com',fetchImpl);assert.match(result.brandText,/Workbench/);assert.doesNotMatch(result.brandText,/Fake identity/);
});

test('prelaunch seller departure with pending transfer remains an early visible lead without sale confirmation',()=>{
 const e=entry();e.discovery.homepage.title='Workbench coming soon';e.discovery.rdap.statuses=['pending transfer'];e.reportedPriceUsd=null;
 const result=assessSaleEntry(e,{now});assert.equal(result.classification,'transfer-in-progress');assert.equal(result.tier,'transfer');assert.equal(result.assessment.reported,false);
});
