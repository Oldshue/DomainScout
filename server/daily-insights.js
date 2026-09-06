'use strict';

// Explain observed constructions, not inferred registrants or investment returns.
function describeConstruction(labels, token) {
  const patterns = new Map();
  const numeric = new Map();
  for (const label of labels) {
    const shape = label.replace(/[0-9]+/g, '#');
    numeric.set(shape, (numeric.get(shape) || 0) + 1);
    const seen = new Set();
    for (let n = token.length + 3; n < label.length; n++) {
      for (const [side, text] of [['prefix', label.slice(0, n)], ['suffix', label.slice(-n)]]) {
        if (text.includes(token)) seen.add(`${side}:${text}`);
      }
    }
    for (const key of seen) patterns.set(key, (patterns.get(key) || 0) + 1);
  }
  const repeated = [...patterns].filter(([, n]) => n >= Math.max(3, labels.length * 0.4))
    .sort((a,b) => b[0].length-a[0].length || b[1]-a[1] || a[0].localeCompare(b[0]))[0];
  const numbered = [...numeric].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))[0];
  if (numbered && numbered[1] >= Math.max(3,labels.length * 0.4)) return { kind:'numbered', text:numbered[0], count:numbered[1] };
  return repeated ? {kind:repeated[0].split(':')[0],text:repeated[0].split(':')[1],count:repeated[1]} : null;
}

// Match the admitted vocabulary in one bounded trie pass rather than rescanning
// a month of names for each keyword. Each label contributes once per keyword.
function matchVocabulary(labels,tokens,dictionary) {
  const aligned=new Map(tokens.map(t=>[t,[]]));
  const {createKeywordMatcher}=require('./keyword-language');
  const root=new Map(),out=new Map(tokens.map(t=>[t,[]]));
  for(const token of tokens){let node=root;for(const ch of token){if(!node.has(ch))node.set(ch,new Map());node=node.get(ch);}node.token=token;}
  for(const label of labels){const seen=new Set();for(let i=0;i<label.length;i++){let node=root;for(let j=i;j<label.length;j++){node=node.get(label[j]);if(!node)break;if(node.token)seen.add(node.token);}}const uses=dictionary&&seen.size?createKeywordMatcher(label,dictionary):null;for(const token of seen){out.get(token).push(label);if(uses?.(token))aligned.get(token).push(label);}}
  out.aligned=aligned;return out;
}

// Compute lexical quality once per label and retain only the best examples.
// Sorting with Array.includes inside the comparator made large families quadratic.
function selectExamples(names, wordExamples, dictionary, readableKeyword) {
  const {familiarKeyword}=require('./keyword-language');
  const aligned=new Set(wordExamples),quality=new Map(),best=[];
  const compare=(a,b)=>b.aligned-a.aligned||b.familiar-a.familiar||b.readable-a.readable||b.com-a.com||a.noisy-b.noisy||a.name.base_name.length-b.name.base_name.length||a.name.base_name.localeCompare(b.name.base_name)||a.name.tld.localeCompare(b.name.tld);
  for(const name of names){
    if(!quality.has(name.base_name))quality.set(name.base_name,{readable:Number(readableKeyword(name.base_name,dictionary)),familiar:Number(familiarKeyword(name.base_name))});
    const item={name,aligned:Number(aligned.has(name.base_name)),...quality.get(name.base_name),com:Number(name.tld==='com'),noisy:Number(/[^a-z]/.test(name.base_name))};
    const at=best.findIndex(old=>compare(item,old)<0);
    if(at>=0)best.splice(at,0,item);else if(best.length<4)best.push(item);
    if(best.length>4)best.pop();
  }
  return best.map(x=>`${x.name.base_name}.${x.name.tld}`);
}

