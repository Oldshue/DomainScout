'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {namingProfile}=require('./movement-report-semantics');
const {segmentDailyLabel,tokenizeDailyLabel}=require('./domainlab');
const dict=new Set('inference valley chair chain repair ledger central quiz walk story matrix soft cognition code indexer shop plant sync data free pet  hotel'.split(/\s+/));
test('InferenceValley is a technical-plus-place hypothesis without a site or sale assertion',()=>{
 const p=namingProfile('InferenceValley.com',{dict});
 assert.deepEqual(p.components.map(c=>c.text),['inference','valley']);
 assert.match(p.analysis,/AI model execution or reasoning/);
 assert.match(p.combination,/community or ecosystem/);
 assert.ok(p.buyerClasses.includes('AI infrastructure vendors'));
 assert.ok(p.commercialUses.includes('model-execution tooling'));
 assert.match(p.analysis,/not an analyst review, identified buyer/);
 assert.equal(p.domain,'inferencevalley.com');
});
test('category assignment requires complete token boundaries, never an ai substring',()=>{
 for(const domain of ['chair.com','chain.com','repair.com'])assert.equal(namingProfile(domain,{dict}).buyerClasses.some(x=>x.startsWith('AI ')),false);
});
test('unrelated financial and education names receive distinct functional hypotheses',()=>{
 const ledger=namingProfile('CentralLedger.com',{dict}),quiz=namingProfile('QuizWalk.com',{dict});
 assert.ok(ledger.commercialUses.includes('record keeping or payment workflows'));
 assert.ok(quiz.commercialUses.includes('educational tools or activities'));
 assert.notDeepEqual(ledger.buyerClasses,quiz.buyerClasses);
});
test('unknown names and internationalized labels stay unresolved without invented translations',()=>{
 for(const domain of ['zqtzw.com','xn--u-tfa.com']){
  const p=namingProfile(domain,{dict});assert.equal(p.status,'unresolved');assert.equal(p.buyerClasses.length,0);assert.ok(p.unresolvedComponents.length);assert.match(p.analysis,/translation has not been verified/);
 }
});
test('numeric and hyphenated components are retained rather than silently discarded',()=>{
 const p=namingProfile('sync-data24.com',{dict});assert.deepEqual(p.components.map(c=>c.text),['sync','data','24']);assert.equal(p.tradeoffs.length,2);
});
test('ordered segmentation preserves repeated words and existing token-map behavior',()=>{
 assert.deepEqual(segmentDailyLabel('pet-petshop',{dict}),['pet','pet','shop']);
 const tokens=tokenizeDailyLabel('pet-petshop',{dict});assert.equal(tokens.get('pet pet'),2);assert.equal(tokens.get('pet pet shop'),3);
});
test('invalid host inputs fail rather than analyzing arbitrary URLs',()=>{
 for(const domain of ['https://example.com/path','not a domain','-bad.com'])assert.throws(()=>namingProfile(domain,{dict}));
});

test('forced short dictionary fragments stay unresolved instead of inventing a phrase',()=>{
 const p=namingProfile('abeardedyogi.com',{dict:new Set(['ab','ea','rd','ed','yogi'])});
 assert.deepEqual(p.components.map(c=>c.text),['abeardedyogi']);
 assert.equal(p.status,'unresolved');
});
test('health-insurance names receive insurance positioning instead of a medical-practice claim',()=>{
 const p=namingProfile('healthinsurance.com',{dict:new Set(['health','insurance'])});
 assert.ok(p.buyerClasses.includes('insurance-information publishers'));
 assert.equal(p.buyerClasses.includes('professional practices'),false);
});

test('partial English-looking suffixes preserve the unknown prefix and disclose uncertainty',()=>{
 const p=namingProfile('aandeimports.com',{dict:new Set(['imports'])});
 assert.equal(p.partialSegmentation,true);
 assert.deepEqual(p.components.map(c=>c.text),['aande','imports']);
 assert.deepEqual(p.unresolvedComponents,['aande']);
 assert.ok(p.buyerClasses.includes('import/export businesses'));
 assert.match(p.analysis,/language and intended segmentation remain unverified/);
});
test('technical plus place includes community uses and the geographic alternative',()=>{
 const p=namingProfile('InferenceValley.com',{dict});
 assert.ok(p.buyerClasses.includes('specialist community or ecosystem operators'));
 assert.ok(p.commercialUses.some(x=>x.includes('incubator')));
 assert.ok(p.alternatives.some(x=>x.includes('geography')));
});
