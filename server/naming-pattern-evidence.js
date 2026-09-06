'use strict';
const {discoverFragments}=require('./daily-fragments');
const {readableExtension,keywordUse}=require('./keyword-language');
const {weightedLabels,signalWeight,SUFFIX_WEIGHTS,SIGNAL_POLICY_NOTE}=require('./domain-signal-policy');

// Describes observed labels and dates, never inferred registrants or purchases.
function buildNamingPatternEvidence(rows,{token,date,dictionary=new Set(),related=[],observedDates=null}={}){
 const matches=rows.filter(r=>signalWeight(r.tld)>0 && r.base_name.includes(token) && keywordUse(r.base_name,token,dictionary) && (!related.length || related.some(t=>keywordUse(r.base_name,t,dictionary))));
 const labels=[...new Set(matches.map(r=>r.base_name))];
 const current=matches.filter(r=>r.report_date===date), prior=matches.filter(r=>r.report_date!==date);
 const currentLabels=[...new Set(current.map(r=>r.base_name))];
 const days=[...new Set(observedDates || rows.map(r=>r.report_date))].sort();
 const history=days.map(day=>{const found=matches.filter(r=>r.report_date===day);return{date:day,domains:found.length,labels:new Set(found.map(r=>r.base_name)).size};});
 const suffixes=[...new Set(matches.map(r=>r.tld))].sort().map(tld=>({tld,domains:matches.filter(r=>r.tld===tld).length,labels:new Set(matches.filter(r=>r.tld===tld).map(r=>r.base_name)).size}));
 const templates=new Map();for(const label of labels){if(!/\d/.test(label))continue;const shape=label.replace(/\d+/g,'#');templates.set(shape,(templates.get(shape)||0)+1);}
 const largestNumericCohort=Math.max(0,...templates.values());
 const families=discoverFragments(labels,{minSupport:2}).filter(r=>r.visible && readableExtension(r.token,token,dictionary)).map(r=>{
   const found=matches.filter(x=>x.base_name.includes(r.token)&&keywordUse(x.base_name,r.token,dictionary));
   return {pattern:r.token,labels:new Set(found.map(x=>x.base_name)).size,activeDays:new Set(found.map(x=>x.report_date)).size,currentDomains:found.filter(x=>x.report_date===date).length,priorDomains:found.filter(x=>x.report_date!==date).length,examples:[...new Set(found.filter(x=>x.report_date===date).map(x=>x.base_name+'.'+x.tld))].slice(0,4)};
 }).filter(x=>x.currentDomains>0&&x.labels>=2).sort((a,b)=>b.currentDomains-a.currentDomains||b.activeDays-a.activeDays||b.labels-a.labels||a.pattern.localeCompare(b.pattern)).slice(0,12);
 const activeDays=history.filter(x=>x.domains>0).length;
 const weightedCurrentLabels=weightedLabels(current),weightedDistinctLabels=weightedLabels(matches);
 const reasons=[];
 if(weightedCurrentLabels<3)reasons.push('Fewer than three relevance-weighted readable labels on the selected day');
 if(weightedDistinctLabels<10)reasons.push('Fewer than ten relevance-weighted readable labels in the comparison window');
 if(activeDays<3)reasons.push('Observed on fewer than three separate days');
 if(labels.length && largestNumericCohort/labels.length>0.5)reasons.push('A numeric template dominates the observed labels');
 const sharedLabels=labels.filter(label=>new Set(matches.filter(r=>r.base_name===label).map(r=>r.tld)).size>1).length;
 return {version:1,token,related,date,signalWeights:SUFFIX_WEIGHTS,weightedCurrentLabels,weightedDistinctLabels,weightedCurrentDomains:current.reduce((n,x)=>n+signalWeight(x.tld),0),weightedPriorDomains:prior.reduce((n,x)=>n+signalWeight(x.tld),0),excludedSuffixes:['xyz','shop','info'],currentDomains:current.length,currentLabels:currentLabels.length,priorDomains:prior.length,distinctLabels:labels.length,activeDays,windowDays:days.length,suffixes,sharedLabels,largestNumericCohort,history,families,
   registrationReview:{passed:reasons.length===0,reasons,policy:SIGNAL_POLICY_NOTE+' At least 3 weighted current labels, 10 weighted window labels and 3 active days; numeric templates cannot dominate. This is a research triage rule, not proof of buyer demand.'},
   registrants:'unknown',acquisitionRecommendation:false,
   names:matches.map(r=>({domain:r.base_name+'.'+r.tld,date:r.report_date})).sort((a,b)=>b.date.localeCompare(a.date)||a.domain.localeCompare(b.domain))};
}
module.exports={buildNamingPatternEvidence};
