'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
function* lines(file,hash){
 const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(64*1024),decoder=new StringDecoder('utf8');let pending='';
 try{for(;;){const size=fs.readSync(fd,buffer,0,buffer.length,null);if(!size)break;const chunk=buffer.subarray(0,size);hash.update(chunk);pending+=decoder.write(chunk);let at;while((at=pending.indexOf('\n'))>=0){yield pending.slice(0,at);pending=pending.slice(at+1);}}pending+=decoder.end();if(pending.trim())yield pending;}finally{fs.closeSync(fd);}
}
function readMovementReportTapes(inputs,{from,through}){
 const entries=[],receipts=[];
 for(const input of inputs){
  for(const key of ['day','prevDay'])if(!/^\d{4}-\d{2}-\d{2}$/.test(input[key]||'')||!Number.isFinite(Date.parse(input[key])))throw Error('Movement tape requires valid '+key);
  if(input.prevDay>=input.day)throw Error('Movement tape interval must have an earlier baseline');
  if(input.day<from||input.prevDay>through)continue;
  const hash=crypto.createHash('sha256'),retained=[],cohorts=new Map();let rawRows=0,lineNumber=0;
  for(const line of lines(input.path,hash)){
   lineNumber++;if(!line.trim())continue;const row=JSON.parse(line);rawRows++;
   if(row.selection!=='departures'||!['seller','parking'].includes(row.prev_class)||!Array.isArray(row.prev_ns)||!row.domain)continue;
   const destination=[...new Set(row.today_ns||[])].sort(),key=destination.join(',');
   if(key)cohorts.set(key,(cohorts.get(key)||0)+1);
   retained.push({row,destination,lineNumber});
  }
  const sha256=hash.digest('hex'),bytes=fs.statSync(input.path).size;
  if(input.sha256&&input.sha256!==sha256)throw Error('Movement tape digest mismatch');
  if(input.bytes!==undefined&&input.bytes!==bytes)throw Error('Movement tape byte count mismatch');
  const intervalDays=(Date.parse(input.day)-Date.parse(input.prevDay))/86400000;
  const receipt={day:input.day,prevDay:input.prevDay,observedAt:input.observedAt||null,sha256,bytes,rawRows,sellerOrParkingDepartures:retained.length,otherRowsRetainedInSource:rawRows-retained.length,integrityVerified:!!input.sha256,intervalDays};
  receipts.push(receipt);
  for(const {row,destination,lineNumber} of retained){
   entries.push({domain:row.domain,departureDate:input.day,reportDate:input.day,venue:row.prev_provider||null,sellerNameservers:row.prev_ns,buyerNameservers:destination,sourceUrl:input.sourceUrl||null,lastObservedAt:input.observedAt||null,sourceReceipt:{sha256,lineNumber,day:input.day,prevDay:input.prevDay,intervalDays,integrityVerified:!!input.sha256},discovery:{departureDate:input.day,structurallyMoved:true,parentDelegation:{checkedAt:input.observedAt||null},movement:{day:input.day,prevDay:input.prevDay,previousNameservers:row.prev_ns,currentNameservers:destination,previousClass:row.prev_class,currentClass:row.today_class,previousProvider:row.prev_provider||null,currentProvider:row.today_provider||null,cohortSize:destination.length?cohorts.get(destination.join(',')):0,source:'daily-zone-delegation-diff'}}});
  }
 }
 return {entries,receipts};
}
module.exports={readMovementReportTapes};
