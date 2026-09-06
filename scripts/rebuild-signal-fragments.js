'use strict';
// Rebuild only derived signal projections. Raw imports and receipts stay immutable.
const Database=require('better-sqlite3');
const {discoverFragments,ensureFragmentSchema}=require('../server/daily-fragments');
const db=new Database(process.argv[2] || '/data/zone_index.db');
ensureFragmentSchema(db);
const dates=db.prepare('SELECT report_date FROM nrd_import_receipts ORDER BY report_date DESC LIMIT 8').all().map(x=>x.report_date);
const insert=db.prepare('INSERT INTO zone_daily_fragments VALUES (?, ?, ?, ?, ?, ?)');
for(const date of dates){
 const labels=db.prepare("SELECT DISTINCT base_name FROM zone_daily_new_names WHERE report_date=? AND tld!='xyz'").all(date).map(x=>x.base_name);
 const rows=discoverFragments(labels);
 db.transaction(()=>{db.prepare("DELETE FROM zone_daily_fragments WHERE report_date=? AND tld='!signal'").run(date);for(const row of rows)insert.run('!signal',date,row.token,row.count,Number(row.visible),row.contexts);})();
 console.log(JSON.stringify({date,eligibleLabels:labels.length,fragments:rows.length,excludedSuffixes:['xyz']}));
}
db.close();
