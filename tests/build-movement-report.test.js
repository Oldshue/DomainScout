'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {build}=require('../scripts/build-movement-report');
test('report retains repeat movements and counterevidence while collapsing exact duplicate observations',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'movement-report-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const row=day=>({domain:'orchard.com',departureDate:day,sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1.example.test'],venue:'Afternic',lastObservedAt:day+'T12:00:00Z'});
 const input=path.join(root,'input.json');fs.writeFileSync(input,JSON.stringify({generatedAt:'2026-10-24T12:00:00Z',entries:[row('2026-10-23'),row('2026-10-22')],retiredEntries:[row('2026-10-23')],ruledOut:[{...row('2026-10-23'),domain:'countercase.com',buyerNameservers:['ns1-expired.sav.com']}]}));
 const r=build({discoveryPath:input,from:'2026-10-22',through:'2026-10-24',outDir:path.join(root,'out'),checkedAt:'2026-10-24T12:00:00Z'});
 assert.equal(r.receipt.events,3);assert.equal(r.receipt.domains,2);assert.equal(r.receipt.duplicatesCollapsed,1);assert.equal(r.rows.filter(x=>x.domain==='orchard.com').length,2);assert.equal(r.receipt.audit.configuredDailyDiffComplete,false);assert.equal(r.receipt.semanticReviewed,0);
});
const {renderMovementReport}=require('../server/movement-report-renderer');
test('report keeps hypothetical names outside the data array and escapes source markup',()=>{
 const receipt={through:'2026-10-24',from:'2026-10-22',checkedAt:'2026-10-24T12:00:00Z',domains:1,audit:{configuredDailyDiffComplete:false,days:[],notice:'partial'}};
 const html=renderMovementReport({receipt,rows:[{domain:'orchard.com',id:'one',departureDay:'2026-10-23',beforeNameservers:[],observedDestinationNameservers:[],rationale:'</script><script>alert(1)</script>'}]},{reviews:{'orchard.com':'A fruit-linked company identity; buyer unknown.'},hypotheticals:[{domain:'InferenceValley.com',analysis:'Illustrative AI hub.'}]});
 assert.match(html,/1 observed movement states/);assert.match(html,/1 semantic reviews/);assert.match(html,/Illustrative only; not a sale/);assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
 const data=html.match(/const data=(\[.*?\]);const e=/s)[1];assert.equal(JSON.parse(data).length,1);assert.equal(JSON.parse(data)[0].domain,'orchard.com');
});
