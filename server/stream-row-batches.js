'use strict';
const { setImmediate: yieldTurn } = require('node:timers/promises');
// Bounded enrichment and response backpressure for any inventory export.
async function streamRowBatches({ rows, response, hydrate = () => {}, serialize, batchSize = 100 }) {
  let written = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    if (response.destroyed || response.writableEnded) break;
    const batch = rows.slice(start, start + batchSize);
    await hydrate(batch);
    for (const row of batch) {
      if (response.destroyed || response.writableEnded) return written;
      if (!response.write(serialize(row, written++))) {
        await new Promise((resolve, reject) => {
          const cleanup = () => { response.off('drain', done); response.off('close', done); response.off('error', failed); };
          const done = () => { cleanup(); resolve(); };
          const failed = error => { cleanup(); reject(error); };
          response.once('drain', done); response.once('close', done); response.once('error', failed);
        });
      }
    }
    await yieldTurn();
  }
  return written;
}
module.exports = { streamRowBatches };
