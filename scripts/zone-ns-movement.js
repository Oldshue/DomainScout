#!/usr/bin/env node
'use strict';

/**
 * Zone nameserver movement CLI.
 *
 *   node scripts/zone-ns-movement.js build --zone com --day 2026-09-05 --prev-day 2026-09-04 \
 *        --prev zones/2026-09-04/com.zone.gz --today zones/2026-09-05/com.zone.gz --out work/2026-09-05/ns
 *
 *   node scripts/zone-ns-movement.js select --tape work/2026-09-05/ns/movement-com-2026-09-05.tsv.gz \
 *        --from seller,parking --to hosting,registrar,other [--limit N] [--json]
 *
 * `build` writes movement-<zone>-<day>.tsv.gz + .meta.json (see
 * server/zone-ns-movement.js). `select` prints tape rows whose class
 * transition matches (default: departures from seller/parking DNS, the
 * off-market sale footprint), one domain per line or JSON rows.
 */

const path = require('path');
const { writeZoneMovementTape, readZoneMovementTape } = require('../server/zone-ns-movement');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i += 1; }
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === 'build') {
    for (const key of ['zone', 'day', 'prev', 'today', 'out']) {
      if (!args[key]) throw new Error(`--${key} is required`);
    }
    const meta = await writeZoneMovementTape({
      zone: String(args.zone).toLowerCase(),
      day: args.day,
      prevDay: args['prev-day'] || null,
      prevPath: path.resolve(args.prev),
      todayPath: path.resolve(args.today),
      outDir: path.resolve(args.out),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${JSON.stringify({ ...meta, transitions: undefined, topGained: undefined, topLost: undefined })}\n`);
    return;
  }
  if (command === 'select') {
    if (!args.tape) throw new Error('--tape is required');
    const from = new Set(String(args.from || 'seller,parking').split(',').filter(Boolean));
    const to = new Set(String(args.to || 'hosting,registrar,other').split(',').filter(Boolean));
    const kinds = new Set(String(args.kind || 'changed').split(',').filter(Boolean));
    const limit = args.limit ? Number(args.limit) : Infinity;
    let n = 0;
    for await (const row of readZoneMovementTape(path.resolve(args.tape), {
      where: (r) => kinds.has(r.kind) && (from.has('*') || from.has(r.prev_class)) && (to.has('*') || to.has(r.today_class)),
    })) {
      process.stdout.write(args.json ? `${JSON.stringify(row)}\n` : `${row.domain}\n`);
      n += 1;
      if (n >= limit) break;
    }
    return;
  }
  throw new Error('usage: zone-ns-movement.js build|select ...');
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
