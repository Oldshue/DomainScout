#!/usr/bin/env node
'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { rebuildProjection } = require('../server/sale-watch-probable');

const dbPath = path.resolve(process.argv[2]);
const ledgerPath = path.resolve(process.argv[3]);
const discoveryPath = path.resolve(process.argv[4]);
const db = new Database(dbPath);
try {
  db.pragma('busy_timeout = 30000');
  db.pragma('journal_mode = WAL');
  const result = rebuildProjection(db, { ledgerPath, discoveryPath });
  process.stdout.write(`${JSON.stringify({ dbPath, ...result })}\n`);
} finally {
  db.close();
}
