// Browser history owns navigation; individual views own their serializable state.
(function(){
 'use strict';
 const views=app._navigationViews||(app._navigationViews={});
 const researchFields=['_researchAllNames','_researchBaseList','_researchTerms','_researchQuery','_researchAvailable','_researchHasMore','_researchPage','_researchPageSize','_researchSortKey','_researchSortDir','_landerResults','_tldLists','_hybridCounts','_researchMode'];
 views._research={
  capture:()=>({data:Object.fromEntries(researchFields.map(k=>[k,app[k]])),inputs:[...document.querySelectorAll('#research-panel input[id],#research-panel select[id]')].map(el=>({id:el.id,value:el.value,checked:el.checked})),status:document.getElementById('research-status')?.textContent||''}),
  apply:s=>{if(!s)return;Object.assign(app,s.data);app.setResearchMode?.(app._researchMode||'prefix');app._researchTldCheckGen++;app._landerCheckGen++;for(const input of s.inputs||[]){const el=document.getElementById(input.id);if(el){el.value=input.value;if(typeof input.checked==='boolean')el.checked=input.checked;}}},
  restore:s=>{if(!s)return;document.getElementById('research-btn').disabled=false;document.getElementById('research-btn').textContent='Analyze →';document.getElementById('research-status').textContent=s.status;const has=app._researchBaseList?.length>0;document.getElementById('research-results').style.display=has?'block':'none';document.getElementById('research-help').style.display=has?'none':'block';if(has)app.renderResearchResults();}
 };
 function formValues(panel){return [...document.querySelectorAll('#'+panel+' input[id]:not([type=file]),#'+panel+' select[id]')].map(e=>({id:e.id,value:e.value,checked:e.checked}));}
 function applyForms(values){for(const input of values||[]){const e=document.getElementById(input.id);if(e){e.value=input.value;if(typeof input.checked==='boolean')e.checked=input.checked;}}}
 views._salewatch={capture:()=>({inputs:formValues('sale-watch-panel')}),apply:s=>{applyForms(s?.inputs);app._saleWatchQuery=document.getElementById('sale-watch-search').value.trim().toLowerCase();},restore:async()=>{await app.loadSaleWatch(true);app.renderSaleWatch();}};
 for(const [stream,panel,outputs] of [['_lookup','lookup-panel',['lookup-status','lookup-results']],['_trending','trending-panel',['trending-status','trending-content','trending-no-data']],['_tldgrowth','tldgrowth-panel',['tldgrowth-status','tldgrowth-content','tldgrowth-no-data']]]){
  views[stream]={capture:()=>({inputs:formValues(panel),outputs:outputs.map(id=>{const e=document.getElementById(id);return {id,html:e.innerHTML,display:e.style.display};}),base:app._lookupLastResultBase}),apply:s=>applyForms(s?.inputs),restore:s=>{if(!s)return;for(const row of s.outputs){const e=document.getElementById(row.id);e.innerHTML=row.html;e.style.display=row.display;}if(stream==='_lookup'){app._lookupLastResultBase=s.base;document.getElementById('lookup-btn').disabled=false;document.getElementById('lookup-btn').textContent='Lookup →';}}};
 }
 const filters=['stream','tld','q','searchMode','sortField','sortDir','sortExplicit','page','limit','minLength','maxLength','minAge','maxAge','maxPrice','minTlds','noNumbers','noHyphens','hasWayback','dnsAvailable','hasBids','hideSkipped','expiryToday','dateWindow','domainSuffix','takenInMode','takenInMatch'];
 let restoring=false,lastSearchAt=0,lastSearchName='',scrollTimer=null,activeModal=null,restorationVersion=0;
 function capture(){return {version:1,modal:activeModal,filters:Object.fromEntries(filters.map(k=>[k,state[k]])),takenInTlds:[...state.takenInTlds],view:views[state.stream]?.capture()||null,scrollY:window.scrollY,tableScroll:document.getElementById('table-wrap')?.scrollTop||0,panelScroll:Object.fromEntries(app._toolPanels.map(stream=>[stream,document.getElementById(({_research:'research-panel',_lookup:'lookup-panel',_trending:'trending-panel',_tldgrowth:'tldgrowth-panel',_salewatch:'sale-watch-panel',_zoneintel:'zone-intelligence-panel',_domainlab:'domainlab-panel'})[stream])?.scrollTop||0]))};}
 function signature(s){return JSON.stringify([s.filters,s.takenInTlds,s.view,s.modal]);}
 function saveScroll(){const h=history.state?.domainScout;if(!h)return;history.replaceState({...history.state,domainScout:{...h,panelScroll:capture().panelScroll,scrollY:window.scrollY,tableScroll:document.getElementById('table-wrap')?.scrollTop||0}},'');}
 function record(url=null,replace=false){
  if(restoring||app._restoringFromUrl)return;
  const next=capture(),old=history.state?.domainScout;
  if(!url){const p=new URLSearchParams(location.search);p.set('stream',state.stream);url='?'+p;}
  if(old&&signature(old)===signature(next)){history.replaceState({...history.state,domainScout:{...old,...next,scrollY:old.scrollY,tableScroll:old.tableScroll}},'',url);return;}
  next.entryId=Date.now().toString(36)+Math.random().toString(36).slice(2);next.previousStream=old?.filters?.stream;next.previousView=old?.view?.view;const payload={domainScout:next};
  if(!old||replace)history.replaceState(payload,'',url);else history.pushState(payload,'',url);
 }
 app.navigation={record,saveScroll,async restore(snapshot){
  if(!snapshot||snapshot.version!==1)return false;
  const version=++restorationVersion;restoring=true;app._restoringFromUrl=true;
  try{
   app.cancelDomainLoad();app._trendingGeneration=(app._trendingGeneration||0)+1;app._tldGrowthGeneration=(app._tldGrowthGeneration||0)+1;app._researchNavigationGeneration=(app._researchNavigationGeneration||0)+1;app._lookupNavigationGeneration=(app._lookupNavigationGeneration||0)+1;for(const close of ['closeModal','closeTldModal','closeTrendDetail'])app[close]();Object.assign(state,snapshot.filters);state.takenInTlds=new Set(snapshot.takenInTlds||[]);
   app.syncControlsFromState();
   const adapter=views[state.stream];if(adapter)adapter.apply(snapshot.view);
   if(app._toolPanels.includes(state.stream)){await app.setStream(state.stream);if(version!==restorationVersion)return true;if(adapter)await adapter.restore(snapshot.view);}
   else {app._hideAllToolPanels();await app.loadDomains();}
   if(version!==restorationVersion)return true;
   if(snapshot.modal){if(snapshot.modal.domain)state.domainMap[snapshot.modal.args[0]]=snapshot.modal.domain;await app[snapshot.modal.method](...snapshot.modal.args);}
   window.scrollTo(0,snapshot.scrollY||0);const table=document.getElementById('table-wrap');if(table)table.scrollTop=snapshot.tableScroll||0;for(const [stream,y] of Object.entries(snapshot.panelScroll||{})){const panel=document.getElementById(({_research:'research-panel',_lookup:'lookup-panel',_trending:'trending-panel',_tldgrowth:'tldgrowth-panel',_salewatch:'sale-watch-panel',_zoneintel:'zone-intelligence-panel',_domainlab:'domainlab-panel'})[stream]);if(panel)panel.scrollTop=y;}
   return true;
  }finally{if(version===restorationVersion){restoring=false;app._restoringFromUrl=false;}}
 }};
 const interruptRestore=event=>{if(event.isTrusted&&restoring){restorationVersion++;restoring=false;app._restoringFromUrl=false;}};
 window.addEventListener('pointerdown',interruptRestore,true);window.addEventListener('keydown',interruptRestore,true);
 const setStream=app.setStream.bind(app);
 app.setStream=function(stream){if(!restoring){const old=history.state?.domainScout;if(old)history.replaceState({domainScout:{...capture(),entryId:old.entryId,previousStream:old.previousStream,previousView:old.previousView}},'');}const result=setStream(stream);state.stream=stream;lastSearchAt=0;if(!restoring)window.scrollTo(0,0);if(app._toolPanels.includes(stream))record();return result;};
 // Capture the state before destructive rerenders, then commit the resulting view.
 app.navigation.wrap=function(name,{search=false}={}){const original=app[name];if(typeof original!=='function')return;app[name]=function(...args){if(!restoring)saveScroll();const result=original.apply(this,args);if(!restoring&&['dlDailyOpenToken','dlDailyPattern'].includes(name)){window.scrollTo(0,0);document.getElementById('domainlab-panel').scrollTop=0;}const changed=signature(capture())!==signature(history.state?.domainScout||{});const replace=search&&changed&&lastSearchName===name&&Date.now()-lastSearchAt<1000;if(search&&changed&&!restoring){lastSearchAt=Date.now();lastSearchName=name;}record(null,replace);return result;};};
 for(const name of ['dlDailySetPeriod','dlDailySetDate','dlDailySetZone','dlDailySort','dlDailyMode','dlDailyToggleAllZones','dlDailyWordFilter','dlDailyClearWords','dlDailyPerPage','domainlabSort','domainlabZonesSort','domainlabToggleZones','domainlabDrill','dlDailyTokenPage','dlDailyDomainPage','dlDailyOpenToken','dlDailyPattern','dlShowAnalytics'])app.navigation.wrap(name);
 const back=app.dlDailyBack;app.dlDailyBack=function(){if(history.state?.domainScout?.previousStream==='_domainlab'){history.back();return;}const result=back.apply(this,arguments);record();return result;};
 app.navigation.wrap('dlDailySearch',{search:true});
 app.navigation.wrap('renderSaleWatch',{search:true});
 for(const name of ['setResearchMode','researchSort','runResearch','researchGoPage','setResearchPageSize','applyResearchFilter','runLookup','zoneSetMode','zoneLoad','zoneDrillToken','zoneReadLocal']){
  const original=app[name];app[name]=function(...args){if(!restoring)saveScroll();const result=original.apply(this,args);record();const entry=history.state?.domainScout?.entryId;
   if(result?.then)result.then(()=>{if(!restoring&&history.state?.domainScout?.entryId===entry)record(null,true);},()=>{});return result;};
 }
 for(const method of ['openModal','openTldModal','openTrendKeyword']){
  const original=app[method];app[method]=function(...args){if(!restoring)saveScroll();const result=original.apply(this,args);const saved=method==='openTldModal'?[args[0],args[1],null,args[3]||{}]:args;activeModal={method,args:JSON.parse(JSON.stringify(saved)),domain:method==='openModal'?state.modalDomain:null};record();return result;};
 }
 for(const method of ['closeModal','closeTldModal','closeTrendDetail']){const original=app[method];app[method]=function(...args){const result=original.apply(this,args);activeModal=null;record();return result;};}
 const scheduleScroll=()=>{if(restoring||scrollTimer)return;scrollTimer=setTimeout(()=>{scrollTimer=null;if(!restoring)saveScroll();},150);};
 window.addEventListener('scroll',scheduleScroll,{passive:true});
 for(const id of ['research-panel','lookup-panel','trending-panel','tldgrowth-panel','sale-watch-panel','zone-intelligence-panel','domainlab-panel'])document.getElementById(id)?.addEventListener('scroll',scheduleScroll,{passive:true});
 document.getElementById('table-wrap')?.addEventListener('scroll',scheduleScroll,{passive:true});
 document.addEventListener('DOMContentLoaded',()=>{if(!history.state?.domainScout)record(null,true);});
})();
