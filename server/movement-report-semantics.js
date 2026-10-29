'use strict';
const {domainToASCII,domainToUnicode}=require('node:url');
const {loadDictionary,segmentDailyLabel}=require('./domainlab');
const VERSION='naming-profile/v1';
// Exact segmented terms only. A substring such as "ai" inside "chair" is not evidence.
const THEMES=[
 {id:'trade',words:'import imports importer export exports exporter wholesale',meaning:'trade or distribution',buyers:['import/export businesses','specialist distributors'],uses:['a trading-company identity','product sourcing or supply information']},
 {id:'food',words:'food cook cooking kitchen catering coffee tea cafe restaurant restaurants bakery baking cakes pizza',meaning:'food, cooking or hospitality',buyers:['food businesses','specialist content publishers'],uses:['a food or hospitality identity','recipes or specialist product discovery'],alternatives:['kitchen can also describe a room or equipment context']},
 {id:'property',words:'property properties realty housing homes estate apartments',meaning:'property or housing',buyers:['property-service businesses','local information publishers'],uses:['a property-company identity','housing information or discovery']},
 {id:'marketing',words:'agency agencies advertising ads seo leads lead promotion sales crm',meaning:'marketing or customer acquisition',buyers:['marketing-service businesses','sales-software teams'],uses:['a service identity','campaign or lead-management tools']},
 {id:'gaming',words:'casino casinos poker betting bet slots slot game games gaming esports',meaning:'games or gaming-related content',buyers:['game-product teams','specialist publishers'],uses:['a game identity','gaming information or community content'],alternatives:['no licensed gambling operation or actual activity is established']},
 {id:'naming',words:'domain domains naming registrar',meaning:'domain names or naming services',buyers:['naming-service businesses','domain-industry tool teams'],uses:['naming or portfolio tools','domain-related information'],alternatives:['no registration status or domain value is established']},
 {id:'automation',words:'automation automate bot robotics robot robots workflow workflows agent agents',meaning:'automation or an agent-oriented identity',buyers:['operations-software teams','specialist service businesses'],uses:['workflow automation','an agent or representative service identity'],alternatives:['agent may mean a human representative rather than software']},
 {id:'administration',words:'document documents doc docs file filer filing forms form records registry ticket tickets',meaning:'documents, records or administration',buyers:['workflow-software vendors','specialist service providers'],uses:['record or document tools','registration or administrative workflows']},
 {id:'science',words:'quantum vector geometry algorithm algorithms graph graphs scientific research',meaning:'scientific or mathematical positioning',buyers:['research-tool teams','technical consultancies'],uses:['a technical or research identity','specialist software or information'],alternatives:['the technical word may be used metaphorically']},

 {id:'insurance',words:'insurance insurer underwriting',meaning:'insurance information or administration',buyers:['insurance-information publishers','quote-comparison product teams'],uses:['coverage information','insurance-administration workflows'],alternatives:['no insurance authorization or actual policy is established']},
 {id:'furniture',words:'chair chairs furniture sofa sofas bed beds',meaning:'furniture or home goods',buyers:['furniture retailers','home-product businesses'],uses:['a product or retail identity','home-goods information']},
 // modelserving is the joined form of the adjacent words "model serving"; callers that
 // match whole segmented words also offer adjacent-word joins (see themeMatches).
 // subthemes: search-only refinement of the family (namingProfile still reads `words`).
 // A search query expands to its closest sub-theme, never the whole family, unless it
 // names the family id itself. `weak` members (generic English words) count only when
 // a strong member of the same family appears in the same text.
 {id:'ai',words:'ai inference neural cognition chatbot llm llms gpu gpus tensor tensors embeddings transformer gpt modelserving tokens',meaning:'AI computation or reasoning',buyers:['AI infrastructure vendors','AI product teams'],uses:['model-execution tooling','reasoning or assistant software'],alternatives:['academic reasoning or a metaphorical intelligence identity'],
  subthemes:[
   {id:'aiinference',label:'AI inference/compute',words:'inference infer inferencing llm llms gpu gpus tensor tensors modelserving cuda tpu tpus vllm',weak:'serving tokens compute computes computing accelerator accelerators'},
   {id:'aiagents',label:'AI agents',words:'agentic aiagent aiagents copilot copilots chatbot chatbots',weak:'agent agents assistant assistants'},
   {id:'aigenerative',label:'generative AI/media',words:'generative genai gpt chatgpt diffusion texttoimage imagegen',weak:''},
   {id:'aigeneral',label:'general AI',words:'ai ml neural cognition embeddings embedding transformer transformers machinelearning deeplearning',weak:''},
  ]},
 // compute/computing name AI compute (the aiinference sub-theme), never computer repair; computer stays here.
 {id:'developer',words:'code coder coding developer dev software script javascript api programming hosting host server servers deploy deployment app apps digital web network networks platform portal cloud computer',meaning:'software development',buyers:['developer-tool vendors','software consultancies'],uses:['development tools','technical education or engineering services']},
 {id:'data',words:'data analytics database index indexer sync',meaning:'data organization or analysis',buyers:['data-platform teams','analytics providers'],uses:['data management','analysis or integration software']},
 {id:'finance',words:'ledger accounting accountant invoice invoices payment payments pay finance financial fund funds wealth bank money investment investments capital debt loan loans mortgage tax taxes bookkeeping',meaning:'financial administration',buyers:['business-software vendors','professional service firms'],uses:['record keeping or payment workflows','financial information'],alternatives:['an existing company identity; no financial authorization is established']},
 {id:'legal',words:'legal lawyer lawyers law probate trademark counsel',meaning:'legal work or information',buyers:['legal-software vendors','professional practices'],uses:['legal workflow tools','specialist information or professional identity']},
 {id:'home',words:'plumber plumbers plumbing remodeling heating cooling roofing contractor basement',meaning:'building or home services',buyers:['local service businesses','specialist directories'],uses:['a service-company identity','customer information or booking']},
 {id:'travel',words:'travel vacation vacations hotel hotels inn stay tours tourism cruise cruises booking holiday holidays flight flights airline airlines rail trains',meaning:'travel or accommodation',buyers:['hospitality operators','travel-software teams'],uses:['lodging or experience discovery','reservation services']},
 {id:'health',words:'health healthcare dental dentistry medical clinic wellness pharmacy medicine',meaning:'health-related services or information',buyers:['health-information publishers','professional practices'],uses:['a practice identity','health-related information'],alternatives:['no clinical authority, efficacy or actual service is established']},
 {id:'learning',words:'learn learning teach teaching school education lesson lessons tuition quiz trivia',meaning:'learning or educational content',buyers:['education publishers','learning-product teams'],uses:['learning material','educational tools or activities']},
 {id:'retail',words:'shop store retail supply supplies products marketplace',meaning:'retail or supply',buyers:['specialist retailers','marketplace teams'],uses:['a retail identity','product discovery or supply services']},
 {id:'creative',words:'design art artist artists studio photo photography video music sound audio story stories publication publishing newsletter media film movies print printing prints',meaning:'creative work or media',buyers:['creative studios','media-tool teams'],uses:['a studio or publication identity','creative production tools']},
 {id:'security',words:'security secure verify verification control lock privacy guard trace monitor monitoring alert alerts tracker tracking',meaning:'protection, verification or control',buyers:['security-product teams','operations-software vendors'],uses:['control or verification workflows','monitoring or privacy tools'],alternatives:['no actual security performance is established']},
 {id:'energy',words:'energy energies solar turbine cooling grid',meaning:'energy or technical infrastructure',buyers:['infrastructure businesses','specialist technology teams'],uses:['a service or equipment identity','industry information']},
 {id:'pets',words:'pet pets pooch dog dogs cat cats animal animals',meaning:'animals or pet care',buyers:['pet-service businesses','specialist retailers'],uses:['pet care or product discovery','animal-related content']},
 {id:'fitness',words:'fitness workout yoga pilates exercise',meaning:'exercise or fitness',buyers:['fitness-service businesses','consumer-product teams'],uses:['a studio or coaching identity','activity-planning tools']},
];
const SAFE_SHORT=new Set('a an as at be by do go he if in is it me my no of on or so to up us we ai api app bot car cat dog dev pro seo sms usb uk usa nyc the and for not'.split(' '));
for(const theme of THEMES)for(const word of theme.words.split(' '))if(word.length<=3)SAFE_SHORT.add(word);
for(const word of 'red old new big hot fit pet law pay'.split(' '))SAFE_SHORT.add(word);
const PLACE=new Set('valley harbor harbour village hub grove world community ecosystem'.split(' '));
const MEANINGS={inference:'AI model execution or reasoning',valley:'a place or technology-hub metaphor',harbor:'a sheltered place or connection metaphor',harbour:'a sheltered place or connection metaphor',ledger:'an organized record of transactions',sync:'synchronization',quiz:'a question-based learning activity',story:'narrative content',matrix:'a structured arrangement',code:'software instructions',shop:'a retail destination',track:'following status or progress'};
function namingProfile(domain,{dict=loadDictionary()}={}){
 const canonical=domainToASCII(String(domain||'').trim().toLowerCase());
 const labels=canonical.split('.');
 if(labels.length<2||labels.some(x=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)))throw Error('A valid domain name is required');
 const label=labels[0],idn=label.startsWith('xn--');
 const components=[];let partialSegmentation=false;
 if(idn)components.push({text:domainToUnicode(label),kind:'unresolved-language'});
 else for(const part of label.split(/(-+|[0-9]+)/).filter(Boolean)){
  if(/^-+$/.test(part))continue;
  if(/^\d+$/.test(part)){components.push({text:part,kind:'number'});continue;}
  const segmented=segmentDailyLabel(part,{dict});
  // A large dictionary can force a foreign name into obscure short fragments.
  // Preserve the unknown string instead of manufacturing a readable phrase.
  const ambiguous=segmented.length>1&&(segmented.length>4||segmented.some(w=>w.length<=3&&!SAFE_SHORT.has(w)));
  const words=ambiguous?[]:segmented;
  const unmapped=words.length===0||(words.length===1&&words[0]===part&&!dict.has(part));
  const suffix=unmapped&&!dict.has(part)?THEMES.flatMap(t=>t.words.split(' ')).filter(w=>w.length>=5&&part.endsWith(w)&&part.length-w.length>=3).sort((a,b)=>b.length-a.length)[0]:null;
  if(suffix){partialSegmentation=true;components.push({text:part.slice(0,-suffix.length),kind:'unresolved'},{text:suffix,kind:'tentative-English-suffix',...(MEANINGS[suffix]?{meaning:MEANINGS[suffix]}:{})});}
  else for(const word of words.length?words:[part])components.push({text:word,kind:dict.has(word)?'dictionary-word':'unresolved',...(MEANINGS[word]?{meaning:MEANINGS[word]}:{})});
 }
 const tokens=new Set(components.filter(x=>x.kind!=='number'&&x.kind!=='unresolved-language').map(x=>x.text));
 let themes=idn?[]:THEMES.filter(t=>t.words.split(' ').some(w=>tokens.has(w)));
 if(themes.some(t=>t.id==='insurance'))themes=themes.filter(t=>t.id!=='health');
 const places=[...tokens].filter(t=>PLACE.has(t));
 const unknown=components.filter(x=>['unresolved','unresolved-language'].includes(x.kind)).map(x=>x.text);
 const unique=values=>[...new Set(values)];
 const buyers=unique(themes.flatMap(t=>t.buyers));
 const uses=unique(themes.flatMap(t=>t.uses));
 const alternatives=unique(themes.flatMap(t=>t.alternatives||[]));
 if(themes.length&&places.length){buyers.push('specialist community or ecosystem operators');uses.push('a category-focused community, hub or incubator identity');alternatives.push('the place word may refer to geography rather than a technology ecosystem');}
 const tradeoffs=[];
 if(partialSegmentation)tradeoffs.push('An English-looking suffix is a tentative reading; language and intended segmentation remain unverified.');
 if(label.includes('-'))tradeoffs.push('Hyphens add spoken-address and typing friction.');
 if(/\d/.test(label)&&!idn)tradeoffs.push('The significance of the digits is unverified; mixed characters may complicate spoken spelling.');
 if(label.length>20)tradeoffs.push('The long label may be harder to recall and type.');
 if(themes.length>2)tradeoffs.push('Several categories are plausible; positioning is needed to narrow the meaning.');
 if(unknown.length)tradeoffs.push('Unresolved components need language, proper-name or buyer context.');
 const status=themes.length?'preliminary-hypothesis':'unresolved';
 const meaning=themes.length?themes.map(t=>t.meaning).join('; '):'No dependable commercial category can be assigned from these components alone.';
 const combination=themes.length&&places.length?`The category cue combines with ${places.join(', ')}, which can frame a place, community or ecosystem identity rather than a precise tool function.`:themes.length?'The recognized category words suggest possible positioning; their combination does not establish the actual product.':'An exact-name, initials or existing-identity match is possible, but an expansion or translation has not been verified.';
 const analysis=[`Components: ${components.map(c=>c.text+(c.meaning?' ('+c.meaning+')':'')).join(' + ')}.`,meaning+'.',combination, buyers.length?'Plausible buyer classes: '+buyers.join('; ')+'.':'',uses.length?'Possible uses: '+uses.join('; ')+'.':'',alternatives.length?'Alternative readings or limits: '+alternatives.join('; ')+'.':'',...tradeoffs,'This is a rule-based preliminary hypothesis, not an analyst review, identified buyer, observed motive, sale or registration finding.'].filter(Boolean).join(' ');
 return {partialSegmentation,version:VERSION,method:'rule-based preliminary naming hypothesis',domain:canonical,status,components,meaning,combination,buyerClasses:buyers,commercialUses:uses,alternatives,tradeoffs,unresolvedComponents:unknown,analysis};
}
// Shared theme-family lookups (Sale Watch search reuses these; never a parallel labeler).
const splitWords=value=>String(value||'').split(' ').filter(Boolean);
const SEARCH_FAMILIES=THEMES.map(t=>({id:t.id,words:splitWords(t.words),subthemes:(t.subthemes||[]).map(s=>({id:s.id,label:s.label||s.id,strong:splitWords(s.words),weak:splitWords(s.weak)}))}));
const THEME_WORDS=Object.freeze([...new Set(SEARCH_FAMILIES.flatMap(f=>[...f.words,...f.subthemes.flatMap(s=>[...s.strong,...s.weak])]))]);
// Every family (and sub-theme) with at least one exact member term in `tokens`
// (an iterable of whole lowercase words), with the member terms that triggered
// it. Membership is exact, so a short term such as "ai" only ever matches a
// whole token. A family with sub-themes is tagged only when a strong member is
// present; weak members then refine which sub-themes apply.
function themeMatches(tokens){
 const set=tokens instanceof Set?tokens:new Set(tokens||[]);
 const out=[];
 for(const family of SEARCH_FAMILIES){
  if(!family.subthemes.length){const terms=family.words.filter(w=>set.has(w));if(terms.length)out.push({id:family.id,terms});continue;}
  if(!family.subthemes.some(s=>s.strong.some(w=>set.has(w))))continue;
  const subs=[];
  for(const s of family.subthemes){const terms=[...s.strong,...s.weak].filter(w=>set.has(w));if(terms.length)subs.push({id:s.id,terms,parent:family.id});}
  out.push({id:family.id,terms:[...new Set(subs.flatMap(s=>s.terms))]},...subs);
 }
 return out;
}
// Theme ids a free-text query names, at the closest level: a family id names the
// whole family; a member word names only its sub-theme when the family has
// sub-themes (q=inference -> aiinference, never every ai-tagged row), else the family.
function themesForTerm(term){
 const words=String(term||'').toLowerCase().match(/[a-z0-9]+/g)||[];
 if(!words.length)return [];
 const candidates=[...new Set([...words,words.join('')])];
 const out=new Set();
 for(const family of SEARCH_FAMILIES)for(const c of candidates){
  if(c===family.id){out.add(family.id);continue;}
  if(family.subthemes.length){for(const s of family.subthemes)if(s.id===c||s.strong.includes(c)||s.weak.includes(c))out.add(s.id);}
  else if(family.words.includes(c))out.add(family.id);
 }
 return [...out];
}
module.exports={namingProfile,VERSION,THEME_WORDS,themeMatches,themesForTerm};
