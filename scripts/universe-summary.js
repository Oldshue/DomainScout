#!/usr/bin/env node
'use strict';

const {
  buildUniverseSummaryTape,
  importUniverseSummaryTape,
} = require('../server/universe-summary');

const silentLog = { log: () => {} };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

async function runBuild(argv) {
  const args = parseArgs(argv);
  const namesDir = args.names;
  const day = args.day;
  const outDir = args.out;
  const minZones = args['min-zones'] !== undefined ? Number(args['min-zones']) : 2;
  if (!namesDir || !day || !outDir) {
    throw new Error('build requires --names <dir> --day <YYYY-MM-DD> --out <dir>');
  }
  const meta = await buildUniverseSummaryTape({ namesDir, day, outDir, minZones, log: silentLog });
  if (args.import) {
    return importUniverseSummaryTape({ tapePath: meta.tapePath, dataDir: args.import, log: silentLog });
  }
  return meta;
}

async function runImport(argv) {
  const [tapePath, dataDir] = argv;
  if (!tapePath || !dataDir) {
    throw new Error('import requires <tapePath> <dataDir>');
  }
  return importUniverseSummaryTape({ tapePath, dataDir, log: silentLog });
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  try {
    let result;
    if (verb === 'build') {
      result = await runBuild(rest);
    } else if (verb === 'import') {
      result = await runImport(rest);
    } else {
      throw new Error(`Unknown verb: ${verb || '(none)'}. Use "build" or "import".`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exit(1);
  }
}

main();
