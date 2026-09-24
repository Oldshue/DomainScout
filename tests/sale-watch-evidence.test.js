'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { websitePurpose, rdapEvidence, assessSaleEntry, destinationIdentity, matchesSaleView, isAlphaEntry, evidenceRank, VERSION } = require('../server/sale-watch-evidence');
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
test('premium-domain, name-generator and parking landings are storefronts, not buyers',()=>{
 for(const [title,html] of [
  ['NeuraRobo.com — Premium Domain Available','<main><h1>NeuraRobo.com</h1><p>This premium domain is available. Contact us.</p></main>'],
  ['MidGrid Business Name - Company Name Generator','<main><h1>MidGrid</h1><p>Generate a business name and get the matching domain.</p></main>'],
  ['Buy app-shop.com – Premium Domain Name for Your Brand | DaaZ','<main><h1>app-shop.com</h1><p>Secure this premium domain name for your brand today.</p></main>'],
  ['Parking Landing','<main><p>Parking Landing</p></main>'],
  ['Domain Parked « Zoneedit','<main><p>This domain is parked with Zoneedit.</p></main>'],
  ['APlaceForBusiness.com - Turnkey Businesses & Premium Domains','<main><p>Turnkey businesses and premium domains available for immediate purchase.</p></main>'],
  ['APlaceForBusiness.com - Turnkey Businesses & Premium Domains','<main><p>Browse our catalog of turnkey businesses and premium domains.</p></main>'],
 ]) assert.equal(websitePurpose({title,html}).kind,'sales-lander',title);
 assert.equal(websitePurpose({title:'MidGrid Energy — Battery storage for mid-size grids',html:'<main><p>We design and operate battery storage for utilities. Our parking lot chargers ship in Q4.</p></main>'}).kind,'operating');
 assert.equal(websitePurpose({title:'Brand Elevation Partners — Venture Studio',html:'<main><p>We build companies. Our name generator helps founders test brand names quickly.</p></main>'}).kind,'operating');
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
test('old transfer and stale observations cannot qualify as likely sale; parking-origin plus a dated transfer now reaches basis built (see CHANGE 1)',()=>{
 const e=entry();e.discovery.rdap.transferAt='2024-09-04';assert.equal(assessSaleEntry(e,{now}).tier,'suspected');e.discovery.rdap.transferAt='2026-09-04';e.lastObservedAt='2026-08-30';assert.equal(assessSaleEntry(e,{now}).tier,'suspected');e.lastObservedAt=now.toISOString();e.sellerNameservers=['ns1.bodis.com'];
 const parkingResult=assessSaleEntry(e,{now});assert.equal(parkingResult.tier,'probable');assert.equal(parkingResult.classification,'likely-sale');assert.equal(parkingResult.assessment.basis,'built');assert.equal(parkingResult.assessment.parkingOrigin,true);
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

test('pending transfer followed by a changed registrar is now the transfer footprint (likely-sale, basis transfer) even before buyer launch',()=>{
 const previous=entry();previous.discovery.rdap={registrar:'Earlier Registrar',statuses:['pending transfer']};previous.lastObservedAt='2026-09-03T00:00:00Z';
 const current=entry();current.reportDate='2026-08-29';current.discovery.departureDate='2026-08-29';current.discovery.homepage.placeholder=true;current.discovery.buyerUse=false;current.discovery.rdap={registrar:'Receiving Registrar',registrarId:'200',statuses:['client transfer prohibited'],checkedAt:now.toISOString()};
 const result=assessSaleEntry(current,{now,previous});assert.equal(result.classification,'likely-sale');assert.equal(result.assessment.basis,'transfer');assert.equal(result.assessment.transfer.fromRegistrar,'Earlier Registrar');assert.equal(assessSaleEntry(result,{now}).classification,'likely-sale');assert.equal(result.tier,'probable');
});

test('loading, multilingual construction and host welcome pages are the transfer footprint (basis transfer), not built-site adoption',()=>{
 for(const title of ['Loading','Placeholder - Antagonist','Site en construction','En construcción','Website in aanbouw','Welcome to workbench.com']){
  const e=entry();e.discovery.homepage.title=title;e.discovery.rdap.transferAt='2026-09-04';
  const result=assessSaleEntry(e,{now});assert.equal(result.classification,'likely-sale',title);assert.equal(result.assessment.basis,'transfer',title);assert.equal(result.assessment.buyerUse,false,title);
 }
});
test('unrelated branding at the exact domain is still the marketplace transfer footprint with a dated transfer; without one it stays unconfirmed',()=>{
 const e=entry();e.discovery.homepage.title='Another Brand — online games';e.discovery.sameHost=true;e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});assert.equal(result.classification,'likely-sale');assert.equal(result.assessment.basis,'transfer');assert.equal(result.assessment.identity.aligned,false);assert.ok(result.assessment.counterEvidence.some(x=>x.includes('branding')));
 delete e.discovery.rdap.transferAt;assert.equal(assessSaleEntry(e,{now}).classification,'unconfirmed-move');
});
test('matching branded redirects and primary headings preserve positive acquisition evidence',()=>{
 const e=entry();e.discovery.homepage.finalUrl='https://workbench.net';e.discovery.homepage.title='Team planning tools';e.discovery.rdap.transferAt='2026-09-04';
 assert.equal(assessSaleEntry(e,{now}).classification,'likely-sale');
 e.discovery.homepage.finalUrl='https://workbench.com';e.discovery.homepage.brandText='Workbench for coordinated teams';assert.equal(assessSaleEntry(e,{now}).classification,'likely-sale');
});
test('ParkLogic (parking-origin) rows are marked parkingOrigin evidence but now reach basis built once a dated transfer is present; without a transfer they stay an unreported acquisition-candidate',()=>{
 const noTransfer=entry();noTransfer.sellerNameservers=['ns1.gm111.parklogic.com','ns2.gm111.parklogic.com'];
 const r1=assessSaleEntry(noTransfer,{now});
 assert.equal(r1.classification,'acquisition-candidate');
 assert.equal(r1.assessment.parkingOrigin,true);
 assert.equal(isAlphaEntry(r1),true);
 const withTransfer=entry();withTransfer.sellerNameservers=['ns1.gm111.parklogic.com','ns2.gm111.parklogic.com'];withTransfer.discovery.rdap.transferAt='2026-09-04';
 const r2=assessSaleEntry(withTransfer,{now});
 assert.equal(r2.classification,'likely-sale');
 assert.equal(r2.assessment.basis,'built');
 assert.equal(r2.assessment.parkingOrigin,true);
});
test('fresh homepage captures bounded visible branding without keeping scripts as identity',async()=>{
 const fetchImpl=async url=>({ok:true,status:200,url:String(url),text:async()=>'<title>Team software</title><meta property="og:site_name" content="Workbench"><h1>Plan your work</h1><script>Fake identity</script>'});
 const result=await inspectHomepage('workbench.com',fetchImpl);assert.match(result.brandText,/Workbench/);assert.doesNotMatch(result.brandText,/Fake identity/);
});

test('prelaunch seller departure with pending transfer remains an early visible lead without sale confirmation',()=>{
 const e=entry();e.discovery.homepage.title='Workbench coming soon';e.discovery.rdap.statuses=['pending transfer'];e.reportedPriceUsd=null;
 const result=assessSaleEntry(e,{now});assert.equal(result.classification,'transfer-in-progress');assert.equal(result.tier,'transfer');assert.equal(result.assessment.reported,false);
});

test('cloud pages have separate cache keys and preserve offsets', async () => {
 const {readCloudLedger}=require('../server/sale-watch-cloud');const urls=[];
 const opts={env:{DOMAINSCOUT_SALE_WATCH_CLOUD_URL:'https://pages.example'},token:'fixture-secret',query:'copper',fetchImpl:async(url)=>{urls.push(url);return new Response(JSON.stringify({schema:'domainscout.sale-watch-ledger/v1',entries:[]}));}};
 await readCloudLedger({...opts,offset:0});await readCloudLedger({...opts,offset:1000});
 assert.equal(urls.length,2);assert.equal(new URL(urls[1]).searchParams.get('offset'),'1000');
});

test('unprobed expiration, verification holds and bulk parking cannot become acquisition leads', () => {
 const {isAcquisitionLead}=require('../server/sale-watch-evidence');
 for(const [ns,classification] of [['expired1.namebrightdns.com','expiration'],['expirens3.hichina.com','expiration'],['failed-whois-verification.namecheap.com','registry-hold'],['launch1.spaceship.net','platform-destination'],['ns1.onamae-expired.com','expiration'],['ns1.pendingrenewaldeletion.com','expiration'],['ns1.renewyourname.net','expiration'],['ns2.dccdns.com','platform-destination']]) {
  const e=entry({buyerNameservers:[ns]});e.discovery={structurallyMoved:true,departureDate:e.reportDate};
  const result=assessSaleEntry(e,{now});assert.equal(result.classification,classification);assert.equal(isAcquisitionLead(result),false);
 }
 const e=entry({buyerNameservers:['new.host.example']});e.discovery={structurallyMoved:true,departureDate:e.reportDate};
 assert.equal(assessSaleEntry(e,{now}).classification,'seller-departure','a launched site is not required for an early lead');
 e.discovery.movement={cohortSize:900};assert.equal(isAcquisitionLead(assessSaleEntry(e,{now})),false,'a mass move without corroboration stays in monitoring');
 e.discovery.rdap={pendingTransfer:true};assert.equal(assessSaleEntry(e,{now}).classification,'transfer-in-progress','independent registry evidence remains visible within a cohort');
});
test('generic domain-template branding is not buyer adoption; a separate matching brand still qualifies', () => {
 const e=entry();e.discovery.homepage.title='Latest articles from workbench.com';e.discovery.homepage.brandText='workbench.com';
 const result=assessSaleEntry(e,{now});assert.equal(result.assessment.buyerUse,false);assert.notEqual(result.classification,'acquisition-candidate');
 e.discovery.homepage.brandText='Workbench — team planning';assert.equal(assessSaleEntry(e,{now}).assessment.buyerUse,true);
});
test('registry deletion status overrides a previously operating destination',()=>{
 const e=entry();e.discovery.rdap.statuses=['redemption period'];
 assert.equal(assessSaleEntry(e,{now}).classification,'expiration');
});

test('access-wall destinations are unavailable, not operating, and cannot establish buyer use',()=>{
 const purpose=websitePurpose({title:'Sign in ・ Cloudflare Access',html:'<main>Sign in ・ Cloudflare Access</main>'});
 assert.equal(purpose.kind,'unavailable');assert.equal(purpose.reason,'Destination is behind an access wall; buyer use cannot be observed.');
 const e=entry();e.discovery.homepage.title='Sign in ・ Cloudflare Access';e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});assert.equal(result.assessment.buyerUse,false);assert.notEqual(result.classification,'acquisition-candidate');
});

