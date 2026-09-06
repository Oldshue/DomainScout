#!/usr/bin/env node
'use strict';

// Operator entry point for the cloud NRD importer: import/top-up N days of the
// WhoisDS newly-registered-domains feed into zone_index.db from a shell
// (railway ssh -- node /app/scripts/nrd-topup.js 60). The scheduled lanes in
// server/index.js only reach back 3 days (30 on an empty database); this
// script exists for deeper one-off backfills — e.g. widening retention — and
// is import-idempotent (already-imported days skip instantly). The mac's
// equivalent is scripts/nrd-backfill.py; this is the Railway-side twin built
// on the same importer module the server uses.
//
// Usage: node scripts/nrd-topup.js [DAYS] [END_DATE]
//   DAYS      how many days back to cover (default 3, max 120)
//   END_DATE  newest day to import, YYYY-MM-DD (default: yesterday UTC)

const path = require('path');
const Database = require('better-sqlite3');
const { runNrdTopUp } = require('../server/nrd-importer');

const days = Math.max(1, Math.min(120, parseInt(process.argv[2], 10) || 3));
const endDate = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3] || '') ? process.argv[3] : undefined;
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const db = new Database(path.join(dataDir, 'zone_index.db'));
db.pragma('busy_timeout = 30000');

runNrdTopUp(db, { days, endDate, dailyDays: Math.max(days, 60), rebuild: process.argv.includes('--rebuild'), verifyLegacy: process.argv.includes('--verify-legacy') })
  .then((summary) => {
    const imported = (summary.results || []).filter(r => r.imported).length;
    console.log(`[nrd-topup] done: ${imported}/${(summary.results || []).length} days imported${summary.diskPressure ? ' (disk pressure: imports skipped)' : ''}`);
    console.log('NRD_TOPUP_RESULT ' + JSON.stringify(summary));
    db.close();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[nrd-topup] failed: ${err.message}`);
    process.exit(1);
  });
