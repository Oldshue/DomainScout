'use strict';

const { backfillWordTrendsFromDailyNames } = require('../server/zone-indexer');

const arg = name => {
  const prefix = `--${name}=`;
  const value = process.argv.find(item => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
};

const receipt = backfillWordTrendsFromDailyNames({
  from: arg('from'),
  to: arg('to'),
  days: arg('days'),
  force: process.argv.includes('--force'),
});

console.log(JSON.stringify(receipt, null, 2));