test('template destination titles do not establish identity even with a dated transfer; a genuine remainder still aligns',()=>{
 const templ=destinationIdentity({domain:'koreantalent.com',title:'koreantalent.com - Sell Direct (UK)',brandText:'koreantalent.com - Sell Direct (UK)'});
 assert.equal(templ.templateTitle,true);assert.equal(templ.titleAligned,false);assert.equal(templ.headingAligned,false);assert.equal(templ.aligned,false);
 const e=entry();e.domain='koreantalent.com';e.discovery.homepage.title='koreantalent.com - Sell Direct (UK)';e.discovery.homepage.finalUrl='https://koreantalent.com';e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});assert.equal(result.classification,'likely-sale');assert.equal(result.assessment.basis,'transfer');assert.equal(result.assessment.identity.templateTitle,true);
 const aligned=destinationIdentity({domain:'koreantalent.com',title:'koreantalent.com - Find Korean Talent Fast'});
 assert.equal(aligned.templateTitle,false);assert.equal(aligned.titleAligned,true);assert.equal(aligned.aligned,true);
 const unchanged=destinationIdentity({domain:'koreantalent.com',title:'KoreanTalent — hire vetted talent'});
 assert.equal(unchanged.templateTitle,false);assert.equal(unchanged.titleAligned,true);
});

