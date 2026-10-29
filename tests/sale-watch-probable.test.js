'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureProjectionSchema, readProbableProjection } = require('../server/sale-watch-probable');

function row(domain, date, text) {
  return { domain, reportDate: date, classification: 'likely-sale', tier: 'probable', buyerTitle: text, storedAssessment: true };
}

test('probably-sold projection uses chronological indexed pages and FTS search', () => {
  const db = new Database(':memory:');
  ensureProjectionSchema(db);
  const insert = db.prepare('INSERT INTO sale_watch_probable(domain,report_date,entry_json) VALUES(?,?,?)');
  const fts = db.prepare('INSERT INTO sale_watch_probable_fts(rowid,domain,body) VALUES(?,?,?)');
  for (const item of [row('zulu.com','2026-10-29','Planning tools'),row('alpha.com','2026-10-29','Inference cloud'),row('older.com','2026-10-28','Planning')]) {
    insert.run(item.domain,item.reportDate,JSON.stringify(item));
    const id=db.prepare('SELECT rowid FROM sale_watch_probable WHERE domain=?').get(item.domain).rowid;
    fts.run(id,item.domain,`${item.domain} ${item.buyerTitle}`);
  }
  db.prepare("INSERT INTO sale_watch_probable_meta(key,value) VALUES('count','3')").run();
  db.prepare("INSERT INTO sale_watch_probable_meta(key,value) VALUES('generatedAt','2026-10-29T17:04:19.922Z')").run();
  db.prepare("INSERT INTO sale_watch_probable_meta(key,value) VALUES('evidenceGeneratedAt','2026-10-29T17:04:05.038Z')").run();
  db.prepare("INSERT INTO sale_watch_probable_meta(key,value) VALUES('evidenceCoverage',?)").run(JSON.stringify({
    discoveryMode: 'public-reverse-nameserver',
    nameserverDiscovery: { coverageStatus: 'partial-public-sample' },
    nameserverDeparturesInspected: 823,
    nameserverAssociationsExposed: 1500,
  }));
  const first=readProbableProjection(db,{limit:2});
  assert.deepEqual(first.entries.map(x=>x.domain),['alpha.com','zulu.com']);
  const next=readProbableProjection(db,{after:{date:'2026-10-29',domain:'zulu.com'},limit:2});
  assert.deepEqual(next.entries.map(x=>x.domain),['older.com']);
  const searched=readProbableProjection(db,{q:'inference',limit:2});
  assert.deepEqual(searched.entries.map(x=>x.domain),['alpha.com']);
  assert.equal(first.ledgerStore.serving,'indexed-probable-projection');
  assert.equal(first.generatedAt,'2026-10-29T17:04:05.038Z');
  assert.equal(first.coverage.discoveryMode,'public-reverse-nameserver');
  assert.equal(first.coverage.nameserverDeparturesInspected,823);
  db.close();
});

test('an unbuilt probably-sold projection is pending, never a trustworthy empty result', () => {
  const db = new Database(':memory:');
  ensureProjectionSchema(db);
  const result = readProbableProjection(db, { limit: 10 });
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.entries, []);
  assert.equal(result.ledgerStore.generatedAt, null);
  db.close();
});
