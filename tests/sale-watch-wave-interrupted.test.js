'use strict';

// Waves killed by a deploy or restart are not failures. A wave the supervisor
// killed for hanging (or for running past its ceiling) is recorded as
// 'abandoned' and counts as a failure; a row left unfinished by a restarted
// process is closed as 'interrupted' and is skipped by the failure streak
// without refreshing lastCleanFinishedAt. Uses node:sqlite so it runs without
// the better-sqlite3 native binding.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const recon = require('../server/sale-watch-reconstruction');

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE sale_watch_wave_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, stage TEXT, summary_json TEXT, reason TEXT)');
  return d;
}
function insert(d, startedAt, finishedAt, reason, summary = null) {
  d.prepare('INSERT INTO sale_watch_wave_runs(started_at, finished_at, stage, summary_json, reason) VALUES (?,?,?,?,?)')
    .run(startedAt, finishedAt, 'ingest', summary, reason);
}

test('interrupted waves (restart) are neither failures nor clean waves', () => {
  const d = db();
  insert(d, '2026-11-07T08:40:00Z', '2026-11-07T08:55:00Z', null, '{"stageErrors":[]}');
  insert(d, '2026-11-07T09:40:00Z', '2026-11-07T09:45:00Z', 'interrupted');
  insert(d, '2026-11-07T10:40:00Z', '2026-11-07T10:42:00Z', 'interrupted');
  insert(d, '2026-11-07T11:40:00Z', '2026-11-07T11:41:00Z', 'interrupted');
  const h = recon.waveHealth(d);
  assert.equal(h.healthy, true);
  assert.equal(h.consecutiveFailures, 0);
  assert.equal(h.lastCleanFinishedAt, '2026-11-07T08:55:00Z', 'an interrupted wave never counts as clean');
  assert.equal(h.interruptedSinceClean, 3);
  assert.equal(h.lastInterruptedAt, '2026-11-07T11:41:00Z');
  assert.equal(recon.waveRunFailed({ reason: 'interrupted' }), false);
  assert.equal(recon.waveRunInterrupted({ reason: 'interrupted' }), true);
});

test('abandoned (hung) waves still fail, and interruptions between them do not break the streak', () => {
  const d = db();
  insert(d, '2026-11-07T07:40:00Z', '2026-11-07T07:55:00Z', null, '{}');
  insert(d, '2026-11-07T08:40:00Z', '2026-11-07T08:50:00Z', 'abandoned', JSON.stringify({ stageErrors: [{ stage: 'probe', code: 'WAVE_TERMINATED' }] }));
  insert(d, '2026-11-07T09:40:00Z', '2026-11-07T09:41:00Z', 'interrupted');
  insert(d, '2026-11-07T10:40:00Z', '2026-11-07T10:50:00Z', 'abandoned', JSON.stringify({ stageErrors: [{ stage: 'searchIndex', code: 'WAVE_TERMINATED' }] }));
  const h = recon.waveHealth(d);
  assert.equal(h.healthy, false);
  assert.equal(h.consecutiveFailures, 2);
  assert.equal(h.failingSince, '2026-11-07T08:40:00Z');
  assert.equal(h.lastFailureReason, 'abandoned');
  assert.equal(h.lastStageErrors[0].stage, 'searchIndex');
  assert.equal(h.lastCleanFinishedAt, '2026-11-07T07:55:00Z');
});

test('closeInterruptedWaves closes only unfinished rows as interrupted', () => {
  const d = db();
  insert(d, '2026-11-07T08:40:00Z', '2026-11-07T08:55:00Z', null, '{}');
  insert(d, '2026-11-07T09:40:00Z', null, null);
  assert.equal(recon.closeInterruptedWaves(d, { now: new Date('2026-11-07T10:00:00Z') }), 1);
  const rows = d.prepare('SELECT finished_at, reason FROM sale_watch_wave_runs ORDER BY id').all();
  assert.equal(rows[0].reason, null);
  assert.equal(rows[1].reason, 'interrupted');
  assert.equal(rows[1].finished_at, '2026-11-07T10:00:00.000Z');
  assert.equal(recon.waveHealth(d).healthy, true);
  assert.equal(recon.closeInterruptedWaves(d), 0, 'idempotent');
});
