'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeProviderGenerations } = require('../server/provider-generation-admission');
const { snapshotDemandCandidates } = require('../server/provider-snapshot-demand');
const { buildPreverifyOrder } = require('../server/preverify-order');

test('a new immutable snapshot admits its near-term auction with a full warm queue; unchanged metadata does not scan', () => {
  const queue = new Map(Array.from({ length: 120_000 }, (_, index) => [`warm-${index}`, index]));
  const state = new Map([['fixture-auction', 'generation-old:120000']]);
  let generation = 'generation-new';
  let indexReads = 0;
  let releases = 0;
  const index = {
    excludeEnded: true,
    sortedBy: 'auction_end_asc',
    compactColumnIndex: { domain: 0, auction_end: 1 },
    compactRows: [
      ['urgent-new-auction.com', '2026-10-13T12:05:00.000Z'],
      ['later-new-auction.com', '2026-10-14T12:00:00.000Z'],
    ],
  };
  const probe = () => probeProviderGenerations({
    streams: ['fixture-auction'],
    readMeta: () => ({ generationId: generation, count: 2 }),
    readIndex: () => { indexReads += 1; return index; },
    readFingerprint: stream => state.get(stream),
    extractCandidates: snapshotDemandCandidates,
    candidateLimit: 120_000,
    release: () => { releases += 1; },
    admit: (byStream, fingerprints) => {
      const fresh = buildPreverifyOrder(byStream, { max: 120_000 });
      fresh.forEach((row, position) => queue.set(row.base_name, -500_000 + position));
      Object.entries(fingerprints).forEach(([stream, value]) => state.set(stream, value));
    },
    nowMs: Date.parse('2026-10-13T12:00:00.000Z'),
  });

  const changed = probe();
  assert.deepEqual(changed.changedStreams, ['fixture-auction']);
  assert.equal(indexReads, 1);
  assert.equal(releases, 1);
  assert.equal(queue.size, 120_002, 'the full durable queue must not suppress fresh inventory');
  assert.deepEqual([...queue.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2), [
    ['urgent-new-auction', -500_000],
    ['later-new-auction', -499_999],
  ]);

  const unchanged = probe();
  assert.deepEqual(unchanged.changedStreams, []);
  assert.equal(indexReads, 1, 'an unchanged generation must stop at the metadata probe');
  assert.equal(releases, 1, 'an unchanged generation must not disturb the live index cache');
  assert.equal(queue.size, 120_002);
});