test('adoption kits of three or more names sharing a destination are a portfolio, not an acquisition candidate; a kit of two is unaffected',()=>{
 const e=entry();
 assert.equal(assessSaleEntry(e,{now}).classification,'acquisition-candidate');
 e.discovery.kit={basis:'title',key:'team planning tools',size:3,markedAt:now.toISOString()};
 const result=assessSaleEntry(e,{now});assert.equal(result.classification,'portfolio-kit');assert.equal(result.tier,'suspected');
 assert.equal(matchesSaleView(result,'focus'),false);assert.equal(matchesSaleView(result,'leads'),false);
 assert.ok(result.assessment.counterEvidence.some(x=>x.includes('3 names share this destination brand')));
 e.discovery.kit.size=2;assert.equal(assessSaleEntry(e,{now}).classification,'acquisition-candidate');
});

// ── registrar-origin transfer screen: 'transferred-and-built' ───────────────

function registrarOriginEntry(overrides = {}) {
  return {
    domain: 'craneworks.com',
    tier: 'suspected',
    reportDate: '2026-09-04',
    lastObservedAt: now.toISOString(),
    sellerNameservers: [],
    buyerUrl: 'https://craneworks.com',
    discovery: {
      structurallyMoved: true,
      buyerUse: true,
      departureDate: '2026-09-04',
      registrarOrigin: true,
      homepage: { active: true, status: 200, title: 'CraneWorks — heavy equipment rentals', finalUrl: 'https://craneworks.com' },
      rdap: { registrar: 'New Registrar Inc', transferAt: '2026-08-31', checkedAt: now.toISOString(), statuses: [] },
    },
    ...overrides,
  };
}

test('registrar-origin entry with a dated transfer and an operating aligned homepage is transferred-and-built, suspected, and a focus/leads lead', () => {
  const e = registrarOriginEntry();
  const result = assessSaleEntry(e, { now });
  assert.equal(result.classification, 'transferred-and-built');
  assert.equal(result.tier, 'suspected');
  assert.equal(matchesSaleView(result, 'focus'), true);
  assert.equal(matchesSaleView(result, 'leads'), true);
  assert.ok(result.assessment.signals.includes('Registrar-default origin (no marketplace listing observed)'));
});

test('registrar-origin entry without transfer evidence stays unconfirmed-move', () => {
  const e = registrarOriginEntry();
  delete e.discovery.rdap.transferAt;
  const result = assessSaleEntry(e, { now });
  assert.equal(result.classification, 'unconfirmed-move');
});

