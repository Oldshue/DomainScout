'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { streamRowBatches } = require('../server/stream-row-batches');
test('exports every unrelated inventory row with bounded enrichment, backpressure and event-loop turns', async () => {
  const rows = Array.from({ length: 1203 }, (_, id) => ({ id, kind: 'component' }));
  const chunks = []; let largest = 0; let turns = 0;
  const timer = setInterval(() => turns++, 1);
  const response = new Writable({ highWaterMark: 1, write(chunk, _, done) { chunks.push(chunk.toString()); setImmediate(done); } });
  try {
    const written = await streamRowBatches({ rows, response, batchSize: 100,
      hydrate(batch) { largest = Math.max(largest, batch.length); batch.forEach(r => r.checked = true); },
      serialize(row, index) { assert.equal(row.id, index); assert.equal(row.checked, true); return JSON.stringify(row) + '\n'; },
    });
    assert.equal(written, rows.length); assert.equal(chunks.length, rows.length); assert.equal(largest, 100); assert.ok(turns > 0);
  } finally { clearInterval(timer); response.destroy(); }
});
test('disconnect stops further hydration and closes a blocked drain wait', async () => {
  let hydrated = 0;
  const response = new Writable({ highWaterMark: 1, write(_, __, done) { setImmediate(() => { response.destroy(); done(); }); } });
  const written = await streamRowBatches({ rows: Array.from({length: 500}, (_, id) => ({id})), response,
    hydrate() { hydrated++; }, serialize: row => JSON.stringify(row) });
  assert.equal(hydrated, 1); assert.equal(written, 1);
});
