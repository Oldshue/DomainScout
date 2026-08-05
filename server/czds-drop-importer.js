'use strict';

const { importCzdsDropCandidates, reconcileCzdsCoverage } = require('./zone-drop-census');

if (require.main === module) {
  const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size=') || arg.startsWith('--limit='));
  const batchSize = batchArg ? Number.parseInt(batchArg.split('=')[1], 10) : undefined;
  importCzdsDropCandidates({ batchSize })
    .then((result) => { console.log(JSON.stringify(result, null, 2)); })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = {
  importCzdsDropCandidates,
  reconcileCzdsCoverage,
};
