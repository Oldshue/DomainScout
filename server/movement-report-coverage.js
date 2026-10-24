'use strict';
const DAY=86400000;
function daysBetween(from,through){
 const start=Date.parse(from+'T00:00:00Z'),end=Date.parse(through+'T00:00:00Z');
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||new Date(start).toISOString().slice(0,10)!==from||new Date(end).toISOString().slice(0,10)!==through)throw Error('Invalid movement report date window');
 const days=[];for(let at=start;at<=end;at+=DAY)days.push(new Date(at).toISOString().slice(0,10));return days;
}
function auditMovementCoverage({from,through,manifests=[],discovery=null,requiredZones=['com','ai','io','co','net','org','app','dev'],checkedAt=new Date().toISOString()}={}){
 const days=daysBetween(from,through).map(day=>{
  const m=manifests.filter(x=>x.day===day&&x.complete).sort((a,b)=>String(b.finishedAt||'').localeCompare(String(a.finishedAt||'')))[0];
  if(!m)return {day,status:'missing',collectionComplete:false,dailyComplete:false};
  const inventory=[...new Set(m.inventory||[])],successful=[...new Set((m.zones||[]).map(x=>x.tld))];
  const missing=inventory.filter(z=>!successful.includes(z));
  const windowStart=m.movement?.prevDay||null;
  const consecutive=!!windowStart&&Date.parse(day)-Date.parse(windowStart)===DAY;
  const compared=m.movement?.comparedZones||0;
  const collectionComplete=inventory.length>0&&!missing.length&&!(m.failed||[]).length;
  return {day,status:collectionComplete&&consecutive&&compared===inventory.length?'complete-daily-diff':'incomplete-diff',collectionComplete,dailyComplete:collectionComplete&&consecutive&&compared===inventory.length,windowStart,windowEnd:day,inventory:inventory.length,successful:successful.length,missingZones:missing,missingResearchZones:requiredZones.filter(z=>!inventory.includes(z)),retainsAllChangedDelegations:m.movement?.retainsAllChangedDelegations===true,rawChanged:m.movement?.totals?.changed??null,departureAssociations:m.movement?.departures??null,runId:m.runId};
 });
 const sources=(discovery?.sourceResults||[]).map(s=>({provider:s.provider,nameserver:s.nameserver,exposed:s.exposed??null,totalArchiveRows:s.totalArchiveRows??null,error:s.error||null,paginated:discovery?.coverage?.authenticatedCursorComplete===true}));
 return {schema:'domainscout.movement-report-coverage/v1',checkedAt,from,through,days,requiredZones,sources,discoveryCheckedAt:discovery?.generatedAt||null,configuredDailyDiffComplete:days.every(x=>x.dailyComplete),researchDailyDiffComplete:days.every(x=>x.dailyComplete&&!x.missingResearchZones?.length),globalComplete:false,publicSample:!!discovery&&!discovery.coverage?.authenticatedCursorComplete,notice:'DNS movements are observations, not verified sales. Capped public samples and missing dated tapes cannot establish absence or market-wide trends.'};
}
module.exports={daysBetween,auditMovementCoverage};
