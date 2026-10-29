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
  const first=readProbableProjection(db,{limit:2});
  assert.deepEqual(first.entries.map(x=>x.domain),['alpha.com','zulu.com']);
  const next=readProbableProjection(db,{after:{date:'2026-10-29',domain:'zulu.com'},limit:2});
  assert.deepEqual(next.entries.map(x=>x.domain),['older.com']);
  const searched=readProbableProjection(db,{q:'inference',limit:2});
  assert.deepEqual(searched.entries.map(x=>x.domain),['alpha.com']);
  assert.equal(first.ledgerStore.serving,'indexed-probable-projection');
  db.close();
});
