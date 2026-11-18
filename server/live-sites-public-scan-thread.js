'use strict';

// One of the feed reader's scan threads: finds the rows of a shared,
// in-memory text segment that contain a literal. Holds no state of its own.
const { parentPort } = require('node:worker_threads');
const { scanSegment } = require('./live-sites-public-snapshot');

parentPort.on('message', ({ id, lower, lowerStart, count, needle, from, to }) => {
  const rows = [];
  scanSegment({ lower: Buffer.from(lower), lowerStart: new Uint32Array(lowerStart), count }, Buffer.from(needle), row => rows.push(row), from, to);
  const found = Uint32Array.from(rows);
  parentPort.postMessage({ id, rows: found }, [found.buffer]);
});
