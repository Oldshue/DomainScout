'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream'),crypto=require('node:crypto');
const {uploadObjectStream}=require('../server/object-store-stream');
const MiB=1024*1024;
function fixture(fail) {
 const calls=[],bodies=[];return {calls,bodies,client:{async send(command){const name=command.constructor.name;calls.push(name);if(fail===name)throw Error('provider failed');if(name==='CreateMultipartUploadCommand')return {UploadId:'fixture-upload'};if(name==='UploadPartCommand'){bodies.push(Buffer.from(command.input.Body));return {ETag:'part-'+bodies.length};}if(name==='PutObjectCommand')bodies.push(Buffer.from(command.input.Body));return {};}}};
}
const request=(f,input,extra={})=>uploadObjectStream({client:f.client,bucket:'fixture',key:'immutable/fixture',input,partBytes:5*MiB,...extra});
test('small and empty streams publish exact bytes without multipart round trips',async()=>{
 for(const body of [Buffer.alloc(0),Buffer.from('independent inventory export')]){const f=fixture(),r=await request(f,Readable.from([body]));assert.deepEqual(f.calls,['PutObjectCommand']);assert.equal(r.bytes,body.length);assert.equal(r.sha256,crypto.createHash('sha256').update(body).digest('hex'));assert.deepEqual(f.bodies[0],body);}
});
test('multipart splits oversized input chunks, preserves order, and returns a full-content receipt',async()=>{
 const f=fixture(),body=Buffer.alloc(11*MiB,71),r=await request(f,Readable.from([body]),{expectedBytes:body.length});assert.deepEqual(f.bodies.map(x=>x.length),[5*MiB,5*MiB,MiB]);assert.deepEqual(Buffer.concat(f.bodies),body);assert.equal(r.sha256,crypto.createHash('sha256').update(body).digest('hex'));assert.equal(f.calls.at(-1),'CompleteMultipartUploadCommand');
});
test('an upload failure aborts the multipart transaction and closes upstream input',async()=>{
 const f=fixture('UploadPartCommand'),input=Readable.from([Buffer.alloc(6*MiB)]);await assert.rejects(request(f,input),/provider failed/);assert.equal(input.destroyed,true);assert.equal(f.calls.at(-1),'AbortMultipartUploadCommand');assert.equal(f.calls.includes('CompleteMultipartUploadCommand'),false);
});
test('producer and length failures cannot publish a completed object',async()=>{
 const f=fixture(),input=Readable.from((async function*(){yield Buffer.alloc(5*MiB);throw Error('source incomplete');})());await assert.rejects(request(f,input),/source incomplete/);assert.equal(f.calls.at(-1),'AbortMultipartUploadCommand');assert.equal(f.calls.includes('CompleteMultipartUploadCommand'),false);
 const g=fixture();await assert.rejects(request(g,Readable.from([Buffer.from('short')]),{expectedBytes:100}),/byte count/);assert.deepEqual(g.calls,[]);
});
test('cancellation during a part upload aborts the transaction instead of completing it',async()=>{
 const f=fixture(),ac=new AbortController(),send=f.client.send;f.client.send=async command=>{const result=await send(command);if(command.constructor.name==='UploadPartCommand')ac.abort(Error('cancelled'));return result;};await assert.rejects(request(f,Readable.from([Buffer.alloc(6*MiB)]),{signal:ac.signal}),/cancelled|abort/i);assert.equal(f.calls.at(-1),'AbortMultipartUploadCommand');assert.equal(f.calls.includes('CompleteMultipartUploadCommand'),false);
});

test('multipart completion failure aborts and never returns a successful receipt',async()=>{
 const f=fixture('CompleteMultipartUploadCommand');await assert.rejects(request(f,Readable.from([Buffer.alloc(6*MiB)])),/provider failed/);assert.equal(f.calls.at(-1),'AbortMultipartUploadCommand');
});

test('slow provider parts apply backpressure to upstream reads',async()=>{
 let produced=0,release,started;const uploading=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});const f=fixture(),send=f.client.send;
 f.client.send=async command=>{if(command.constructor.name==='UploadPartCommand'&&f.bodies.length===0){started();await gate;}return send(command);};
 const input=Readable.from((async function*(){for(let i=0;i<100;i++){produced++;yield Buffer.alloc(128*1024);}})(),{objectMode:false,highWaterMark:128*1024});
 const done=request(f,input);await uploading;await new Promise(resolve=>setImmediate(resolve));assert.ok(produced<60,'producer must not drain the complete input while first part is blocked');release();await done;assert.equal(produced,100);
});


test('a missing file rejects before opening an unobserved source or contacting storage',async()=>{
 const {createS3ObjectStore}=require('../server/recent-registration-corpus');
 const store=createS3ObjectStore({DOMAINSCOUT_EVIDENCE_S3_BUCKET:'fixture',DOMAINSCOUT_EVIDENCE_S3_ENDPOINT:'https://archive.example.invalid',DOMAINSCOUT_EVIDENCE_S3_ACCESS_KEY_ID:'fixture-access',DOMAINSCOUT_EVIDENCE_S3_SECRET_ACCESS_KEY:'fixture-secret'});
 await assert.rejects(store.putFile('fixture',require('node:path').join(require('node:os').tmpdir(),'missing-upload-'+crypto.randomUUID())),{code:'ENOENT'});
});
