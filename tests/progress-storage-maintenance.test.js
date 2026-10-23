'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { rewriteProgressBatch } = require('../server/provider-storage-maintenance');
const { encodeCheckedWaves, decodeCheckedWaves } = require('../server/nameverse-coverage');
const universe = { id:'fixture', version:'pinned-v1', authoritative:true, tlds:['.com','.io','.net'] };

test('progress compaction is reversible and preserves mismatched, malformed and other-version rows', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE nameverse_check_progress (base_name TEXT, universe_id TEXT, universe_version TEXT, checked_json TEXT, checked_waves_json TEXT, evidence_json TEXT)');
  const waves = encodeCheckedWaves(new Map([['.com',1000],['.net',2000]]), universe.tlds);
  const insert = db.prepare('INSERT INTO nameverse_check_progress VALUES (?,?,?,?,?,?)');
  insert.run('orchard',universe.id,universe.version,'[".net",".com"]',waves,'private evidence stays');
  insert.run('missing',universe.id,universe.version,'[".com"]','{}','untouched');
  insert.run('extra',universe.id,universe.version,'[".com"]',waves,'untouched');
  insert.run('duplicates',universe.id,universe.version,'[".com",".com"]',waves,'untouched');
  insert.run('corrupt',universe.id,universe.version,'[".com"]','bad-json','untouched');
  insert.run('other',universe.id,'old-version','[".net",".com"]',waves,'untouched');
  const before = db.prepare('SELECT * FROM nameverse_check_progress').all();
  const planned = rewriteProgressBatch(db, universe);
  assert.equal(planned.eligible,1);
  assert.equal(planned.changed,0);
  assert.deepEqual(db.prepare('SELECT * FROM nameverse_check_progress').all(),before);
  const compact = rewriteProgressBatch(db, universe,{apply:true});
  assert.equal(compact.changed,1);
  assert.ok(compact.logicalBytesSaved>0);
  const after = db.prepare('SELECT * FROM nameverse_check_progress').all();
  assert.equal(after[0].checked_json,'[]');
  assert.equal(after[0].checked_waves_json,waves);
  assert.equal(after[0].evidence_json,before[0].evidence_json);
  assert.deepEqual(after.slice(1),before.slice(1));
  assert.deepEqual([...decodeCheckedWaves(waves,universe.tlds).keys()],['.com','.net']);
  const restored = rewriteProgressBatch(db,universe,{mode:'expand',apply:true});
  assert.equal(restored.changed,1);
  assert.deepEqual(JSON.parse(db.prepare('SELECT checked_json FROM nameverse_check_progress LIMIT 1').get().checked_json),['.com','.net']);
  assert.throws(()=>rewriteProgressBatch(db,{...universe,authoritative:false}),/authoritative/);
  db.close();
});

test('progress maintenance resumes by rowid and observes its requested batch budget', () => {
 const db=new Database(':memory:');
 db.exec('CREATE TABLE nameverse_check_progress (universe_id TEXT,universe_version TEXT,checked_json TEXT,checked_waves_json TEXT)');
 const waves=encodeCheckedWaves(new Map([['.com',1000]]),universe.tlds);
 const put=db.prepare('INSERT INTO nameverse_check_progress VALUES (?,?,?,?)');
 for(let i=0;i<3;i++)put.run(universe.id,universe.version,'[".com"]',waves);
 const first=rewriteProgressBatch(db,universe,{batchSize:2,apply:true});
 assert.equal(first.changed,2);assert.equal(first.done,false);
 const second=rewriteProgressBatch(db,universe,{batchSize:2,afterRowid:first.afterRowid,apply:true});
 assert.equal(second.changed,1);assert.equal(second.done,true);
 db.close();
});

