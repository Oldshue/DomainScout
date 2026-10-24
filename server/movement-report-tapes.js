'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
function* lines(file,hash){
 const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(64*1024),decoder=new StringDecoder('utf8');let pending='';
 try{for(;;){const size=fs.readSync(fd,buffer,0,buffer.length,null);if(!size)break;const chunk=buffer.subarray(0,size);hash.update(chunk);pending+=decoder.write(chunk);let at;while((at=pending.indexOf('\n'))>=0){yield pending.slice(0,at);pending=pending.slice(at+1);}}pending+=decoder.end();if(pending.trim())yield pending;}finally{fs.closeSync(fd);}
}
function readMovementReportTapes(inputs,{from,through,audience='public'}){
 const entries=[],receipts=[],dailyCohorts=new Map();
 for(const input of inputs){
  if(input.accessScope==='organization-internal'&&audience!=='internal')throw Error('Internal-use movement tapes cannot enter a public report');
  for(const key of ['day','prevDay'])if(!/^\d{4}-\d{2}-\d{2}$/.test(input[key]||'')||!Number.isFinite(Date.parse(input[key])))throw Error('Movement tape requires valid '+key);
  if(input.prevDay>=input.day)throw Error('Movement tape interval must have an earlier baseline');
  if(input.day<from||input.prevDay>through)continue;
  const hash=crypto.createHash('sha256'),retained=[],seen=new Set();let rawRows=0,lineNumber=0,relevantRows=0,duplicateSelectionRowsCollapsed=0,canonicalChangedRows=0,rawDroppedRows=0;
  for(const line of lines(input.path,hash)){
   lineNumber++;if(!line.trim())continue;const row=JSON.parse(line);rawRows++;if(row.kind==='dropped')rawDroppedRows++;
   if((!row.kind||row.kind==='changed')&&!(row.selection==='went-live'&&['seller','parking'].includes(row.prev_class)&&row.today_class==='hosting'))canonicalChangedRows++;
   if((row.kind&&!['changed','dropped'].includes(row.kind))||!['seller','parking'].includes(row.prev_class)||!Array.isArray(row.prev_ns)||!row.domain)continue;
   const destination=[...new Set(row.today_ns||[])].sort(),before=[...new Set(row.prev_ns)].sort(),key=destination.join(',');
   if(JSON.stringify(before)===JSON.stringify(destination))continue;
   relevantRows++;
   const movementKey=JSON.stringify([String(row.domain).toLowerCase(),before,destination]);
   if(seen.has(movementKey)){duplicateSelectionRowsCollapsed++;continue;}
   seen.add(movementKey);
   if(key){const cohortKey=input.day+'|'+key;if(!dailyCohorts.has(cohortKey))dailyCohorts.set(cohortKey,new Set());dailyCohorts.get(cohortKey).add(String(row.domain).toLowerCase());}
   retained.push({row,destination,lineNumber});
  }
  const sha256=hash.digest('hex'),bytes=fs.statSync(input.path).size;
  if(input.sha256&&input.sha256!==sha256)throw Error('Movement tape digest mismatch');
  if(input.bytes!==undefined&&input.bytes!==bytes)throw Error('Movement tape byte count mismatch');
  if(input.expectedChanged!==undefined&&input.expectedChanged!==canonicalChangedRows)throw Error('Movement tape changed-row coverage mismatch');
  if(input.expectedDropped!==undefined&&input.expectedDropped!==rawDroppedRows)throw Error('Movement tape removed-row coverage mismatch');
  const intervalDays=(Date.parse(input.day)-Date.parse(input.prevDay))/86400000;
  const receipt={accessScope:input.accessScope||'public',day:input.day,prevDay:input.prevDay,observedAt:input.observedAt||null,sourceAsOf:input.sourceAsOf||null,baselineAsOf:input.baselineAsOf||null,sha256,bytes,rawRows,canonicalChangedRows,rawDroppedRows,retainedRemovedDelegations:retained.filter(x=>x.row.kind==='dropped').length,fullRemovedTapeVerified:!!input.sha256&&input.expectedDropped!==undefined&&input.expectedDropped===rawDroppedRows,fullChangedTapeVerified:!!input.sha256&&input.expectedChanged===canonicalChangedRows,sellerOrParkingOriginChanges:retained.length,sellerOrParkingDepartures:retained.filter(x=>['hosting','registrar','other'].includes(x.row.today_class)).length,duplicateSelectionRowsCollapsed,otherRowsRetainedInSource:rawRows-relevantRows,integrityVerified:!!input.sha256,intervalDays};
  receipts.push(receipt);
  for(const {row,destination,lineNumber} of retained){
   const observation=input.zoneObservations?.[String(row.domain).split('.').at(-1)]||input;
   entries.push({domain:row.domain,departureDate:input.day,reportDate:input.day,venue:row.prev_provider||null,sellerNameservers:row.prev_ns,buyerNameservers:destination,sourceUrl:input.sourceUrl||null,lastObservedAt:input.observedAt||null,sourceReceipt:{sha256,lineNumber,kind:row.kind||'changed',day:input.day,prevDay:input.prevDay,intervalDays,sourceAsOf:observation.sourceAsOf||null,baselineAsOf:observation.baselineAsOf||null,observedAt:observation.observedAt||input.observedAt||null,integrityVerified:!!input.sha256},discovery:{departureDate:input.day,structurallyMoved:true,parentDelegation:{checkedAt:input.observedAt||null},movement:{kind:row.kind||'changed',day:input.day,prevDay:input.prevDay,previousNameservers:row.prev_ns,currentNameservers:destination,previousClass:row.prev_class,currentClass:row.today_class,previousProvider:row.prev_provider||null,currentProvider:row.today_provider||null,cohortSize:0,source:'daily-zone-delegation-diff'}}});
  }
 }
 for(const entry of entries){const m=entry.discovery.movement;m.cohortSize=dailyCohorts.get(m.day+'|'+m.currentNameservers.join(','))?.size||0;}
 return {entries,receipts};
}
module.exports={readMovementReportTapes};
