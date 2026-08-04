#!/usr/bin/env node
'use strict';

const { coverageDates, normalizeTlds } = require('../server/drop-universe');
const {
  coverageCompleteForDay,
  fetchWhoisFreaksStatus,
  syncWhoisFreaksDroppedDay,
} = require('../server/dropped-feed-importer');

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function main() {
  const days = Math.min(365, Math.max(1, Number(option('days', '1')) || 1));
  const tlds = normalizeTlds(option('tlds', process.env.DOMAINSCOUT_DROP_FEED_TLDS || ''));
  if (!tlds.length) throw new Error('Pass --tlds=.ai,.com (or DOMAINSCOUT_DROP_FEED_TLDS)');
  if (!process.env.WHOISFREAKS_API_KEY) throw new Error('WHOISFREAKS_API_KEY is required');

  const providerStatus = await fetchWhoisFreaksStatus();
  const requestedEnd = option('end-date', providerStatus.lastUpdate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedEnd)) throw new Error('--end-date must use YYYY-MM-DD');
  if (requestedEnd > providerStatus.lastUpdate) {
    throw new Error(`Dropped feed is complete only through ${providerStatus.lastUpdate}; refusing ${requestedEnd}`);
  }
  const dates = coverageDates(days, new Date(`${requestedEnd}T00:00:00.000Z`));
  if (dates[0] < providerStatus.availableFrom) {
    throw new Error(`Dropped feed is retained from ${providerStatus.availableFrom}; cannot backfill ${dates[0]}`);
  }

  const summaries = [];
  for (const date of dates) {
    if (option('force', '0') !== '1' && coverageCompleteForDay({ date, tlds })) {
      const skipped = { date, skipped: true, reason: 'complete receipt already exists' };
      summaries.push(skipped);
      console.log(JSON.stringify(skipped));
      continue;
    }
    const summary = await syncWhoisFreaksDroppedDay({
      date,
      tlds,
      availabilityOptions: {
        concurrency: Number(option('concurrency', '2')) || 2,
        delayMs: Number(option('delay-ms', '1000')) || 1000,
      },
    });
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
  const incomplete = summaries.flatMap(summary => summary.receipts || []).filter(row => row.status !== 'complete');
  console.log(JSON.stringify({ providerStatus, windowStart: dates[0], windowEnd: dates.at(-1), days: dates.length }));
  if (incomplete.length) process.exitCode = 2;
}

main().catch(err => {
  console.error(`[DroppedFeed] ${err.message}`);
  process.exitCode = 1;
});
