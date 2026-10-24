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
 new (require('node:vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 const data=html.match(/const data=(\[.*?\]);const e=/s)[1];assert.equal(JSON.parse(data).length,1);assert.equal(JSON.parse(data)[0].domain,'orchard.com');
});
test('daily CLI fails incomplete coverage while preserving the partial HTML and supports deliberate partial publication',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'movement-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const input=path.join(root,'source.json');fs.writeFileSync(input,JSON.stringify({entries:[]}));
 const args=[path.resolve(__dirname,'../scripts/build-movement-report.js'),'--discovery',input,'--from','2026-10-22','--through','2026-10-24','--out',path.join(root,'out')];
 const {spawnSync}=require('node:child_process');assert.equal(spawnSync(process.execPath,args,{encoding:'utf8'}).status,2);assert.ok(fs.existsSync(path.join(root,'out/report.html')));
 assert.equal(spawnSync(process.execPath,[...args,'--allow-partial'],{encoding:'utf8'}).status,0);
});
test('a rolling 72-hour request includes the overlapping fourth calendar day without claiming exact timing',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'movement-rolling-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const input=path.join(root,'source.json');
 fs.writeFileSync(input,JSON.stringify({entries:[{domain:'orchard.com',departureDate:'2026-10-21',sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1.example.test']},{domain:'older.com',departureDate:'2026-10-20'}]}));
 const r=build({discoveryPath:input,hours:72,checkedAt:'2026-10-24T17:00:00Z',outDir:path.join(root,'out')});
 assert.equal(r.receipt.from,'2026-10-21');assert.equal(r.rows.length,1);assert.equal(r.rows[0].windowMembership,'boundary-uncertain');assert.equal(r.receipt.rollingWindow.startUtc,'2026-10-21T17:00:00.000Z');
 new (require('node:vm').Script)(fs.readFileSync(path.join(root,'out/report.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]);
});
test('newer failed website evidence cannot retain stale adoption or pretend DNS was just rechecked',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'movement-fresh-site-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const input=path.join(root,'source.json'),sites=path.join(root,'sites.json');
 fs.writeFileSync(input,JSON.stringify({entries:[{domain:'orchard.com',lastObservedAt:'2026-10-23T12:00:00Z',sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1.buyer.example'],discovery:{departureDate:'2026-10-23',structurallyMoved:true,buyerUse:true,homepage:{checkedAt:'2026-10-23T12:00:00Z',title:'Orchard services',finalUrl:'https://orchard.com/',purpose:{kind:'operating'},status:200}}}]}));
 fs.writeFileSync(sites,JSON.stringify({checkedAt:'2026-10-24T17:00:00Z',observations:[{domain:'orchard.com',checkedAt:'2026-10-24T17:00:00Z',observationSha256:'fixture',homepage:{error:'timeout',title:null}}]}));
 const r=build({discoveryPath:input,siteObservationsPath:sites,from:'2026-10-22',through:'2026-10-24',checkedAt:'2026-10-24T18:00:00Z',outDir:path.join(root,'out')});
 assert.notEqual(r.rows[0].classification,'acquisition-candidate');assert.equal(r.rows[0].destinationCheckedAt,'2026-10-23T12:00:00Z');assert.equal(r.rows[0].homepage.checkedAt,'2026-10-24T17:00:00Z');assert.equal(r.receipt.supplementaryObservations.count,1);
});
test('reconciliation retains a different older destination state without reviving its old sale conclusion',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'movement-prior-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const input=path.join(root,'source.json'),prior=path.join(root,'prior.json');
 fs.writeFileSync(input,JSON.stringify({entries:[{domain:'orchard.com',departureDate:'2026-10-23',sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1-expired.sav.com']}]}));
 fs.writeFileSync(prior,JSON.stringify({rows:[{domain:'orchard.com',departureDate:'2026-10-23',sellerNameservers:['ns1.afternic.com'],destinationNameservers:['ns1.buyer.example'],classification:'likely-sale'}]}));
 const r=build({discoveryPath:input,priorIndexPaths:[prior],from:'2026-10-22',through:'2026-10-24',outDir:path.join(root,'out')});
 assert.equal(r.rows.length,2);assert.ok(r.rows.some(x=>x.classification==='expiration'));assert.ok(r.rows.some(x=>x.classification==='historical-observation'));assert.ok(!r.rows.some(x=>x.classification==='likely-sale'));assert.equal(r.receipt.priorIndexes[0].addedStates,1);assert.equal(r.receipt.duplicatesCollapsed,0);
});
test('a later report render preserves an interpretation review time instead of refreshing it',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'movement-review-date-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const input=path.join(root,'source.json'),reviews=path.join(root,'reviews.tsv');fs.writeFileSync(input,JSON.stringify({entries:[{domain:'orchard.com',departureDate:'2026-10-23'}]}));fs.writeFileSync(reviews,'orchard.com\tA fruit-linked company identity.\t2026-10-23T10:00:00Z\n');
 const r=build({discoveryPath:input,reviewsPath:reviews,from:'2026-10-22',through:'2026-10-24',checkedAt:'2026-10-24T18:00:00Z',outDir:path.join(root,'out')});assert.equal(r.rows[0].semanticReview.reviewedAt,'2026-10-23T10:00:00.000Z');
});
test('editorial pattern examples must be real captured names, never a hypothetical substitute',()=>{
 const receipt={through:'2026-10-24',from:'2026-10-22',checkedAt:'2026-10-24T12:00:00Z',domains:1,audit:{configuredDailyDiffComplete:false,days:[],notice:'partial'}};const index={receipt,rows:[{domain:'orchard.com',id:'one',departureDay:'2026-10-23'}]};
 assert.throws(()=>renderMovementReport(index,{insights:[{title:'Example',analysis:'Hypothesis',domains:['InferenceValley.com']}]}),/not an indexed observation/);
 const html=renderMovementReport(index,{insights:[{title:'Concrete product identity',analysis:'A captured semantic example.',domains:['orchard.com']}]});assert.match(html,/data-domain="orchard.com"/);new(require('node:vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
