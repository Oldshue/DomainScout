'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createUniverseLane } = require('../server/universe-lane');

const DAY = '2026-09-04';

const ROWS = [
  { domain: 'alpha.com', selection: 'departures', prev_class: 'seller', today_class: 'registrar', probe: { state: 'built' } },
  { domain: 'beta.com', selection: 'departures', prev_class: 'parking', today_class: 'hosting', probe: { state: 'parked' } },
  { domain: 'gamma.io', selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', probe: { state: 'built' } },
  { domain: 'delta.io', selection: 'went-live', prev_class: 'other', today_class: 'seller', probe: { state: 'blank' } },
  { domain: 'epsilon.net', selection: 'listed', prev_class: 'hosting', today_class: 'parking', probe: { state: 'parked' } },
  { domain: 'zeta.net', selection: 'listed', prev_class: 'seller', today_class: 'other', probe: { state: 'blank' } },
];

const SUMMARY = { totalRows: ROWS.length, departures: 2, wentLive: 2, listed: 2 };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-ns-movement-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const nsDir = path.join(directory, DAY, 'ns');
  await fs.mkdir(nsDir, { recursive: true });
  await fs.writeFile(path.join(nsDir, 'movement.jsonl'), `${ROWS.map(row => JSON.stringify(row)).join('\n')}\n`);
  await fs.writeFile(path.join(nsDir, 'summary.json'), JSON.stringify(SUMMARY));
  return createUniverseLane({ directory });
}

test('nsMovementSummary returns the day summary.json, defaulting to the latest ns-movement day', async t => {
  const lane = await fixture(t);
  assert.deepEqual(await lane.nsMovementSummary({ day: DAY }), SUMMARY);
  assert.deepEqual(await lane.nsMovementSummary({}), SUMMARY);
});

test('queryNsMovement filters by selection', async t => {
  const lane = await fixture(t);
  const result = await lane.queryNsMovement({ day: DAY, selection: 'departures' });
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(row => row.domain), ['alpha.com', 'beta.com']);
});

test('queryNsMovement filters by from (comma list of prev_class)', async t => {
  const lane = await fixture(t);
  const result = await lane.queryNsMovement({ day: DAY, from: 'seller,parking' });
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map(row => row.domain).sort(), ['alpha.com', 'beta.com', 'zeta.net']);
});

test('queryNsMovement filters by to (comma list of today_class)', async t => {
  const lane = await fixture(t);
  const result = await lane.queryNsMovement({ day: DAY, to: 'hosting,registrar' });
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map(row => row.domain).sort(), ['alpha.com', 'beta.com', 'gamma.io']);
});

test('queryNsMovement filters by probe.state', async t => {
  const lane = await fixture(t);
  const result = await lane.queryNsMovement({ day: DAY, state: 'built' });
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(row => row.domain).sort(), ['alpha.com', 'gamma.io']);
});

test('queryNsMovement filters by q substring on domain', async t => {
  const lane = await fixture(t);
  const result = await lane.queryNsMovement({ day: DAY, q: 'alpha' });
  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map(row => row.domain), ['alpha.com']);
});

test('queryNsMovement pages by scan cursor', async t => {
  const lane = await fixture(t);
  const first = await lane.queryNsMovement({ day: DAY, limit: 3 });
  assert.equal(first.total, 6);
  assert.deepEqual(first.items.map(row => row.domain), ['alpha.com', 'beta.com', 'gamma.io']);
  assert.equal(first.nextCursor, 3);
  const second = await lane.queryNsMovement({ day: DAY, limit: 3, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(row => row.domain), ['delta.io', 'epsilon.net', 'zeta.net']);
  assert.equal(second.nextCursor, null);
});

test('importNsMovement rejects a body whose first line is not {"summary": {...}}', async t => {
  const lane = await fixture(t);
  const importDay = '2026-09-05';
  const badBody = `${JSON.stringify({ domain: 'notasummary.com' })}\n`;
  await assert.rejects(
    lane.importNsMovement({ day: importDay, stream: Readable.from(badBody) }),
    error => error.statusCode === 400,
  );
});
