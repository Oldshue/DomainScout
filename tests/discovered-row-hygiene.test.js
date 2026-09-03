'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { purgeMalformedDiscoveredRows } = require('../server/discovered-row-hygiene');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE domains (
      id INTEGER PRIMARY KEY,
      domain TEXT,
      base_name TEXT,
      stream TEXT
    )
  `);
  return db;
}

test('purgeMalformedDiscoveredRows removes malformed discovered rows only', () => {
  const db = makeDb();
  const insert = db.prepare('INSERT INTO domains (domain, base_name, stream) VALUES (?, ?, ?)');
  insert.run('selfpubli.sh', 'selfpubli', 'discovered');
  insert.run('hostmaster@example.sh', 'hostmaster@example', 'discovered');
  insert.run('foo.co.uk', 'foo.co', 'discovered');
  insert.run('postmaster@example.sh', 'postmaster@example', 'pending-delete');

  const result = purgeMalformedDiscoveredRows(db);
  assert.deepEqual(result, { stream: 'discovered', matched: 2, deleted: 2 });

  const remaining = db.prepare('SELECT domain, stream FROM domains ORDER BY id').all();
  assert.equal(remaining.length, 2);
  assert.ok(remaining.some((r) => r.domain === 'selfpubli.sh' && r.stream === 'discovered'));
  assert.ok(remaining.some((r) => r.domain === 'postmaster@example.sh' && r.stream === 'pending-delete'));

  const second = purgeMalformedDiscoveredRows(db);
  assert.deepEqual(second, { stream: 'discovered', matched: 0, deleted: 0 });
});

test('server/index.js wires the boot-time purge call', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.ok(indexSrc.includes("require('./discovered-row-hygiene')"));
  assert.ok(indexSrc.includes('purgeMalformedDiscoveredRows(db)'));
});
