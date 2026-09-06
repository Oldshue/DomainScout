const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {ensureCompsSchema,compsForShape}=require('../server/sales-comps');
test('Repeated chart observations do not double-count a reported sale or imply a known buyer',()=>{
 const db=new Database(':memory:');ensureCompsSchema(db);
 const add=db.prepare('INSERT INTO sales_comps(domain,price_usd,venue,side,chart_date,tld,label,word_count) VALUES(?,?,?,?,?,?,?,?)');
 add.run('agenticexposure.com',3119,'Sedo','enduser','2026-06-24','com','agenticexposure',2);
 add.run('agenticexposure.com',3119,'Sedo','enduser','2026-07-08','com','agenticexposure',2);
 add.run('agentpanel.com',5600,'Sedo','enduser','2026-03-18','com','agentpanel',2);
 add.run('agentpanel.com',800,'GoDaddy','auction','2026-02-01','com','agentpanel',2);
 const result=compsForShape(db,{tld:'com',theme:'agent'});
 assert.equal(result.n,2);assert.equal(result.chartObservationCount,3);assert.equal(result.duplicateChartObservations,1);assert.equal(result.median,4359.5);
 assert.deepEqual(result.examples[1].chartDates,['2026-06-24','2026-07-08']);
 assert.equal(result.examples[0].buyerStatus,'unverified');
 assert.match(result.population,/not verified/);
 assert.equal(db.prepare('SELECT count(*) n FROM sales_comps').get().n,4);
 db.close();
});