test('registrar-origin entry with a dated transfer but a parking/sales-lander destination stays lander-migration', () => {
  const e = registrarOriginEntry();
  e.discovery.homepage.title = 'craneworks.com - Premium Domain For Sale';
  const result = assessSaleEntry(e, { now });
  assert.equal(result.classification, 'lander-migration');
  assert.equal(result.tier, 'excluded');
});

test('registrar-origin entry sharing a destination with 3+ other names is a portfolio kit, not transferred-and-built', () => {
  const e = registrarOriginEntry();
  e.discovery.kit = { basis: 'title', key: 'heavy equipment rentals', size: 3, markedAt: now.toISOString() };
  const result = assessSaleEntry(e, { now });
  assert.equal(result.classification, 'portfolio-kit');
  assert.equal(result.tier, 'suspected');
});

// ── movement-footprint sale calls: reverse-engineering a sale from the DNS/RDAP
// movement itself, without requiring a built destination site ─────────────────

test('Afternic departure onto registrar-default DNS with a transfer within 14 days is the transfer footprint; 20 days out it is not',()=>{
 const near=entry({sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1.domaincontrol.com','ns2.domaincontrol.com']});
 near.discovery.departureDate='2026-09-04';near.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 near.discovery.rdap.transferAt='2026-08-29';
 const result=assessSaleEntry(near,{now});
 assert.equal(result.classification,'likely-sale');assert.equal(result.tier,'probable');assert.equal(result.assessment.basis,'transfer');
 const far=entry({sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1.domaincontrol.com','ns2.domaincontrol.com']});
 far.discovery.departureDate='2026-09-02';far.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 far.discovery.rdap.transferAt='2026-08-13';
 const result2=assessSaleEntry(far,{now});
 assert.notEqual(result2.assessment.basis,'transfer');assert.equal(result2.classification,'unconfirmed-move');assert.equal(result2.assessment.daysSinceDeparture,3);
});

test('Afternic departure onto Spaceship registrar defaults stays out of the transfer rule when the move is part of a 12-domain cohort',()=>{
 const e=entry({sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1.spaceship.net','ns2.spaceship.net']});
 e.discovery.departureDate='2026-09-04';e.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 e.discovery.rdap.transferAt='2026-09-04';e.discovery.movement={cohortSize:12};
 const result=assessSaleEntry(e,{now});
 assert.notEqual(result.classification,'likely-sale');
});

test('Dan departure onto registrar defaults with no transfer becomes the off-market footprint after 14 quiet days; earlier, onto a lander, or after relisting it does not',()=>{
 function offMarketEntry(nowAt, overrides={}) {
   const e=entry({sellerNameservers:['ns1.dan.com'],buyerNameservers:['ns1.domaincontrol.com']});
   e.lastObservedAt=nowAt.toISOString();
   e.discovery.departureDate='2026-08-20';
   e.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
   delete e.discovery.rdap.transferAt;
   e.discovery.rdap.checkedAt=nowAt.toISOString();
   e.discovery.movement={cohortSize:1,currentClass:'registrar'};
   Object.assign(e.discovery,overrides);
   return e;
 }
 const now16=new Date('2026-09-05T00:00:00Z');
 const quiet=offMarketEntry(now16);
 const result=assessSaleEntry(quiet,{now:now16});
 assert.equal(result.classification,'likely-sale');assert.equal(result.assessment.basis,'off-market');assert.equal(result.tier,'probable');
 const now5=new Date('2026-08-25T00:00:00Z');
 assert.equal(assessSaleEntry(offMarketEntry(now5),{now:now5}).classification,'unconfirmed-move');
 const lander=offMarketEntry(now16);
 lander.buyerNameservers=['ns1.sedoparking.com'];
 assert.equal(assessSaleEntry(lander,{now:now16}).classification,'platform-destination');
 const relisted=offMarketEntry(now16,{followUpMovement:{currentClass:'seller'}});
 assert.notEqual(assessSaleEntry(relisted,{now:now16}).classification,'likely-sale');
});

test('parking-only origin (ParkLogic) never satisfies the marketplace-departure transfer rule even with a dated transfer',()=>{
 const e=entry({sellerNameservers:['ns1.parklogic.com'],buyerNameservers:['ns1.domaincontrol.com']});
 e.discovery.departureDate='2026-09-04';
 e.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});
 assert.notEqual(result.assessment.basis,'transfer');
});

test('a built-site with an ordinary (non-marketplace, non-parking) prior delegation and no prior for-sale evidence is excluded as no-seller-origin, not a likely sale (see seller-origin gate)',()=>{
 const e=entry({sellerNameservers:['ns1.previous-registrar.example']});
 e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});
 assert.equal(result.tier,'excluded');
 assert.equal(result.classification,'no-seller-origin');
 assert.match(result.rationale,/ordinary other nameservers/);
 assert.notEqual(result.classification,'likely-sale');
});

test('registrar-origin entry with transfer and a built site still resolves via transferred-and-built, not the marketplace transfer/off-market rules',()=>{
 const e=registrarOriginEntry();
 const result=assessSaleEntry(e,{now});
 assert.equal(result.classification,'transferred-and-built');
 assert.notEqual(result.assessment.basis,'transfer');
 assert.notEqual(result.assessment.basis,'off-market');
});

test('spam/junk destination content (gambling, adult, pharma, SEO spam) is excluded from operating classification and marked contentQuality spam',()=>{
 const spamHtml='<main><h1>Welcome</h1><p>Best online casino and slots, play togel and judi bola today. RTP live jackpot!</p></main>';
 const purpose=websitePurpose({title:'Workbench',html:spamHtml,finalUrl:'https://workbench.com',status:200});
 assert.equal(purpose.spam,true);
 assert.equal(purpose.kind,'spam');
 assert.equal(purpose.reason,'Destination content is gambling, adult, pharma or SEO spam; not an end-user brand.');

 const e=entry();
 e.discovery.homepage={active:true,status:200,title:'Workbench',finalUrl:'https://workbench.com'};
 e.discovery.html=spamHtml;
 const spamEntry=entry();
 spamEntry.discovery.homepage={active:true,status:200,title:'Workbench',finalUrl:'https://workbench.com'};
 spamEntry.discovery.homepage.title='Best online casino and slots play togel and judi bola jackpot';
 const result=assessSaleEntry(spamEntry,{now});
 assert.equal(result.assessment.contentQuality,'spam');
 assert.notEqual(result.classification,'acquisition-candidate');

 const pharmacyLocal=websitePurpose({title:'Main Street Pharmacy',html:'<main>Your local online pharmacy in Denton, serving the community for 20 years.</main>'});
 assert.equal(pharmacyLocal.spam,false);
 assert.equal(pharmacyLocal.kind,'operating');
});

test('multilingual domain-for-sale storefront phrases classify as sales-lander',()=>{
 const cases=[
  'Diese Domain steht zum Verkauf',
  'Domain kaufen: premiumname.de',
  'Cette domaine est à vendre',
  'Acheter ce domaine maintenant',
  'Este dominio está en venta',
  'Comprar este dominio',
  'Dominio in vendita oggi',
  'Dit domein te koop',
  'Este domínio à venda',
  'Satılık domain: alan-adi.com',
  'Домен продается недорого',
  'Купить домен сейчас',
  '域名出售',
  '域名转让',
  '出售此域名',
 ];
 for(const title of cases) assert.equal(websitePurpose({title}).kind,'sales-lander',title);
});

test('isAlphaEntry is true only for buyer-built classifications on an alpha-tier name with no spam and no kit adoption',()=>{
 const faxly=entry({domain:'faxly.com',buyerUrl:'https://faxly.com'});
 faxly.discovery.homepage={active:true,status:200,title:'Faxly — invoicing for freelancers',finalUrl:'https://faxly.com'};
 const faxlyResult=assessSaleEntry(faxly,{now});
 assert.equal(faxlyResult.classification,'acquisition-candidate');
 assert.equal(faxlyResult.assessment.nameQuality,'alpha');
 assert.equal(faxlyResult.assessment.contentQuality,'ok');
 assert.equal(isAlphaEntry(faxlyResult),true);

 const dallas=entry({domain:'dallascleaningservices.com',buyerUrl:'https://dallascleaningservices.com'});
 dallas.discovery.homepage={active:true,status:200,title:'Dallas Cleaning Services — home and office cleaning',finalUrl:'https://dallascleaningservices.com'};
 const dallasResult=assessSaleEntry(dallas,{now});
 assert.equal(dallasResult.classification,'acquisition-candidate');
 assert.notEqual(dallasResult.assessment.nameQuality,'alpha');
 assert.equal(isAlphaEntry(dallasResult),false);

 const kitMember={...faxlyResult,discovery:{...faxlyResult.discovery,kit:{size:3}}};
 assert.equal(isAlphaEntry(kitMember),false);

 const transferInProgress={...faxlyResult,classification:'transfer-in-progress'};
 assert.equal(isAlphaEntry(transferInProgress),false);
});

test('evidenceRank orders classifications from strongest (likely-sale) to weakest evidence, unknowns last',()=>{
 const order=['likely-sale','transferred-and-built','acquisition-candidate','transfer-in-progress','transfer-completed','seller-departure','reported-sale'];
 order.forEach((classification,index)=>{assert.equal(evidenceRank({classification}),index);});
 assert.equal(evidenceRank({classification:'portfolio-kit'}),7);
 assert.equal(evidenceRank({classification:'unconfirmed-move'}),7);
});

test('a real transferred-and-built entry (registrar-origin) is excluded from the alpha feed but stays visible in focus', () => {
 const e = registrarOriginEntry();
 const result = assessSaleEntry(e, { now });
 assert.equal(result.classification, 'transferred-and-built');
 assert.equal(isAlphaEntry(result), false);
 assert.equal(matchesSaleView(result, 'focus'), true);
 assert.notEqual(result.classification, 'likely-sale');
});

test('websitePurpose recognizes default/installed server pages and single-generic-word template titles as placeholder, never buyerUse',()=>{
 assert.equal(websitePurpose({title:'CyberPanel Installed'}).kind,'placeholder');
 assert.equal(websitePurpose({title:'Welcome to nginx!'}).kind,'placeholder');
 assert.equal(websitePurpose({title:'Useable Site'}).kind,'placeholder');
 assert.equal(websitePurpose({title:'Home | Resort'}).kind,'placeholder');
 assert.equal(websitePurpose({title:'Faxly — Send faxes instantly online'}).kind,'operating');
});

test('assessSaleEntry with a default/installed placeholder homepage never yields acquisition-candidate',()=>{
 for (const title of ['CyberPanel Installed','Welcome to nginx!','Useable Site','Home | Resort']) {
  const e=entry();e.discovery.homepage={active:true,status:200,title,finalUrl:'https://workbench.com'};
  const result=assessSaleEntry(e,{now});
  assert.notEqual(result.classification,'acquisition-candidate',title);
  assert.equal(result.assessment.buyerUse,false,title);
 }
});

test('assessSaleEntry backdates the departure day: RDAP lastChangedAt inside a multi-day recovered window wins; a single-day window or an out-of-window lastChangedAt keeps the tape day',()=>{
 const laterNow=new Date('2026-09-16T00:00:00Z');

 const multiDay=entry();
 multiDay.reportDate='2026-09-15';
 multiDay.discovery.departureDate='2026-09-15';
 multiDay.discovery.movement={prevDay:'2026-09-11',day:'2026-09-15'};
 multiDay.discovery.rdap.lastChangedAt='2026-09-13T04:00:00Z';
 const multiResult=assessSaleEntry(multiDay,{now:laterNow});
 assert.equal(multiResult.reportDate,'2026-09-13');
 assert.equal(multiResult.assessment.departureDay,'2026-09-13');
 assert.equal(multiResult.assessment.departureDaySource,'rdap-last-changed');

 const singleDay=entry();
 singleDay.reportDate='2026-09-15';
 singleDay.discovery.departureDate='2026-09-15';
 singleDay.discovery.movement={prevDay:'2026-09-14',day:'2026-09-15'};
 singleDay.discovery.rdap.lastChangedAt='2026-09-13T04:00:00Z';
 const singleResult=assessSaleEntry(singleDay,{now:laterNow});
 assert.equal(singleResult.reportDate,'2026-09-15');
 assert.equal(singleResult.assessment.departureDay,'2026-09-15');
 assert.equal(singleResult.assessment.departureDaySource,'tape','single-day movement window must ignore lastChangedAt even when set');

 const outOfWindow=entry();
 outOfWindow.reportDate='2026-09-15';
 outOfWindow.discovery.departureDate='2026-09-15';
 outOfWindow.discovery.movement={prevDay:'2026-09-11',day:'2026-09-15'};
 outOfWindow.discovery.rdap.lastChangedAt='2026-09-05T04:00:00Z';
 const outResult=assessSaleEntry(outOfWindow,{now:laterNow});
 assert.equal(outResult.reportDate,'2026-09-15');
 assert.equal(outResult.assessment.departureDaySource,'tape','lastChangedAt outside (prevDay,day] must not override the tape day');
});

// ── owner-migration exclusion: registrar-default/hosting departures onto a
// registrar's own mandated nameservers are not a sale footprint ────────────

test('registrar-default (GoDaddy) departure onto Cloudflare-mandated nameservers with a same-window registry transfer to Cloudflare is excluded as owner-migration, never verified/probable/suspected',()=>{
 const e=entry({sellerNameservers:['ns55.domaincontrol.com','ns56.domaincontrol.com'],buyerNameservers:['bob.ns.cloudflare.com','alice.ns.cloudflare.com']});
 e.discovery.departureDate='2026-09-04';
 e.discovery.homepage={active:true,status:200,title:'Saint Johns Bible',finalUrl:'https://workbench.com'};
 e.discovery.rdap.registrar='Cloudflare, Inc.';e.discovery.rdap.registrarId='1910';e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});
 assert.equal(result.tier,'excluded');
 assert.equal(result.classification,'owner-migration');
 assert.notEqual(result.tier,'probable');
 assert.notEqual(result.tier,'verified');
 assert.notEqual(result.tier,'suspected');
 assert.ok(result.assessment.counterEvidence.some(x=>x.includes('mandated nameservers')));
});

