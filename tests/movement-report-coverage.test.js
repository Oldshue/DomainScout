'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {apiSellerDepartures}=require('../server/sale-watch-discovery');
const sources=[{provider:'Example',nameserver:'ns1.example.test'}];
function response(body){return {ok:true,status:200,text:async()=>JSON.stringify(body)};}
test('cursor discovery rejects a promised but missing next page',async()=>{
 await assert.rejects(apiSellerDepartures({apiKey:'fixture',sellerNameservers:sources,after:'2026-10-20',fetchImpl:async()=>response({data:[],has_more:true})}),/missing continuation/);
});
test('cursor discovery detects cycles instead of imposing a row/page ceiling',async()=>{
 await assert.rejects(apiSellerDepartures({apiKey:'fixture',sellerNameservers:sources,after:'2026-10-20',fetchImpl:async()=>response({data:[],has_more:true,next_cursor:'cycle'})}),/repeated continuation/);
});
test('cursor discovery drains beyond the former arbitrary thousand-page ceiling',async()=>{
 let pages=0;
 const result=await apiSellerDepartures({apiKey:'fixture',sellerNameservers:sources,after:'2026-10-20',fetchImpl:async()=>{pages++;return response({data:[{name:`orchard${pages}.com`,last_seen:'2026-10-23'}],has_more:pages<1002,next_cursor:String(pages)});}});
 assert.equal(result.candidates.length,1002);assert.equal(result.sourceResults[0].pages,1002);
});
const {auditMovementCoverage}=require('../server/movement-report-coverage');
const manifest=(day,prevDay)=>({day,complete:true,inventory:['com','net'],zones:[{tld:'com'},{tld:'net'}],movement:{prevDay,comparedZones:2,totals:{changed:42}}});
test('a fresh discovery timestamp never conceals missing daily tapes or ccTLDs',()=>{
 const a=auditMovementCoverage({from:'2026-10-22',through:'2026-10-24',manifests:[manifest('2026-10-24','2026-10-21')],discovery:{generatedAt:'2026-10-24T18:00:00Z',coverage:{authenticatedCursorComplete:false}}});
 assert.equal(a.configuredDailyDiffComplete,false);assert.equal(a.days[0].status,'missing');assert.equal(a.days[2].dailyComplete,false);assert.ok(a.days[2].missingResearchZones.includes('ai'));assert.equal(a.publicSample,true);assert.equal(a.globalComplete,false);
});
test('account coverage and requested extension coverage remain separate',()=>{
 const a=auditMovementCoverage({from:'2026-10-24',through:'2026-10-24',manifests:[manifest('2026-10-24','2026-10-23')]});
 assert.equal(a.configuredDailyDiffComplete,false);assert.equal(a.researchDailyDiffComplete,false);assert.equal(a.days[0].retainsAllChangedDelegations,false);assert.equal(a.days[0].status,'incomplete-movement-retention');const m=manifest('2026-10-24','2026-10-23');m.movement.retainsAllChangedDelegations=true;m.movement.retainsAllRemovedDelegations=true;const b=auditMovementCoverage({from:'2026-10-24',through:'2026-10-24',manifests:[m]});assert.equal(b.configuredDailyDiffComplete,true);assert.equal(b.researchDailyDiffComplete,false);
});

const {assessSaleEntry}=require('../server/sale-watch-evidence');
test('Sav expiry destinations override stale attractive-sale signals',()=>{
 const r=assessSaleEntry({domain:'orchard.com',sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1-expired.sav.com','ns2-expired.sav.com'],discovery:{departureDate:'2026-10-23',structurallyMoved:true,buyerUse:true,homepage:{title:'Orchard',status:200,purpose:{kind:'operating'}}}},{now:new Date('2026-10-24T12:00:00Z')});
 assert.equal(r.classification,'expiration');assert.equal(r.tier,'excluded');
});
const {mergeDiscoveryHistory}=require('../scripts/update-sale-watch-sales');
test('later domain state cannot erase an earlier departure, its destination or a raw source association',()=>{
 const old={domain:'orchard.com',discovery:{departureDate:'2026-10-22'},sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1.buyer.example']};
 const next={...old,discovery:{departureDate:'2026-10-23'},buyerNameservers:['ns2.buyer.example']};
 const first=mergeDiscoveryHistory(null,{generatedAt:'2026-10-23T12:00:00Z',entries:[old],departureAssociations:[{domain:'orchard.com',departureDate:'2026-10-22',sellerNameserver:'ns1.afternic.com'}]});
 const second=mergeDiscoveryHistory(first,{generatedAt:'2026-10-24T12:00:00Z',entries:[next]});
 assert.equal(second.entries.length,1);assert.equal(second.movementHistory.length,2);assert.equal(second.departureAssociations.length,1);
 assert.deepEqual(second.movementHistory.find(r=>r.departureDate==='2026-10-22').buyerNameservers,['ns1.buyer.example']);
});
const {publicSellerDepartures}=require('../server/sale-watch-discovery');
test('public acquisition stops remaining requests after provider backpressure rather than hammering failed sources',async()=>{
 let calls=0;const r=await publicSellerDepartures({sellerNameservers:[...sources,{provider:'Other',nameserver:'ns2.other.test'}],fetchImpl:async()=>{calls++;return {ok:false,status:429,statusText:'Too Many Requests',headers:{get:()=> '120'}};}});
 assert.equal(calls,1);assert.equal(r.sourceResults.length,2);assert.match(r.sourceResults[1].error,/Deferred after provider HTTP 429/);assert.equal(r.sourceResults[1].totalArchiveRows,null);assert.ok(r.sourceResults[1].deferredUntil);
});
test('a complete snapshot collected before a rolling window cannot cover its overlapping boundary day',()=>{
 const m={...manifest('2026-10-21','2026-10-20'),finishedAt:'2026-10-21T08:48:00Z'};
 const a=auditMovementCoverage({from:'2026-10-21',through:'2026-10-24',manifests:[m],windowStartUtc:'2026-10-21T17:00:00Z'});
 assert.equal(a.days[0].collectionComplete,true);assert.equal(a.days[0].dailyComplete,false);assert.equal(a.days[0].status,'capture-predates-requested-window');
});
test('partial captures expose durable zone receipts and footprint without claiming a complete daily tape',()=>{
 const m={day:'2026-10-24',complete:false,inventory:['com','net','org'],zones:[{tld:'com',labels:100,observedAt:'2026-10-24T18:00:00Z',sourceLastModified:'2026-10-24T06:00:00Z',diff:{prevDay:'2026-10-21',counts:{changed:42},departures:7}}]};const a=auditMovementCoverage({from:m.day,through:m.day,manifests:[m]});assert.equal(a.days[0].status,'partial-snapshot');assert.equal(a.days[0].successful,1);assert.equal(a.days[0].inventory,3);assert.equal(a.days[0].observedSnapshotNames,100);assert.equal(a.days[0].rawChanged,42);assert.equal(a.days[0].departureAssociations,7);assert.equal(a.days[0].zoneCoverage[0].sourceAsOf,'2026-10-24T06:00:00Z');assert.equal(a.configuredDailyDiffComplete,false);
});