function buildDailyInsights(db, params, report, { dictionary = new Set() } = {}) {
  const {readableKeyword,readableExtension,keywordUse,familiarKeyword}=require('./keyword-language');
  const zone = String(params.zone || '').replace(/^\./,'').toLowerCase();
  const limit = Math.min(100,Math.max(1,Number(params.limit)||20));
  const offset = Math.max(0,Number(params.offset)||0);
  if (!report.coverage?.receipt) return {...report,mode:'insights',tokens:[],totalTokens:0,limit,offset};
  const dates = report.baseline?.dates || [];
  const start=report.period?.start||report.date;
  const current = db.prepare(`SELECT base_name,tld,MIN(report_date) AS report_date FROM zi.zone_daily_new_names WHERE report_date>=? AND report_date<=? AND report_date IN (SELECT report_date FROM zi.nrd_import_receipts) AND tld != 'xyz'${zone?' AND tld=?':''} GROUP BY base_name,tld ORDER BY base_name,tld`).all(...(zone?[start,report.date,zone]:[start,report.date]));
  const search=String(params.q||'').trim().toLowerCase();
  if(search && !report.tokens.some(r=>r.token===search)){
    const n=new Set(current.filter(x=>x.base_name.includes(search)).map(x=>x.base_name)).size;
    if(n)report={...report,tokens:[{token:search,count:n,contexts:n,lift:null},...report.tokens]};
  }
  const labels = [...new Set(current.map(x=>x.base_name))];
  // Small extension feeds need their own discovery floor. The import's four-label
  // substring floor otherwise removes complete words before language admission.
  // Keep this bounded, and retain the ordinary global discovery policy.
  const smallExtension = Boolean(zone && zone !== 'xyz' && labels.length <= 5000);
  if (smallExtension && !search) {
    const scoped = require('./daily-fragments').discoverFragments(labels, {minSupport:2,maxNames:5000});
    report = {...report,tokens:scoped,totalTokens:scoped.length};
  }
  const previous = dates.length ? db.prepare(`SELECT MIN(report_date) AS report_date,base_name,tld FROM zi.zone_daily_new_names WHERE report_date>=? AND report_date<? AND report_date IN (SELECT report_date FROM zi.nrd_import_receipts) AND tld != 'xyz'${zone?' AND tld=?':''} GROUP BY ${report.period?'':'report_date,'}base_name,tld`).all(...(zone?[dates[0],start,zone]:[dates[0],start])).filter(row=>dates.includes(row.report_date)) : [];
  const currentSize=current.length, priorSize=previous.length;
  // No hand-picked vocabulary. Activity remains visible even when share is flat. Prefer full, label-edge constructions over
  // accidental internal letter fragments; raw substring exploration stays intact.
  const candidates=report.tokens.filter(r=>r.token === search || (readableKeyword(r.token,dictionary) && familiarKeyword(r.token)))
    .map(r=>{
      const expected=params.sort==='change' && smallExtension && priorSize ? previous.filter(x=>x.base_name.includes(r.token)).length/priorSize*currentSize : (r.lift?r.count/r.lift:r.count);
      return {...r,priority:params.sort === 'change' && !report.period ? Math.sqrt(Math.max(0,r.count-expected))*Math.log2(1+r.token.length) : r.count*Math.min(1,(r.token.length/6)**2)};
    })
    .sort((a,b)=>b.priority-a.priority || b.count-a.count || a.token.localeCompare(b.token)).slice(0,400);
  const matched=matchVocabulary(labels,candidates.map(x=>x.token),dictionary);
  const priorMatched=params.sort==='change'?matchVocabulary(previous.map(x=>x.base_name),candidates.map(x=>x.token)):null;
  const labelWeights=new Map();for(const row of current)labelWeights.set(row.base_name,(labelWeights.get(row.base_name)||0)+1);
  const admitted=[];
  for(const row of candidates){
    const matching=matched.get(row.token)||[];
    const wordExamples=matched.aligned.get(row.token).filter(x=>(!smallExtension ||
      x.split(/[^a-z]+/).some(part=>part.startsWith(row.token) || part.endsWith(row.token) ||
        ['s','es','ed','ing'].some(ending=>part.endsWith(row.token+ending)))));
    if(row.token!==search && (wordExamples.length<(smallExtension ? 2 : 3) || wordExamples.length<matching.length*0.4))continue;
    // Internal use is still activity: never hide a searched or sustained stem.
    if (!matching.length) continue;
    const exactCount=matching.reduce((n,label)=>n+labelWeights.get(label),0);
    const priority=priorMatched?Math.max(0,exactCount-(priorSize?priorMatched.get(row.token).length/priorSize*currentSize:0)):exactCount;
    admitted.push({...row,priority,matching,wordExamples});
  }
  // A parent observation includes its concentrated subconstruction in its card.
  let distinct=admitted.filter(r=>r.token===search || !admitted.some(p=>p!==r && r.token.includes(p.token) && r.matching.length>=p.matching.length*0.5));
  if(search && distinct.some(x=>x.token===search)) distinct=distinct.filter(x=>x.token===search);
  distinct.sort((a,b)=>(b.token===search)-(a.token===search) || b.priority-a.priority || b.count-a.count || a.token.localeCompare(b.token));
  const cards=distinct.slice(offset,offset+limit).map(row=>{
    const names=current.filter(x=>x.base_name.includes(row.token));
    row={...row,count:names.length};
    const extensionCounts=new Map();
    for(const name of names)extensionCounts.set(name.tld,(extensionCounts.get(name.tld)||0)+1);
    const familyPatterns=require('./daily-fragments').discoverFragments(row.matching,{minSupport:2}).filter(x=>x.visible && readableExtension(x.token,row.token,dictionary)).sort((a,b)=>b.count-a.count || b.token.length-a.token.length || a.token.localeCompare(b.token)).slice(0,8).map(x=>({pattern:x.token,labels:x.count}));
    const byDay=Object.fromEntries(dates.map(d=>[d,0]));
    for(const old of previous)if(old.base_name.includes(row.token))byDay[old.report_date]++;
    const priorCount=Object.values(byDay).reduce((a,b)=>a+b,0);
    const currentShare=currentSize?row.count/currentSize:0, priorShare=priorSize&&dates.length?priorCount/priorSize:null;
    const comparable=report.period ? report.period.observedDates.length===report.period.days && report.baseline.complete : dates.length>=5;
    const shareRatio=priorShare ? currentShare/priorShare : null;
    const construction=describeConstruction(row.matching,row.token);
    const direction=priorShare===null?'Snapshot':!comparable?'Partial comparison':priorCount===0?'New in this sample':shareRatio>=1.25?'Gained share':shareRatio<=0.8?'Lost share':'Similar share';
    const comparison=(priorShare!==null&&!comparable?'Partial coverage; this is not a full-period trend comparison. ':'')+(priorShare===null?'No verified comparison window is available.':priorCount===0?`No matching label in ${dates.length} prior sampled days (${priorSize.toLocaleString()} labels checked).`:`${(currentShare*10000).toFixed(1)} per 10,000 sampled domains versus ${(priorShare*10000).toFixed(1)} in the prior ${dates.length} days (${shareRatio.toFixed(1)}× share).`);
    const observation=construction?`${construction.count} of ${row.matching.length} distinct labels share ${construction.kind==='numbered'?'the numeric template':'the '+construction.kind} “${construction.text}”.`:`${row.count} ${row.count===1?'domain contains':'domains contain'} “${row.token}”; ${row.matching.filter(x=>x.startsWith(row.token)).length} distinct labels lead with it and ${row.matching.filter(x=>x.endsWith(row.token)).length} end with it.`;
    return {...row,contexts:row.matching.length,matching:undefined,wordExamples:undefined,wordAlignedLabels:row.wordExamples.length,uniqueLabels:row.matching.length,extensions:[...extensionCounts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([tld,count])=>({tld,count})),familyPatterns,kind:construction?'Concentrated construction':row.matching.length<4?'Small sample · '+direction:direction,direction,construction,sampleStrength:row.matching.length<4?'small sample':'repeated vocabulary',
      currentHistory:(report.period?.observedDates||[report.date]).map(date=>({date,count:names.filter(x=>x.report_date===date).length})),baselineExactCount:priorCount,history:Object.entries(byDay).map(([date,count])=>({date,count})),currentShare,priorShare,shareRatio,
      why:observation,comparison,interpretation:construction?'A repeated construction explains part of this activity; it should not be read as independent demand across all these names.':'This describes the naming vocabulary in the sample. Different constructions do not establish different registrants or buyer demand.',
      positionCounts:{prefix:row.matching.filter(x=>x.startsWith(row.token)).length,suffix:row.matching.filter(x=>x.endsWith(row.token)).length,internal:row.matching.filter(x=>!x.startsWith(row.token)&&!x.endsWith(row.token)).length},
      examples:selectExamples(names,row.wordExamples,dictionary,readableKeyword)};
  });
  return {...report,coverage:{...report.coverage,names:currentSize},baseline:{...report.baseline,names:priorSize},mode:'insights',tokens:cards,totalTokens:distinct.length,limit,offset,
    insightSummary:{domains:currentSize,labels:labels.length,priorLabels:priorSize,baselineDays:dates.length,patternsExamined:report.totalTokens,candidateLimit:400,
      note:'Words and readable compounds, ranked by activity. Search any naming family directly; raw substrings remain in All raw patterns. Shares compare eligible registrations with verified prior days; .xyz contributes no signal evidence.'}};
}
module.exports={buildDailyInsights,describeConstruction,selectExamples};
