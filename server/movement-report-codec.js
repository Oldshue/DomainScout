'use strict';
function internReportStrings(rows){const interner=createReportStringInterner(rows);return {format:'interned-strings/v1',dictionary:interner.dictionary,rows:interner.encode(rows)}}
function expandReportStrings(input){if(Array.isArray(input))return input;if(input?.format!=='interned-strings/v1'||!Array.isArray(input.dictionary)||input.dictionary.some(s=>typeof s!=='string'))throw Error('Invalid report string dictionary');function decode(x){if(typeof x==='string'&&x.startsWith('~')){if(x.startsWith('~~'))return x.slice(1);if(!/^~(?:0|[1-9]\d*)$/.test(x))throw Error('Invalid report string reference');const i=Number(x.slice(1));if(i>=input.dictionary.length)throw Error('Report string reference is missing');return input.dictionary[i];}if(Array.isArray(x))return x.map(decode);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,decode(v)]));return x;}return decode(input.rows);}
module.exports={internReportStrings,expandReportStrings};
function createReportStringInterner(rows){
 const counts=new Map();function visit(x){if(typeof x==='string')counts.set(x,(counts.get(x)||0)+1);else if(Array.isArray(x))x.forEach(visit);else if(x&&typeof x==='object')Object.values(x).forEach(visit);}visit(rows);
 const dictionary=[...counts].filter(([s,n])=>n>1&&s.length>12).map(([s])=>s),lookup=new Map(dictionary.map((s,i)=>[s,i]));
 function encode(x){if(typeof x==='string')return lookup.has(x)?'~'+lookup.get(x):x.startsWith('~')?'~'+x:x;if(Array.isArray(x))return x.map(encode);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,encode(v)]));return x;}
 return {dictionary,encode};
}
function encodeReportPayload(rows){
 const interner=createReportStringInterner(rows);
 function groups(values,encode){const out=[];let pending=[],chars=2;function flush(){if(!pending.length)return;out.push(require('node:zlib').gzipSync('['+pending.join(',')+']',{level:9}).toString('base64'));pending=[];chars=2;}for(const value of values){const item=JSON.stringify(encode(value));if(pending.length&&chars+item.length+1>1024*1024)flush();pending.push(item);chars+=item.length+1;}flush();return out;}
 return {format:'gzip-interned-chunks/v1',rowCount:rows.length,dictionary:groups(interner.dictionary,x=>x),rows:groups(rows,interner.encode)};
}
async function decodeReportPayload(payload,expand){
 if(payload?.format!=='gzip-interned-chunks/v1'||!Array.isArray(payload.dictionary)||!Array.isArray(payload.rows))throw Error('Invalid report payload');
 async function read(encoded){const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());}
 const dictionary=[];for(const encoded of payload.dictionary)for(const text of await read(encoded))dictionary.push(text);
 const rows=[];for(const encoded of payload.rows){const part=expand({format:'interned-strings/v1',dictionary,rows:await read(encoded)});for(const row of part)rows.push(row);}
 if(rows.length!==payload.rowCount)throw Error('Report payload row coverage mismatch');return rows;
}
module.exports.createReportStringInterner=createReportStringInterner;
module.exports.encodeReportPayload=encodeReportPayload;
module.exports.decodeReportPayload=decodeReportPayload;
