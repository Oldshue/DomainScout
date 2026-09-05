'use strict';
const {readUtf8Credential}=require('../lib/device-credential-store');
const cache=new Map();
let credential;
function cloudCredential(env) {
  if(env.DOMAINSCOUT_AGENT_TOKEN)return env.DOMAINSCOUT_AGENT_TOKEN;
  if(credential!==undefined)return credential;
  try{credential=readUtf8Credential({service:'domainscout.cloud',account:'read'});}catch{credential='';}
  return credential;
}
async function readCloudLedger({env=process.env,fetchImpl=fetch,query='',token}={}){
  if(env.RAILWAY_VOLUME_MOUNT_PATH||env.RAILWAY_PROJECT_ID)return null;
  const secret=token??cloudCredential(env);
  if(!secret)return null;
  const base=env.DOMAINSCOUT_SALE_WATCH_CLOUD_URL||'https://domainscout-production-ea0f.up.railway.app';
  if(!base.startsWith('https://'))return {error:'Cloud reconstruction URL must use HTTPS'};
  const key=base+'|'+query, prior=cache.get(key);
  if(prior&&Date.now()-prior.at<30000)return prior.value;
  try{
    const response=await fetchImpl(base+'/api/sale-watch'+(query?'?q='+encodeURIComponent(query):''),{headers:{'x-domainscout-token':secret},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('Cloud reconstruction unavailable (HTTP '+response.status+')');
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>32*1024*1024)throw Error('Cloud reconstruction response exceeds safety bound');chunks.push(chunk);}
    const ledger=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(ledger.schema!=='domainscout.sale-watch-ledger/v1'||!Array.isArray(ledger.entries))throw Error('Cloud reconstruction response is invalid');
    const value={ledger,fetchedAt:new Date().toISOString()};if(cache.size>=16)cache.delete(cache.keys().next().value);cache.set(key,{at:Date.now(),value});return value;
  }catch(error){return {error:String(error.message).replace(/https?:\/\/\S+/g,'upstream')};}
}
module.exports={readCloudLedger};
