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
 assert.match(html,/1 observed movement states/);assert.match(html,/1 names with semantic review/);assert.match(html,/Illustrative only; not a sale/);assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
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
test('repeat observations cannot inflate the displayed count of reviewed names',()=>{
 const receipt={through:'2026-10-24',from:'2026-10-22',checkedAt:'2026-10-24T12:00:00Z',domains:2,audit:{configuredDailyDiffComplete:false,days:[],notice:'partial'}};
 const html=renderMovementReport({receipt,rows:[{domain:'orchard.com',id:'a',departureDay:'2026-10-23'},{domain:'orchard.com',id:'b',departureDay:'2026-10-22'},{domain:'meadow.net',id:'c',departureDay:'2026-10-23'}]},{reviews:{'orchard.com':'A fruit-associated company identity.'}});
 assert.match(html,/1 names with semantic review \(2 observation states\)/);assert.match(html,/Semantic review: 1\/2 names; 2\/3 observation states/);
});
test('large reports retain every embedded record in a compressed payload and do not call missing DNS a cohort',()=>{
 const rows=Array.from({length:1500},(_,i)=>({id:String(i),domain:`orchard${i}.com`,departureDay:'2026-10-23',rationale:'An observed departure with unresolved destination; purchase unknown.'}));
 const receipt={through:'2026-10-24',from:'2026-10-22',checkedAt:'2026-10-24T12:00:00Z',domains:1500,audit:{configuredDailyDiffComplete:false,days:[],notice:'partial'}};
 const html=renderMovementReport({receipt,rows});const compressed=html.match(/atob\("([A-Za-z0-9+/=]+)"\)/);assert.ok(compressed);const records=JSON.parse(require('node:zlib').gunzipSync(Buffer.from(compressed[1],'base64')).toString());assert.equal(records.length,1500);assert.equal(records.at(-1).domain,'orchard1499.com');new(require('node:vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 const cohortTable=html.split('Repeated destination cohorts')[1].split('</details>')[0];assert.doesNotMatch(cohortTable,/<td>unknown<\/td>/);
});
test('internationalized names retain canonical evidence keys and searchable human-readable labels',()=>{
 const receipt={through:'2026-10-24',from:'2026-10-22',checkedAt:'2026-10-24T12:00:00Z',domains:1,audit:{configuredDailyDiffComplete:false,days:[],notice:'partial'}};
 const html=renderMovementReport({receipt,rows:[{domain:'xn--huserkaufen-l8a.net',id:'one',departureDay:'2026-10-23'}]});const data=JSON.parse(html.match(/const data=(\[.*?\]);const e=/s)[1]);assert.equal(data[0].domain,'xn--huserkaufen-l8a.net');assert.equal(data[0].unicodeDomain,'häuserkaufen.net');new(require('node:vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
test('verified full tapes retain all seller departures, distinguish interval uncertainty and admit an unbuilt semantic fixture', t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'movement-tape-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const input=path.join(root,'source.json'),tape=path.join(root,'movement.jsonl'),reviews=path.join(root,'reviews.tsv');fs.writeFileSync(input,JSON.stringify({entries:[]}));
 const ordinary={domain:'ordinary.com',selection:'changed',prev_class:'hosting',today_class:'hosting',prev_ns:['old.test'],today_ns:['new.test']};
 const departure={domain:'inferencevalley.com',selection:'departures',prev_class:'seller',today_class:'hosting',prev_provider:'Afternic',prev_ns:['ns1.afternic.com'],today_ns:['ns1.inferencevalley.com']};
 const text=[ordinary,departure,{...departure,domain:'secondfixture.com',today_ns:['ns1.secondfixture.com']}].map(x=>JSON.stringify(x)).join('\n')+'\n';fs.writeFileSync(tape,text);
 const sha256=require('node:crypto').createHash('sha256').update(text).digest('hex');fs.writeFileSync(reviews,'inferencevalley.com\tHypothetical fixture: AI inference plus an ecosystem/place metaphor.\n');
 const descriptor={path:tape,day:'2026-10-24',prevDay:'2026-10-21',observedAt:'2026-10-24T15:00:00Z',sha256,bytes:Buffer.byteLength(text)};
 const options={discoveryPath:input,movementTapeInputs:[descriptor],reviewsPath:reviews,hours:72,checkedAt:'2026-10-24T18:00:00Z',outDir:path.join(root,'out')};
 const result=build(options);assert.equal(result.rows.length,2);assert.equal(result.receipt.movementTapes[0].rawRows,3);assert.equal(result.receipt.movementTapes[0].otherRowsRetainedInSource,1);assert.equal(result.receipt.movementTapes[0].integrityVerified,true);
 const fixture=result.rows.find(r=>r.domain==='inferencevalley.com');assert.equal(fixture.homepage,null);assert.match(fixture.semanticReview.analysis,/AI inference/);assert.equal(fixture.windowMembership,'interval-overlap-uncertain');assert.equal(fixture.sourceReceipt.lineNumber,2);assert.equal(fixture.sourceReceipt.sha256,sha256);assert.notEqual(fixture.classification,'reported-sale');assert.equal(result.receipt.audit.configuredDailyDiffComplete,false);
 const html=fs.readFileSync(path.join(root,'out','report.html'),'utf8');assert.match(html,/multi-day observation interval/);new(require('node:vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 assert.throws(()=>build({...options,movementTapeInputs:[{...descriptor,sha256:'0'.repeat(64)}]}),/digest mismatch/);
});
test('source-reported sales stay separate from DNS movements and require explicit price transcription',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reported-sales-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const input=path.join(root,'source.json'),sales=path.join(root,'sales.json');
 fs.writeFileSync(input,JSON.stringify({entries:[{domain:'orchard.com',departureDate:'2026-10-23',sellerNameservers:['ns1.afternic.com']}]}));
 fs.writeFileSync(sales,JSON.stringify({reports:[{provider:'Fixture sales bulletin',sourceUrl:'https://example.test/sales',saleDay:'2026-10-23',publicationDay:'2026-10-24',selection:'exposed table',sourceReportedRows:200,records:[{domain:'orchard.com',venue:'Afternic',priceUsd:99999},{domain:'meadow.com',venue:'Private',priceUsd:2500,priceVerified:true}]}]}));
 const result=build({discoveryPath:input,reportedSalesPath:sales,from:'2026-10-22',through:'2026-10-24',outDir:path.join(root,'out')});assert.equal(result.rows.length,3);assert.equal(result.receipt.domains,2);assert.equal(result.rows.filter(r=>r.domain==='orchard.com').length,2);assert.equal(result.rows.find(r=>r.domain==='orchard.com'&&r.observationType==='reported-sale').reportedPriceUsd,null);assert.equal(result.rows.find(r=>r.domain==='meadow.com').reportedPriceUsd,2500);assert.equal(result.receipt.reportedSources[0].exposedRows,2);assert.equal(result.receipt.reportedSources[0].sourceReportedRows,200);
 const html=fs.readFileSync(path.join(root,'out','report.html'),'utf8');assert.match(html,/1 observed movement states \+ 2 source-reported sale records/);assert.match(html,/not counted as two purchases/);new(require('node:vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
