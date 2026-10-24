'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {internReportStrings,expandReportStrings}=require('../server/movement-report-codec');
test('string interning preserves every record, type, Unicode and marker-like literal',()=>{
const repeated='Identical evidence repeated across many independent observations.';
const rows=Array.from({length:1000},(_,i)=>({id:i,domain:'δοκιμή-'+i+'.com',evidence:repeated,nested:{literal:'~0',escaped:'~~1',unknown:null,flag:false,numeric:-1,arr:['~',repeated]},s:i}));
const packed=internReportStrings(rows);assert.deepEqual(expandReportStrings(packed),rows);assert.deepEqual(expandReportStrings(rows),rows);assert.ok(JSON.stringify(packed).length<JSON.stringify(rows).length);
});
test('invalid references fail rather than silently dropping evidence',()=>{
assert.throws(()=>expandReportStrings({format:'interned-strings/v1',dictionary:[],rows:['~5']}),/missing/);assert.throws(()=>expandReportStrings({format:'interned-strings/v1',dictionary:[],rows:['~wat']}),/Invalid/);assert.throws(()=>expandReportStrings({format:'other',dictionary:[],rows:[]}),/Invalid/);
});
test('chunked payload preserves every record, Unicode and escaped markers across compressed members',async()=>{
 const codec=require('../server/movement-report-codec'),rows=Array.from({length:4000},(_,i)=>({domain:'name'+i+'.test',semantic:'Shared interpretation '.repeat(20),unique:'x'.repeat(500)+i,literal:'~0',nested:{values:[i,null,'界']}}));const payload=codec.encodeReportPayload(rows);assert.ok(payload.rows.length>1);assert.deepEqual(await codec.decodeReportPayload(payload,codec.expandReportStrings),rows);payload.rowCount++;await assert.rejects(codec.decodeReportPayload(payload,codec.expandReportStrings),/coverage mismatch/);
});
