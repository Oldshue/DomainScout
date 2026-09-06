'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildNamingPatternEvidence}=require('../server/naming-pattern-evidence');
const {applyRegistrationEvidenceGate,applyAdoptionEvidenceGate,applyEconomicsEvidenceGate,buildExactBaseUpgradeTargets}=require('../server/market-opportunity-ranking');
const dictionary=new Set(['solar','home','house','roof','panel','power','grid','energy','field','farm','light','system','meter','browse','scrape']);
const date='2026-09-05';
function row(base_name,tld='com',report_date=date){return{base_name,tld,report_date};}
test('one off non-com match is an observation, not an acquisition basis',()=>{
 const evidence=buildNamingPatternEvidence([row('browsescrape','dev')],{token:'browsescrape',date,dictionary});
 assert.equal(evidence.largestNumericCohort,0);assert.ok(!evidence.registrationReview.reasons.some(x=>x.includes('numeric')));assert.equal(evidence.currentLabels,1);assert.equal(evidence.acquisitionRecommendation,false);assert.equal(applyRegistrationEvidenceGate({registration_evidence:evidence}).passed,false);
});
test('mirrored extensions do not manufacture label diversity; xyz is excluded',()=>{
 const rows=['com','ai','dev','io','xyz'].flatMap(tld=>['2026-09-03','2026-09-04',date].map(day=>row('solarhome',tld,day)));
 const evidence=buildNamingPatternEvidence(rows,{token:'solar',date,dictionary});
 assert.equal(evidence.distinctLabels,1);assert.equal(evidence.sharedLabels,1);assert.equal(evidence.currentDomains,4);assert.equal(evidence.registrationReview.passed,false);assert.ok(evidence.names.every(x=>!x.domain.endsWith('.xyz')));
});
test('unrelated sustained solar construction clears registration review without a surge',()=>{
 const endings=['home','house','roof','panel','power','grid','energy','field','farm','light','system','meter'];
 const rows=['2026-09-03','2026-09-04',date].flatMap(day=>endings.map(word=>row('solar'+word,'com',day)));
 const evidence=buildNamingPatternEvidence(rows,{token:'solar',date,dictionary});
 assert.equal(evidence.currentLabels,12);assert.equal(evidence.distinctLabels,12);assert.equal(evidence.activeDays,3);assert.equal(evidence.registrationReview.passed,true);
 assert.equal(evidence.acquisitionRecommendation,false);
});
test('xyz cannot create an exact-base upgrade target',()=>assert.deepEqual(buildExactBaseUpgradeTargets([{domain:'single.xyz'}]),[]));
test('missing or undated adoption and stale quotes fail independently',()=>{
 assert.equal(applyAdoptionEvidenceGate({adoption_evidence:[{url:'https://one.example',kind:'primary',scope:'category'}]}).passed,false);
 assert.equal(applyEconomicsEvidenceGate({price_usd:9,quote:{provider:'fixture',status:'available',price_usd:9,checked_at:'2020-01-01'},economics:{annual_renewal_usd:10,selling_fee_fraction:.15,five_year_sale_probability:.1,sale_price_usd:5000,assumptions:'fixture'}}).passed,false);
});

test('a quote for a different name cannot qualify the candidate',()=>{
 const c={domain:'SolarRoof.com',price_usd:9,quote:{domain:'OtherName.com',provider:'fixture',status:'available',price_usd:9,checked_at:new Date().toISOString()},economics:{annual_renewal_usd:10,selling_fee_fraction:.15,five_year_sale_probability:.1,sale_price_usd:5000,assumptions:'fixture'}};
 assert.equal(applyEconomicsEvidenceGate(c).passed,false);c.quote.domain='solarroof.com';assert.equal(applyEconomicsEvidenceGate(c).passed,true);
});

test('default vocabulary excludes obscure dictionary residue but preserves common compounds',()=>{
 const {familiarKeyword}=require('../server/keyword-language');
 for(const token of ['tion','eria','uang','itali','theb','oration'])assert.equal(familiarKeyword(token),false,token);
 for(const token of ['agent','agentic','solar','sandbox','payment','agentgraph'])assert.equal(familiarKeyword(token),true,token);
});

test('evidence cannot be borrowed for unrelated vocabulary or missing counts',()=>{
 const e={version:1,token:'solar',excludedSuffixes:['xyz'],currentLabels:4,distinctLabels:20,activeDays:4,registrationReview:{passed:true}};
 assert.equal(applyRegistrationEvidenceGate({domain:'SolarRoof.com',registration_evidence:e}).passed,true);
 assert.equal(applyRegistrationEvidenceGate({domain:'TravelRoof.com',registration_evidence:e}).passed,false);
 delete e.currentLabels;assert.equal(applyRegistrationEvidenceGate({domain:'SolarRoof.com',registration_evidence:e}).passed,false);
});

 test('modern inbox vocabulary is recognized without borrowing letters from protein or win',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const dictionary=new Set(fs.readFileSync(path.join(__dirname,'../server/assets/english-words.txt'),'utf8').toLowerCase().split(/\s+/));
  for(const word of fs.readFileSync(path.join(__dirname,'../server/assets/common-english.txt'),'utf8').split(/\s+/))dictionary.add(word);
  const {keywordUse}=require('../server/keyword-language');
  for(const label of ['agentemailinbox','quietinbox','inboxcartographer','inboxnavigators','hotelinbox'])assert.equal(keywordUse(label,'inbox',dictionary),true,label);
  for(const label of ['proteinbox','vitaminboxs','winbox','spinbox','buildbrainbox'])assert.equal(keywordUse(label,'inbox',dictionary),false,label);
  assert.equal(keywordUse('agentservice','agent',dictionary),true);
  assert.equal(keywordUse('mavexavoice','voice',dictionary),true);
  assert.equal(keywordUse('runmyinbox','inbox',dictionary),true);
  assert.equal(keywordUse('education','cation',dictionary),false);
 });

test('prefiltered pattern evidence retains verified zero-match days',()=>{
 const x=buildNamingPatternEvidence([],{token:'solar',date,dictionary,observedDates:['2026-09-04','2026-09-05']});assert.equal(x.windowDays,2);assert.equal(x.history.length,2);assert.ok(x.history.every(r=>r.domains===0));
});
test('editorial vocabulary cannot manufacture a clipped service suffix',()=>{
 const {familiarKeyword}=require('../server/keyword-language');
 assert.equal(familiarKeyword('servic'),false);assert.equal(familiarKeyword('service'),true);assert.equal(familiarKeyword('robotic'),true);
});
