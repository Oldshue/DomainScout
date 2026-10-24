'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
function readReportedSales(file,{from,through,audience='public'}){
 if(!file)return {rows:[],receipts:[]};
 const bytes=fs.readFileSync(file),input=JSON.parse(bytes),rows=[],receipts=[];
 for(const report of input.reports||[]){
  if(report.accessScope==='organization-internal'&&audience!=='internal')throw Error('Internal-use reported sales cannot enter a public report');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(report.saleDay||'')||!String(report.sourceUrl||'').startsWith('https://'))throw Error('Reported sale requires a dated HTTPS source');
  if(report.saleDay<from||report.saleDay>through)continue;
  receipts.push({accessScope:report.accessScope||'public',provider:report.provider,sourceUrl:report.sourceUrl,saleDay:report.saleDay,publicationDay:report.publicationDay||null,checkedAt:report.checkedAt||null,selection:report.selection||'unspecified',exposedRows:report.records.length,sourceReportedRows:report.sourceReportedRows??null,sourceAdditionalLowValueRows:report.sourceAdditionalLowValueRows??null,inputSha256:crypto.createHash('sha256').update(bytes).digest('hex'),captureMethod:report.captureMethod||null});
  for(const record of report.records){
   const domain=String(record.domain||'').toLowerCase();if(!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain))throw Error('Invalid reported domain');
   const price=record.priceVerified===true&&Number.isFinite(record.priceUsd)?record.priceUsd:null;
   const id=crypto.createHash('sha256').update(JSON.stringify(['reported-sale',report.provider,report.sourceUrl,domain,report.saleDay])).digest('hex');
   rows.push({id,domain,departureDay:report.saleDay,observationType:'reported-sale',publicationDay:report.publicationDay||null,windowPrecision:'source-reported sale day; exact transaction time unverified',windowMembership:report.saleDay===from?'boundary-uncertain':'within-requested-date-range',beforeNameservers:[],observedDestinationNameservers:[],destinationCheckedAt:null,venue:record.venue||null,classification:'reported-sale',tier:'reported',reportedPriceUsd:price,sourceUrl:report.sourceUrl,sourceBucket:'reported-sales',firstObservedAt:report.checkedAt||null,lastObservedAt:report.checkedAt||null,assessment:{reported:true,counterEvidence:['Reported by the named source; not independently verified against payment or ownership records.','An auction or investor resale must not be treated as established end-user demand.']},homepage:null,transfer:null,rationale:`${report.provider} lists this name in its ${report.saleDay} sales report, published ${report.publicationDay||'on an unspecified date'}. ${price===null?'Price was not independently transcribed from the displayed table; inspect the linked source.':`The source reports USD ${price.toLocaleString('en-US')}.`} Buyer identity and motive are not established by this listing.`,semanticReview:null});
  }
 }
 return {rows,receipts};
}
module.exports={readReportedSales};
