'use strict';
// Owner relevance policy. Observed counts remain facts; these weights affect
// analytical priority and corroboration, never the stored registration corpus.
const SUFFIX_WEIGHTS=Object.freeze({xyz:0,shop:0,info:0});
const SIGNAL_POLICY_NOTE='.shop, .info and .xyz contribute no signal evidence. Raw counts remain visible.';
function signalWeight(tld){return SUFFIX_WEIGHTS[String(tld||'').replace(/^\./,'').toLowerCase()]??1;}
function weightedLabels(rows){const labels=new Map();for(const row of rows)labels.set(row.base_name,Math.max(labels.get(row.base_name)||0,Math.round(signalWeight(row.tld)*10)));return [...labels.values()].reduce((a,b)=>a+b,0)/10;}
module.exports={SUFFIX_WEIGHTS,SIGNAL_POLICY_NOTE,signalWeight,weightedLabels};
