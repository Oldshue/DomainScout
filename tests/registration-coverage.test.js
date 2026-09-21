'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {assessRegistrationCoverage,publicFeedCoverage} = require('../server/registration-coverage');
const expectedDates = ['2026-09-19','2026-09-20'];
const full = (date, changes={}) => ({date,source:'registry-export',coverage:{complete:true,capped:false,methodology:'dated-diff-v1',completeZones:['com','ai','io'],zoneCounts:{com:10,ai:2,io:0},...changes}});
test('a successfully downloaded capped feed is not a comparable market baseline', () => {
 const days=expectedDates.map(date=>({date,source:'whoisds-public-nrd',coverage:publicFeedCoverage(['orchard.com','orchard.ai','orchard.io'])}));
 const result=assessRegistrationCoverage({days,expectedDates,requiredZones:['com','ai','io']});
 assert.equal(result.comparable,false);
 assert.deepEqual(result.incompleteZones,['ai','com','io']);
 assert.equal(result.days[0].zones.find(z=>z.zone==='ai').observedNames,1);
});
test('complete days still fail when a required extension is missing', () => {
 const result=assessRegistrationCoverage({days:expectedDates.map(d=>full(d,{completeZones:['com','ai']})),expectedDates,requiredZones:['com','ai','io']});
 assert.equal(result.complete,false); assert.deepEqual(result.incompleteZones,['io']);
});
test('verified zero-count zones are distinct from missing data; collection-method changes invalidate comparison', () => {
 const days=expectedDates.map(d=>full(d));
 assert.equal(assessRegistrationCoverage({days,expectedDates,requiredZones:['io']}).comparable,true);
 days[1].coverage.methodology='different-method';
 assert.equal(assessRegistrationCoverage({days,expectedDates,requiredZones:['io']}).comparable,false);
});
test('legacy receipts and absent days cannot acquire completeness by inference', () => {
 const result=assessRegistrationCoverage({days:[{date:expectedDates[0],feedProcessed:true}],expectedDates,requiredZones:['com']});
 assert.equal(result.complete,false);assert.deepEqual(result.missingDates,[expectedDates[1]]);
});
test('unrelated sustained vocabulary stays inspectable without fabricated growth', () => {
 const Database=require('better-sqlite3'); const db=new Database(':memory:');
 db.exec("ATTACH ':memory:' AS zi; CREATE TABLE zi.zone_daily_new_names(report_date TEXT,base_name TEXT,tld TEXT); CREATE TABLE zi.nrd_import_receipts(report_date TEXT);");
 const put=db.prepare('INSERT INTO zi.zone_daily_new_names VALUES (?,?,?)');
 for(const date of expectedDates){db.prepare('INSERT INTO zi.nrd_import_receipts VALUES (?)').run(date); for(const label of ['orchard-tools','orchard-cloud','orchard-app'])put.run(date,label,'com');}
 const report={date:expectedDates[1],coverage:{receipt:{}},baseline:{dates:[expectedDates[0]],complete:true},researchCoverage:{comparable:false,notice:'Capped source'},tokens:[{token:'orchard',count:3}],totalTokens:1};
 const result=require('../server/daily-insights').buildDailyInsights(db,{q:'orchard',sort:'change'},report,{dictionary:new Set(['orchard','tools','cloud','app'])});
 assert.equal(result.tokens.length,1);assert.equal(result.tokens[0].count,3);
 assert.equal(result.tokens[0].shareRatio,null);assert.equal(result.tokens[0].direction,'Observed activity');
 assert.equal(result.sortApplied,'count'); assert.equal(result.tokens[0].comparison,'Capped source'); db.close();
});
