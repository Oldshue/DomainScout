'use strict';
const {readUtf8Credential}=require('../lib/device-credential-store');
const cache=new Map();
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
let credential, credentialRequest, lastCredentialAttempt=0;
async function readRailwayCredential(env, executeImpl=execute){
        const {stdout}=await executeImpl(env.DOMAINSCOUT_RAILWAY_BIN||'/opt/homebrew/bin/railway',['ssh','--project',env.DOMAINSCOUT_SALE_WATCH_RAILWAY_PROJECT,'--service','domainscout','--environment','production','node','-e','process.stdout.write(JSON.stringify({domainScoutReadToken:process.env.DOMAINSCOUT_AGENT_TOKEN||""})+"\\n")'],{timeout:30000,maxBuffer:65536});
        for(const line of stdout.split(/\r?\n/)){try{const value=JSON.parse(line).domainScoutReadToken;if(typeof value==='string'&&value.length>=16&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value))return value;}catch{}}
  return '';
}
async function cloudCredential(env) {
  if(env.DOMAINSCOUT_AGENT_TOKEN)return env.DOMAINSCOUT_AGENT_TOKEN;
  if(credential)return credential;
  if(credentialRequest)return credentialRequest;
  if(Date.now()-lastCredentialAttempt<60000)return '';
  lastCredentialAttempt=Date.now();
  credentialRequest=(async()=>{
    try{credential=readUtf8Credential({service:'domainscout.cloud',account:'read'});}catch{credential='';}
    // Optional owner-provisioned recovery: use existing authenticated Railway SSH.
    // The service token stays in memory; no plaintext credential file is created.
    if(!credential && env.DOMAINSCOUT_SALE_WATCH_RAILWAY_PROJECT){
      try{
        credential=await readRailwayCredential(env);
      }catch{/* Keep authentication material and subprocess diagnostics out of responses. */}
    }
    return credential||'';
  })();
  try{return await credentialRequest;}finally{credentialRequest=null;}

}
async function readCloudLedger({env=process.env,fetchImpl=fetch,query='',token}={}){
  if(env.RAILWAY_VOLUME_MOUNT_PATH||env.RAILWAY_PROJECT_ID)return null;
  const secret=token??await cloudCredential(env);
  if(!secret)return env.DOMAINSCOUT_SALE_WATCH_RAILWAY_PROJECT ? {error:'Cloud authentication unavailable; showing local observations'} : null;
  const base=env.DOMAINSCOUT_SALE_WATCH_CLOUD_URL||'https://domainscout-production-ea0f.up.railway.app';
  if(!base.startsWith('https://'))return {error:'Cloud reconstruction URL must use HTTPS'};
  const key=base+'|'+query, prior=cache.get(key);
  if(prior&&Date.now()-prior.at<30000)return prior.value;
  try{
    const response=await fetchImpl(base+'/api/sale-watch'+(query?'?q='+encodeURIComponent(query):''),{headers:{'x-domainscout-token':secret},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(response.status===401){credential='';lastCredentialAttempt=0;}
    if(!response.ok)throw Error('Cloud reconstruction unavailable (HTTP '+response.status+')');
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>32*1024*1024)throw Error('Cloud reconstruction response exceeds safety bound');chunks.push(chunk);}
    const ledger=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(ledger.schema!=='domainscout.sale-watch-ledger/v1'||!Array.isArray(ledger.entries))throw Error('Cloud reconstruction response is invalid');
    const value={ledger,fetchedAt:new Date().toISOString()};if(cache.size>=16)cache.delete(cache.keys().next().value);cache.set(key,{at:Date.now(),value});return value;
  }catch(error){return {error:String(error.message).replace(/https?:\/\/\S+/g,'upstream')};}
}
module.exports={readCloudLedger,readRailwayCredential};
