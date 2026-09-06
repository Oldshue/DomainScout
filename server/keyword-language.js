'use strict';

// Language-quality checks for the editorial keyword view. Discovery remains
// vocabulary-free, and explicit searches can inspect any observed string.
const FUNCTION_WORDS = new Set(('about above after again against along already also although always among an and any are around as at back be because been before being below between both but by can cannot could did do does down during each either else even ever every few for from further get got had has have he her here hers herself him himself his how if in into is it its itself just less many me might more most much must my myself near neither no nor not now of off often on once one only onto or other our ours ourselves out over own per same she should since so some such than that the their theirs them themselves then there these they this those through thus to too toward under until up upon us very was we were what when where whether which while who whom whose why will with within without would yet you your yours yourself yourselves').split(' '));
const BOUND_SUFFIXES = new Set(['tion','tions','ation','ations','sion','sions','ment','ments','ness','nesses','ity']);
const AFFIXES = ['s','es','ed','ing','er','ers','ly','ic','ics','al','ally'];

function lexicalForm(word, dictionary) {
  if (!/^[a-z]+$/.test(word)) return false;
  if (dictionary.has(word)) return true;
  if (word.endsWith('ies') && dictionary.has(word.slice(0,-3)+'y')) return true;
  for (const ending of AFFIXES) {
    if (!word.endsWith(ending)) continue;
    const root=word.slice(0,-ending.length);
    if (root.length>=4 && (dictionary.has(root) || dictionary.has(root+'e'))) return true;
  }
  return false;
}

function readableKeyword(word, dictionary) {
  if (word.length<4 || FUNCTION_WORDS.has(word) || BOUND_SUFFIXES.has(word)) return false;
  if (lexicalForm(word,dictionary)) return true;
  // Complete compounds only: no skipped letters and no sequence of tiny pieces.
  const best=Array(word.length+1).fill(null);best[0]=[];
  for(let end=3;end<=word.length;end++){
    for(let start=0;start<=end-3;start++){
      if(!best[start] || best[start].length>=3)continue;
      const part=word.slice(start,end);
      if(FUNCTION_WORDS.has(part) || !lexicalForm(part,dictionary))continue;
      const next=[...best[start],part];
      if(!best[end] || next.length<best[end].length)best[end]=next;
    }
  }
  return Boolean(best[word.length]?.some(part=>part.length>=4));
}

function readableExtension(pattern, root, dictionary) {
  if (!pattern.includes(root) || pattern===root) return false;
  const at=pattern.indexOf(root),before=pattern.slice(0,at),after=pattern.slice(at+root.length);
  return (!before || readableKeyword(before,dictionary)) && (!after || AFFIXES.includes(after) || readableKeyword(after,dictionary));
}
const commonWords=new Set(require('fs').readFileSync(require('path').join(__dirname,'assets/common-english.txt'),'utf8').trim().split(/\s+/));
function familiarKeyword(word){return readableKeyword(word,commonWords);}
module.exports={readableKeyword,readableExtension,lexicalForm,familiarKeyword};

// A dictionary match alone is insufficient: "cation" inside "education" is
// a real word in the wrong place. Prefer the longest lexical span in each name.
function keywordUse(label, token, dictionary) {
  for (const part of label.split(/[^a-z]+/).filter(Boolean)) {
    if(part===token && readableKeyword(token,dictionary))return true;
    // Parse from complete word endings so agent+service cannot become agents,
    // and agentic+shopping cannot become agentics+hopping.
    for(let end=part.length;end>0;){
      let span='';
      for(let n=Math.min(28,end);n>=3;n--){
        const candidate=part.slice(end-n,end);
        if(lexicalForm(candidate,dictionary)){span=candidate;break;}
      }
      if(token.length>span.length && part.slice(0,end).endsWith(token) && readableKeyword(token,dictionary))return true;
      if(!span){end--;continue;}
      if(span===token)return true;
      if(span.startsWith(token)){
        const after=span.slice(token.length);
        if(['s','es','ed','ing','ic','ics'].includes(after) || (after.length>=4&&readableKeyword(after,dictionary)))return true;
      }
      end-=span.length;
    }
  }
  return false;
}
module.exports.keywordUse=keywordUse;
