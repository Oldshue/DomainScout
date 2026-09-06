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

const {parseChartHtml}=require('../server/sales-comps');
test('Domain-shaped venues are preserved without stealing the next sale column',()=>{
 const html='<table><tr><td>Spaceship</td></tr><tr><td>RobotGolf.com</td><td>$24,888</td><td>Atom.com</td></tr><tr><td>GardenTools.com</td><td>$4,500</td><td>Example.market</td></tr><tr><td>CabinRentals.com</td><td>$2,500</td><td>GardenStore.com</td><td>$3,000</td></tr></table>';
 const rows=parseChartHtml(html,'2026-09-06');
 assert.equal(rows.find(r=>r.domain==='robotgolf.com').venue,'Atom.com');
 assert.equal(rows.find(r=>r.domain==='gardentools.com').venue,'Example.market');
 assert.equal(rows.find(r=>r.domain==='cabinrentals.com').venue,'Spaceship');
});
test('Forced chart refresh repairs stored venue metadata without duplicating the sale',async()=>{
 const {importYear}=require('../server/sales-comps');const db=new Database(':memory:');ensureCompsSchema(db);
 db.prepare('INSERT INTO sales_comps(domain,price_usd,venue,side,chart_date,tld,label,word_count) VALUES(?,?,?,?,?,?,?,?)').run('gardentools.com',4500,'Spaceship','enduser','2026-08-26','com','gardentools',2);
 const url='https://www.dnjournal.com/archive/domainsales/2026/0826.htm';db.prepare('INSERT INTO sales_comps_pages(url,rows) VALUES(?,?)').run(url,1);
 const fetchText=async u=>u.includes('archive-2026')?`<a href="${url}">Chart</a>`:u===url?'<table><tr><td>GardenTools.com</td><td>$4,500</td><td>Atom.com</td></tr></table>':'';
 await importYear(db,2026,{force:true,fetchText,sleep:async()=>{}});
 const rows=db.prepare('SELECT * FROM sales_comps').all();assert.equal(rows.length,1);assert.equal(rows[0].venue,'Atom.com');assert.equal(rows[0].chart_date,'2026-08-26');db.close();
});
