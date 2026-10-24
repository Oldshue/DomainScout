'use strict';
const DAY=86400000;
function daysBetween(from,through){
 const start=Date.parse(from+'T00:00:00Z'),end=Date.parse(through+'T00:00:00Z');
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||new Date(start).toISOString().slice(0,10)!==from||new Date(end).toISOString().slice(0,10)!==through)throw Error('Invalid movement report date window');
 const days=[];for(let at=start;at<=end;at+=DAY)days.push(new Date(at).toISOString().slice(0,10));return days;
}
function auditMovementCoverage({from,through,manifests=[],discovery=null,requiredZones=['com','ai','io','co','net','org','app','dev'],checkedAt=new Date().toISOString(),windowStartUtc=null}={}){
 const days=daysBetween(from,through).map(day=>{
  const candidates=manifests.filter(x=>x.day===day);
  const latest=(list)=>list.sort((a,b)=>String(b.finishedAt||b.startedAt||'').localeCompare(String(a.finishedAt||a.startedAt||'')))[0];
  const m=latest(candidates.filter(x=>x.complete))||latest(candidates);
  if(!m)return {day,status:'missing',collectionComplete:false,dailyComplete:false};
  const inventory=[...new Set(m.inventory||[])],successful=[...new Set((m.zones||[]).map(x=>x.tld))];
  const missing=inventory.filter(z=>!successful.includes(z));
  const baselineDays=[...new Set((m.zones||[]).map(z=>z.diff?.prevDay).filter(Boolean))];
  const windowStart=m.movement?.prevDay||(baselineDays.length===1?baselineDays[0]:null);
  const consecutive=!!windowStart&&Date.parse(day)-Date.parse(windowStart)===DAY;
  const compared=m.movement?.comparedZones||(m.zones||[]).filter(z=>z.diff?.prevDay).length;
  const predatesWindow=!!windowStartUtc&&!!m.finishedAt&&Date.parse(m.finishedAt)<Date.parse(windowStartUtc);
  const retentionComplete=m.movement?.retainsAllChangedDelegations===true&&m.movement?.retainsAllRemovedDelegations===true;
  const collectionComplete=m.complete===true&&inventory.length>0&&!missing.length&&!(m.failed||[]).length;
  return {day,status:predatesWindow?'capture-predates-requested-window':!m.complete?'partial-snapshot':collectionComplete&&consecutive&&compared===inventory.length&&!retentionComplete?'incomplete-movement-retention':collectionComplete&&consecutive&&compared===inventory.length?'complete-daily-diff':'incomplete-diff',collectionComplete,dailyComplete:!predatesWindow&&collectionComplete&&consecutive&&compared===inventory.length&&retentionComplete,snapshotFinishedAt:m.finishedAt||null,observedSnapshotNames:(m.zones||[]).reduce((n,z)=>n+(Number(z.labels)||0),0),zoneCoverage:(m.zones||[]).map(z=>({zone:z.tld,observedAt:z.observedAt||null,sourceAsOf:z.sourceLastModified||null,baselineDay:z.diff?.prevDay||null,rawChanged:z.diff?.counts?.changed??null})),windowStart,windowEnd:day,inventory:inventory.length,successful:successful.length,missingZones:missing,missingResearchZones:requiredZones.filter(z=>!inventory.includes(z)),retainsAllChangedDelegations:m.movement?.retainsAllChangedDelegations===true,retainsAllRemovedDelegations:m.movement?.retainsAllRemovedDelegations===true,rawChanged:m.movement?.totals?.changed??((m.zones||[]).some(z=>z.diff?.counts)?m.zones.reduce((n,z)=>n+(z.diff?.counts?.changed||0),0):null),departureAssociations:m.movement?.departures??((m.zones||[]).some(z=>z.diff)?m.zones.reduce((n,z)=>n+(z.diff?.departures||0),0):null),runId:m.runId};
 });
 const sources=(discovery?.sourceResults||[]).map(s=>({provider:s.provider,nameserver:s.nameserver,exposed:s.exposed??null,totalArchiveRows:s.totalArchiveRows??null,error:s.error||null,paginated:discovery?.coverage?.authenticatedCursorComplete===true}));
 return {schema:'domainscout.movement-report-coverage/v1',checkedAt,from,through,days,requiredZones,sources,discoveryCheckedAt:discovery?.generatedAt||null,configuredDailyDiffComplete:days.every(x=>x.dailyComplete),researchDailyDiffComplete:days.every(x=>x.dailyComplete&&!x.missingResearchZones?.length),globalComplete:false,publicSample:!!discovery&&!discovery.coverage?.authenticatedCursorComplete,notice:'DNS movements are observations, not verified sales. Capped public samples and missing dated tapes cannot establish absence or market-wide trends.'};
}
module.exports={daysBetween,auditMovementCoverage};
