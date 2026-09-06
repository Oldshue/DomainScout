#!/usr/bin/env node
'use strict';

// Read-only acceptance replay against a real daily corpus. Run on the cloud
// service after an import/rebuild; counts must agree with every drilldown.
const path = require('node:path');
const Database = require('better-sqlite3');
const { computeDailyFragments, computeDailyDomains } = require('../server/domainlab');
const date = process.argv[2] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const zone = process.argv[3] || 'com';
const raw = new Database(path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data'), 'zone_index.db'), { readonly: true });
const db = { prepare: sql => raw.prepare(sql.replaceAll('zi.', '')), exec: () => {} };
const report = computeDailyFragments(db, { date, zone, limit: 100 });
const mismatches = [];
for (const row of report.tokens) {
  const drill = computeDailyDomains(db, { date, zone, mode: 'fragments', token: row.token, limit: 1 });
  if (drill.total !== row.count) mismatches.push({ token: row.token, count: row.count, drill: drill.total });
}
const total = raw.prepare('SELECT COUNT(*) AS n FROM zone_daily_new_names WHERE report_date = ?').get(date).n;
const receipt = report.coverage?.receipt;
const passed = Boolean(receipt && receipt.acceptedNames === total && report.tokens.length && !mismatches.length && report.baseline.complete);
console.log(JSON.stringify({ passed, date, zone, rowsVerified: report.tokens.length, corpusNames: total, sourceDigest: receipt?.sourceDigest, baseline: report.baseline, mismatches, topPatterns: report.tokens.slice(0, 12) }, null, 2));
raw.close();
process.exitCode = passed ? 0 : 1;
