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
  // Derivational suffixes (ic/al) cannot manufacture words such as servic.
  for (const ending of AFFIXES) {
    if (!word.endsWith(ending)) continue;
    const root=word.slice(0,-ending.length);
    if (root.length>=4 && (dictionary.has(root) || (!['ic','ics','al','ally'].includes(ending) && dictionary.has(root+'e')))) return true;
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
const commonRank = new Map([...commonWords].map((word,index)=>[word,index+1]));
function familiarKeyword(word){return readableKeyword(word,commonWords);}
module.exports={readableKeyword,readableExtension,lexicalForm,familiarKeyword};

// A dictionary match alone is insufficient: "cation" inside "education" is
// a real word in the wrong place. Prefer the longest lexical span in each name.
function credibleSpan(word, dictionary) {
  if (word.length < 4) return commonWords.has(word);
  return lexicalForm(word, dictionary);
}
function createKeywordMatcher(label, dictionary) {
  const parts=label.split(/[^a-z]+/).filter(Boolean).map(part=>{
    // Prefer the parse covering the most letters, then longer complete words.
    // A suffix-only greedy parse mistook protein+box and win+box for inbox.
    const best = Array(part.length + 1).fill(null);
    best[0] = {covered:0, weight:0, spans:[]};
    const update = (end, candidate) => {
      const old = best[end];
      if (!old || candidate.covered > old.covered ||
          (candidate.covered === old.covered && (candidate.weight > old.weight ||
            (candidate.weight === old.weight && (candidate.spans[0]?.length||0) > (old.spans[0]?.length||0))))) best[end] = candidate;
    };
    for (let start=0;start<part.length;start++) {
      const prior=best[start];
      update(start+1, prior);
      for (let end=start+3;end<=Math.min(part.length,start+28);end++) {
        const word=part.slice(start,end);
        // Three-letter dictionary residue (yin, avo) cannot anchor a parse:
        // it let my+yin+voices outrank invoices. Short spans must be common words.
        if (!credibleSpan(word,dictionary)) continue;
        update(end,{covered:prior.covered+word.length,weight:prior.weight+word.length**2+word.length*2*Math.max(0,Math.log(10000/(commonRank.get(word)||10000))),spans:[...prior.spans,word]});
      }
    }
    return {part,spans:best[part.length].spans};
  });
  return token=>{
  for(const {part,spans} of parts){
    for (const span of spans) {
      if (span===token) return true;
      if (span.startsWith(token)) {
        const after=span.slice(token.length);
        // Inflections of the same lexeme count; derivations (graph+ics,
        // class+ic) are different words and must not inherit the theme.
        if (['s','es','ed','ing'].includes(after) || (after.length>=4&&readableKeyword(after,dictionary))) return true;
      }
    }
    if (part===token && readableKeyword(token,dictionary)) return true;
    // An invented brand prefix must not let an archaic dictionary word swallow
    // a familiar ending (mavexa+voice). Still reject win+box and protein+box.
    if (commonWords.has(token) && (part.startsWith(token) || part.endsWith(token))) {
      const boundary=part.startsWith(token)?token.length:part.length-token.length;
      let crossing=false;
      for(let start=Math.max(0,boundary-27);start<boundary&&!crossing;start++) {
        for(let end=Math.max(start+3,boundary+1);end<=Math.min(part.length,start+28);end++) {
          // A real word straddling the boundary (shire over hire, invoice over
          // voice) means the token is not used as a word there. Three-letter
          // residue never blocks; common or longer dictionary words do.
          const word=part.slice(start,end);
          if(commonWords.has(word) || (word.length>=4 && lexicalForm(word,dictionary))){crossing=true;break;}
        }
      }
      if(!crossing)return true;
    }
  }
  return false;
  };
}
function keywordUse(label,token,dictionary){return createKeywordMatcher(label,dictionary)(token);}
module.exports.keywordUse=keywordUse;
module.exports.createKeywordMatcher=createKeywordMatcher;
