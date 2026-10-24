'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
function readReportedSales(file,{from,through,audience='public'}){
 if(!file)return {rows:[],receipts:[]};
 const bytes=fs.readFileSync(file),input=JSON.parse(bytes),rows=[],receipts=[];
 for(const report of input.reports||[]){
  if(report.accessScope==='organization-internal'&&audience!=='internal')throw Error('Internal-use reported sales cannot enter a public report');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(report.saleDay||'')||!String(report.sourceUrl||'').startsWith('https://'))throw Error('Reported sale requires a dated HTTPS source');
  if(report.saleDay<from||report.saleDay>through)continue;
  receipts.push({accessScope:report.accessScope||'public',provider:report.provider,sourceUrl:report.sourceUrl,saleDay:report.saleDay,publicationDay:report.publicationDay||null,checkedAt:report.checkedAt||null,selection:report.selection||'unspecified',priceBand:report.priceBand||null,exposedRows:report.records.length,sourceReportedRows:report.sourceReportedRows??null,sourceReportedDollarVolumeUsd:report.sourceReportedDollarVolumeUsd??null,sourceAdditionalLowValueRows:report.sourceAdditionalLowValueRows??null,inputSha256:crypto.createHash('sha256').update(bytes).digest('hex'),captureMethod:report.captureMethod||null,sourcePageReceipts:report.sourcePageReceipts||[]});
  for(const record of report.records){
   const domain=String(record.domain||'').toLowerCase();if(!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain))throw Error('Invalid reported domain');
   let original=null;
   if(record.priceVerified===true&&record.priceAmount!==undefined){if(!Number.isFinite(record.priceAmount)||record.priceAmount<0||!(/^[A-Z]{3}$/).test(record.priceCurrency||''))throw Error('Invalid reported native-currency price');original={amount:record.priceAmount,currency:record.priceCurrency};}
   const price=original?(original.currency==='USD'?original.amount:null):record.priceVerified===true&&Number.isFinite(record.priceUsd)?record.priceUsd:null;
   if(original&&Number.isFinite(record.priceUsd)&&(original.currency!=='USD'||record.priceUsd!==original.amount))throw Error('Reported native currency conflicts with USD price');
   if(price!==null&&price<0)throw Error('Invalid reported USD price');
   if(!original&&price!==null)original={amount:price,currency:'USD'};
   const quotations=[];
   for(const quote of record.priceObservations||[]){if(quote.priceVerified!==true)continue;if(!Number.isFinite(quote.amount)||quote.amount<0||!(/^[A-Z]{3}$/).test(quote.currency||'')||!String(quote.sourceUrl||'').startsWith('https://'))throw Error('Invalid supplemental source price');if(quote.currency==='USD'&&price!==null&&quote.amount!==price)throw Error('Conflicting supplemental USD quotation');quotations.push({...quote});}
   const id=crypto.createHash('sha256').update(JSON.stringify(['reported-sale',report.provider,report.sourceUrl,domain,report.saleDay,record.venue||null,record.sourceRecordId||null])).digest('hex');
   rows.push({id,domain,departureDay:report.saleDay,observationType:'reported-sale',publicationDay:report.publicationDay||null,windowPrecision:'source-reported sale day; exact transaction time unverified',windowMembership:report.saleDay===from?'boundary-uncertain':'within-requested-date-range',beforeNameservers:[],observedDestinationNameservers:[],destinationCheckedAt:null,venue:record.venue||null,classification:'reported-sale',tier:'reported',reportedPriceUsd:price,reportedPrice:original,reportedPriceObservations:quotations,priceBand:report.priceBand||null,sourceUrl:report.sourceUrl,sourceBucket:'reported-sales',firstObservedAt:report.checkedAt||null,lastObservedAt:report.checkedAt||null,assessment:{reported:true,counterEvidence:['Reported by the named source; not independently verified against payment or ownership records.','An auction or investor resale must not be treated as established end-user demand.']},homepage:null,transfer:null,rationale:`${report.provider} lists this name in its ${report.saleDay} sales report, published ${report.publicationDay||'on an unspecified date'}. ${original?`The source reports ${original.currency} ${original.amount.toLocaleString('en-US')}.${original.currency==='USD'?'':' No USD conversion is assumed.'}`:'Price was not independently transcribed from the displayed table; inspect the linked source.'} ${quotations.length?'Additional displayed source quotation'+(quotations.length===1?'':'s')+': '+quotations.map(q=>q.currency+' '+q.amount.toLocaleString('en-US')).join('; ')+'. Quotations are preserved as published; no currency conversion is calculated here. ':''}Buyer identity and motive are not established by this listing.`,semanticReview:null});
  }
 }
 return {rows,receipts};
}
module.exports={readReportedSales};
