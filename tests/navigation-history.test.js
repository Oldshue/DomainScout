'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 const listeners={},entries=[],elements=new Map();let cursor=-1;
 const element=id=>{if(!elements.has(id))elements.set(id,{id,value:'',checked:false,style:{},scrollTop:0,innerHTML:'',textContent:'',addEventListener(){}});return elements.get(id);};
 const state={stream:'godaddy-closeout',q:'agent',page:3,limit:50,takenInTlds:new Set(['ai'])};let view={period:'week',zone:'dev',view:'tokens'};
 const app={_toolPanels:['_domainlab','_research','_salewatch','_lookup'],_navigationViews:{_domainlab:{capture:()=>({...view}),apply:s=>{view={...s};},restore:async()=>{}}},setStream:s=>{state.stream=s;},cancelDomainLoad(){},syncControlsFromState(){},_hideAllToolPanels(){},loadDomains:async()=>{},dlDailyOpenToken:t=>{view={...view,view:'domains',token:t};},dlDailyBack:()=>{view.view='tokens';},closeModal(){},closeTldModal(){},closeTrendDetail(){},openModal(){},openTldModal(){},openTrendKeyword(){}};
 const location={search:'?stream=godaddy-closeout&q=agent',pathname:'/'};
 const history={get state(){return entries[cursor]||null;},replaceState(s,_,url){if(cursor<0)cursor=0;entries[cursor]=structuredClone(s);if(url)location.search=url;},pushState(s,_,url){entries.splice(++cursor);entries.push(structuredClone(s));if(url)location.search=url;},back(){}};
 const window={scrollY:0,scrollTo(_,y){this.scrollY=y;},addEventListener:(name,fn)=>{listeners[name]=fn;}};
 const document={getElementById:element,querySelectorAll:()=>[],addEventListener(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/navigation-history.js'),'utf8'),{app,state,history,location,window,document,URLSearchParams,Date,Math,JSON,setTimeout,clearTimeout});
 return {app,state,history,entries,element,window,listeners,getView:()=>view};
}
test('history restores tool detail state, catalog filters and the actual scrolling panel',async()=>{
 const f=fixture();f.app.navigation.record();const catalog=structuredClone(f.history.state.domainScout);
 f.app.setStream('_domainlab');f.element('domainlab-panel').scrollTop=650;f.app.dlDailyOpenToken('studio');
 const prior=f.entries[f.entries.length-2].domainScout;assert.equal(prior.view.period,'week');assert.equal(prior.panelScroll._domainlab,650);
 await f.app.navigation.restore(prior);assert.equal(f.getView().view,'tokens');assert.equal(f.element('domainlab-panel').scrollTop,650);
 await f.app.navigation.restore(catalog);assert.equal(f.state.stream,'godaddy-closeout');assert.equal(f.state.q,'agent');assert.equal(f.state.page,3);assert.deepEqual([...f.state.takenInTlds],['ai']);
});
test('new user navigation cancels a slow restore instead of losing the new action',async()=>{
 const f=fixture();f.app.navigation.record();f.app.setStream('_domainlab');const target=structuredClone(f.history.state.domainScout);target.scrollY=900;
 let release,started;const ready=new Promise(r=>started=r);f.app._navigationViews._domainlab.restore=()=>{started();return new Promise(r=>release=r);};
 const pending=f.app.navigation.restore(target);await ready;f.listeners.pointerdown({isTrusted:true});f.app.setStream('_lookup');release();await pending;
 assert.equal(f.state.stream,'_lookup');assert.equal(f.history.state.domainScout.filters.stream,'_lookup');assert.equal(f.window.scrollY,0);
});
test('restoring history invalidates pending legacy analytics responses',async()=>{
 const f=fixture();f.app.navigation.record();const snapshot=structuredClone(f.history.state.domainScout);
 f.app._trendingGeneration=4;f.app._tldGrowthGeneration=8;
 await f.app.navigation.restore(snapshot);
 assert.equal(f.app._trendingGeneration,5);assert.equal(f.app._tldGrowthGeneration,9);
});
test('obsolete analytics requests cannot overwrite restored results',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
 for(const [name,field] of [['Trending','_trendingGeneration'],['TldGrowth','_tldGrowthGeneration']]){
  const start=source.indexOf('  async load'+name+'() {'),end=source.indexOf('\n  },',start);
  let release;const elements=new Map();const document={getElementById(id){if(!elements.has(id))elements.set(id,{textContent:'',style:{}});return elements.get(id);}};
  const fn=vm.runInNewContext('({'+source.slice(start,end)+'\n}}).load'+name,{document,fetch:()=>new Promise(r=>release=r)});
  const app={};const pending=fn.call(app);app[field]++;for(const el of elements.values())el.textContent='restored';
  release({json:async()=>({hasData:false})});await pending;
  for(const el of elements.values())assert.equal(el.textContent,'restored');
 }
});
test('a drilldown snapshots rendered output and expanded state before destroying the view',()=>{
 const f=fixture();f.app.navigation.record();f.app.setStream('_domainlab');
 f.getView().html='<details open>Cached month</details>';f.getView().report={names:2000000};
 f.app.dlDailyOpenToken('studio');
 const prior=f.entries[f.entries.length-2].domainScout;
 assert.equal(prior.view.html,'<details open>Cached month</details>');assert.equal(prior.view.report.names,2000000);
});

test('a restored adapter refreshes the current snapshot without adding a Back entry',async()=>{
 const f=fixture();f.app.navigation.record();f.app.setStream('_domainlab');const target=structuredClone(f.history.state.domainScout);const size=f.entries.length;
 target.view.signalPolicyVersion=1;target.view.html='obsolete';
 f.app._navigationViews._domainlab.restore=async()=>{f.getView().signalPolicyVersion=2;f.getView().html='fresh';};
 await f.app.navigation.restore(target);
 assert.equal(f.entries.length,size);assert.equal(f.history.state.domainScout.entryId,target.entryId);assert.equal(f.history.state.domainScout.previousStream,target.previousStream);assert.equal(f.history.state.domainScout.view.signalPolicyVersion,2);assert.equal(f.history.state.domainScout.view.html,'fresh');assert.equal(f.history.state.domainScout.view.period,'week');
});
