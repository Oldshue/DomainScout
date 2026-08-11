'use strict';

const { importCzdsDropCandidates, reconcileCzdsCoverage } = require('./zone-drop-census');

if (require.main === module) {
  const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size=') || arg.startsWith('--limit='));
  const batchSize = batchArg ? Number.parseInt(batchArg.split('=')[1], 10) : undefined;
  const summaryJson = process.argv.includes('--summary-json');
  importCzdsDropCandidates({ batchSize })
    .then((result) => {
      const output = summaryJson
        ? {
            imported: result.imported,
            selected: result.selected,
            byTld: result.byTld,
            sourceRows: result.sourceRows,
            structuralErrors: result.structuralErrors,
            complete: result.complete,
            failClosed: result.failClosed,
            status: result.status,
            error: result.error,
          }
        : result;
      console.log(JSON.stringify(output, null, summaryJson ? 0 : 2));
    })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = {
  importCzdsDropCandidates,
  reconcileCzdsCoverage,
};
