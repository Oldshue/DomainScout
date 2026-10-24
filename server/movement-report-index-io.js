'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),{StringDecoder}=require('node:string_decoder');
function* lines(file){const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(65536),decoder=new StringDecoder('utf8');let pending='';try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;pending+=decoder.write(buffer.subarray(0,n));let at;while((at=pending.indexOf('\n'))>=0){yield pending.slice(0,at);pending=pending.slice(at+1);}}pending+=decoder.end();if(pending)yield pending;}finally{fs.closeSync(fd)}}
function* serializeReportIndex(receipt,rows){yield '{"serialization":"row-streamed-json/v1","receipt":'+JSON.stringify(receipt)+',"rows":[\n';let first=true;for(const row of rows){yield (first?'':',')+JSON.stringify(row)+'\n';first=false;}yield ']}\n';}
function writeReportIndex(file,receipt,rows){const fd=fs.openSync(file,'w');try{for(const chunk of serializeReportIndex(receipt,rows))fs.writeFileSync(fd,chunk)}finally{fs.closeSync(fd)}}
function readReportIndex(file){
 const iterator=lines(file);let first;try{first=iterator.next().value||''}finally{iterator.return()}
 if(!first.startsWith('{"serialization":"row-streamed-json/v1",')){const legacy=JSON.parse(first.trim().endsWith('}')?first:fs.readFileSync(file,'utf8'));return {receipt:legacy.receipt,rows:legacy.rows||[]};}
 if(!first.endsWith(',"rows":['))throw Error('Invalid streamed index header');const header=JSON.parse(first.slice(0,-9)+'}');
 return {receipt:header.receipt,rows:{*[Symbol.iterator](){let at=0,closed=false,count=0;for(let line of lines(file)){if(at++===0)continue;if(!line.trim())continue;if(closed)throw Error('Unexpected data after index terminator');if(line===']}'){closed=true;continue;}if(line.startsWith(','))line=line.slice(1);count++;yield JSON.parse(line);}if(!closed)throw Error('Truncated streamed report index');if(Number.isSafeInteger(header.receipt?.events)&&header.receipt.events!==count)throw Error('Streamed report index row coverage mismatch');}}};
}
function hashReportIndex(file){const fd=fs.openSync(file,'r'),buf=Buffer.alloc(65536),h=crypto.createHash('sha256');try{for(;;){const n=fs.readSync(fd,buf,0,buf.length,null);if(!n)break;h.update(buf.subarray(0,n));}}finally{fs.closeSync(fd)}return h.digest('hex')}
module.exports={serializeReportIndex,writeReportIndex,readReportIndex,hashReportIndex};
