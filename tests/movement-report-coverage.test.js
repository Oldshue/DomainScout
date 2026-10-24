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
 assert.equal(a.configuredDailyDiffComplete,true);assert.equal(a.researchDailyDiffComplete,false);assert.equal(a.days[0].retainsAllChangedDelegations,false);
});