test('Afternic (marketplace-origin) departure onto the same Cloudflare-mandated nameservers with a same-window transfer stays probable likely-sale, not owner-migration',()=>{
 const e=entry({sellerNameservers:['ns1.afternic.com','ns2.afternic.com'],buyerNameservers:['bob.ns.cloudflare.com','alice.ns.cloudflare.com']});
 e.discovery.departureDate='2026-09-04';
 e.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 e.discovery.rdap.registrar='Cloudflare, Inc.';e.discovery.rdap.registrarId='1910';e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});
 assert.equal(result.tier,'probable');
 assert.equal(result.classification,'likely-sale');
 assert.equal(result.assessment.basis,'transfer');
 assert.notEqual(result.classification,'owner-migration');
});

// ── platform-destination exclusion: a departure whose DESTINATION nameservers
// are a cataloged or learned marketplace/parking/investor platform is
// excluded (never verified/probable/suspected), independent of the
// owner-migration/no-seller-origin/lander-migration rules above ──────────

test('Afternic departure onto NameBright internal DNS is excluded as platform-destination, never verified/probable/suspected',()=>{
 const e=entry({sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1.namebrightdns.com','ns2.namebrightdns.com']});
 e.discovery.departureDate='2026-09-04';
 e.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 e.discovery.rdap.transferAt='2026-09-04';
 const result=assessSaleEntry(e,{now});
 assert.equal(result.tier,'excluded');
 assert.equal(result.classification,'platform-destination');
 assert.notEqual(result.tier,'probable');
 assert.notEqual(result.tier,'verified');
 assert.notEqual(result.tier,'suspected');
 assert.ok(result.assessment.counterEvidence.some(x=>x.includes('namebrightdns')));
});

test('Afternic departure onto an uncataloged destination LEARNED as a platform (via the injected learnedPlatformLookup) is excluded as platform-destination; without the lookup the same evidence is not excluded',()=>{
 const e=entry({sellerNameservers:['ns1.afternic.com'],buyerNameservers:['ns1.newplatform.example','ns2.newplatform.example']});
 e.discovery.departureDate='2026-09-04';
 e.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 e.discovery.rdap.transferAt='2026-09-04';
 const learnedPlatformLookup=(nsKey,day)=>{assert.equal(day,'2026-09-04');return {dailyCount:12,trailingCount:0};};
 const result=assessSaleEntry(e,{now,learnedPlatformLookup});
 assert.equal(result.tier,'excluded');
 assert.equal(result.classification,'platform-destination');
 assert.ok(result.assessment.counterEvidence.some(x=>x.includes('newplatform.example')));
 const withoutLookup=assessSaleEntry(e,{now});
 assert.notEqual(withoutLookup.classification,'platform-destination');
 assert.equal(withoutLookup.classification,'likely-sale');
});

test('registrar-default departure onto Cloudflare-mandated nameservers is promotable past owner-migration when prior site-evidence shows a parked or for-sale lander',()=>{
 const e=entry({sellerNameservers:['ns55.domaincontrol.com','ns56.domaincontrol.com'],buyerNameservers:['bob.ns.cloudflare.com','alice.ns.cloudflare.com']});
 e.discovery.departureDate='2026-09-04';
 e.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 e.discovery.rdap.registrar='Cloudflare, Inc.';e.discovery.rdap.registrarId='1910';e.discovery.rdap.transferAt='2026-09-04';
 e.discovery.priorSiteEvidence={status:'for-sale'};
 const result=assessSaleEntry(e,{now});
 assert.notEqual(result.classification,'owner-migration');
 const e2=entry({sellerNameservers:['ns55.domaincontrol.com','ns56.domaincontrol.com'],buyerNameservers:['bob.ns.cloudflare.com','alice.ns.cloudflare.com']});
 e2.discovery.departureDate='2026-09-04';
 e2.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 e2.discovery.rdap.registrar='Cloudflare, Inc.';e2.discovery.rdap.registrarId='1910';e2.discovery.rdap.transferAt='2026-09-04';
 e2.discovery.priorAftermarketListing=true;
 const result2=assessSaleEntry(e2,{now});
 assert.notEqual(result2.classification,'owner-migration');
});

test('classifier version bump reclassifies a stored row that was previously tagged likely-sale/probable under an older assessment version',()=>{
 const e=entry({sellerNameservers:['ns55.domaincontrol.com','ns56.domaincontrol.com'],buyerNameservers:['bob.ns.cloudflare.com','alice.ns.cloudflare.com']});
 e.discovery.departureDate='2026-09-04';
 e.discovery.homepage={active:true,status:200,title:'',finalUrl:'https://workbench.com'};
 e.discovery.rdap.registrar='Cloudflare, Inc.';e.discovery.rdap.transferAt='2026-09-04';
 e.tier='probable';e.classification='likely-sale';e.assessment={version:'sale-evidence-v11'};
 const result=assessSaleEntry(e,{now});
 assert.equal(result.tier,'excluded');
 assert.equal(result.classification,'owner-migration');
 assert.equal(result.assessment.version,VERSION);
 assert.notEqual(result.assessment.version,'sale-evidence-v11');
});

// ── seller-origin gate: probable/verified/suspected tiers require the prior
// delegation to be a marketplace/seller or parking class, or independent
// prior for-sale evidence; ordinary hosting/registrar/other prior DNS is an
// existing owner moving hosts or registrars, not a sale ────────────────────

function priorOtherOriginEntry(domain, sellerNs, overrides = {}) {
  const label = domain.split('.')[0];
  const brand = label.charAt(0).toUpperCase() + label.slice(1);
  const e = entry({ domain, buyerUrl: `https://${domain}`, sellerNameservers: sellerNs, ...overrides });
  e.discovery.homepage = { active: true, status: 200, title: `${brand} — team workspace`, finalUrl: `https://${domain}` };
  e.discovery.departureDate = '2026-09-04';
  e.discovery.rdap.transferAt = '2026-09-04';
  return e;
}

test('ordinary hosting/registrar/other prior delegation (DreamHost, ns14.net, a2hosting, spectrumdns, hosting506) is excluded as no-seller-origin even though the move would otherwise qualify as a likely sale',()=>{
 const cases = [
  ['hotarc.org', ['ns1.dreamhost.com', 'ns2.dreamhost.com']],
  ['fmstream.org', ['ns14.net']],
  ['sacredliturgy.org', ['ns1.a2hosting.com', 'ns2.a2hosting.com']],
  ['herohomesolutions.org', ['ns1.spectrumdns.net', 'ns2.spectrumdns.net']],
  ['accesoo.com', ['ns1.hosting506.com', 'ns2.hosting506.com']],
 ];
 for (const [domain, sellerNs] of cases) {
  const e = priorOtherOriginEntry(domain, sellerNs);
  const result = assessSaleEntry(e, { now });
  assert.equal(result.tier, 'excluded', domain);
  assert.equal(result.classification, 'no-seller-origin', domain);
  assert.ok(result.rationale.toLowerCase().includes('not a marketplace or parking lander'), domain);
  assert.ok(result.assessment.counterEvidence.some(x => x.includes('not a marketplace or parking lander')), domain);
  assert.notEqual(result.classification, 'likely-sale', domain);
 }
});

test('expiry/renewal prior states (Web.com expiry pendingrenewaldeletion, renewyourname) route to the existing expiration handling, never no-seller-origin',()=>{
 const excel = entry({ domain: 'excelcareertraining.org', sellerNameservers: ['pendingrenewaldeletion.com'] });
 const excelResult = assessSaleEntry(excel, { now });
 assert.equal(excelResult.tier, 'excluded');
 assert.equal(excelResult.classification, 'expiration');
 assert.notEqual(excelResult.classification, 'no-seller-origin');

 const strategy = entry({ domain: '1018strategy.org', sellerNameservers: ['renewyourname.net'] });
 const strategyResult = assessSaleEntry(strategy, { now });
 assert.equal(strategyResult.tier, 'excluded');
 assert.equal(strategyResult.classification, 'expiration');
 assert.notEqual(strategyResult.classification, 'no-seller-origin');
});

test('Afternic marketplace-origin departure with a dated transfer stays probable/likely-sale, unaffected by the seller-origin gate',()=>{
 const e = entry({ sellerNameservers: ['ns1.afternic.com', 'ns2.afternic.com'] });
 e.discovery.rdap.transferAt = '2026-09-04';
 const result = assessSaleEntry(e, { now });
 assert.equal(result.tier, 'probable');
 assert.equal(result.classification, 'likely-sale');
 assert.notEqual(result.classification, 'no-seller-origin');
});

test('a hosting/other-origin move with prior for-sale or parked lander evidence, or a prior aftermarket listing, stays eligible past the seller-origin gate',()=>{
 const withForSale = priorOtherOriginEntry('example-alpha.com', ['ns1.somehost.example']);
 withForSale.discovery.priorSiteEvidence = { status: 'for-sale' };
 const forSaleResult = assessSaleEntry(withForSale, { now });
 assert.equal(forSaleResult.tier, 'probable');
 assert.equal(forSaleResult.classification, 'likely-sale');
 assert.notEqual(forSaleResult.classification, 'no-seller-origin');

 const withParked = priorOtherOriginEntry('example-beta.com', ['ns1.somehost.example']);
 withParked.discovery.priorSiteEvidence = { status: 'parked' };
 const parkedResult = assessSaleEntry(withParked, { now });
 assert.equal(parkedResult.tier, 'probable');
 assert.notEqual(parkedResult.classification, 'no-seller-origin');

 const withListing = priorOtherOriginEntry('example-gamma.com', ['ns1.somehost.example']);
 withListing.discovery.priorAftermarketListing = true;
 const listingResult = assessSaleEntry(withListing, { now });
 assert.equal(listingResult.tier, 'probable');
 assert.notEqual(listingResult.classification, 'no-seller-origin');
});

test('VERSION bump triggers reassessment: a stored ordinary-hosting-origin row previously tagged likely-sale/probable under an older version is now excluded as no-seller-origin',()=>{
 const e = priorOtherOriginEntry('example-delta.com', ['ns1.somehost.example']);
 e.tier = 'probable';
 e.classification = 'likely-sale';
 e.assessment = { version: 'sale-evidence-v12' };
 const result = assessSaleEntry(e, { now });
 assert.equal(result.tier, 'excluded');
 assert.equal(result.classification, 'no-seller-origin');
 assert.equal(result.assessment.version, VERSION);
 assert.notEqual(result.assessment.version, 'sale-evidence-v12');
});
