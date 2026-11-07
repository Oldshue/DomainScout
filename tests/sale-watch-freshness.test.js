'use strict';

// Freshness contract verdicts. Every fixture uses fixed dates and an explicit
// `now`, so nothing here rots as the calendar moves.

const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../server/sale-watch-freshness');

const NOW = '2026-11-07T10:00:00.000Z';
const ms = iso => Date.parse(iso);
const iso = n => new Date(n).toISOString();
const days = (from, to) => { const out = []; for (let d = ms(`${from}T00:00:00Z`); d <= ms(`${to}T00:00:00Z`); d += 86400000) out.push(iso(d).slice(0, 10)); return out; };

function healthy(overrides = {}) {
  const base = {
    now: NOW,
    wave: { lastCleanFinishedAt: iso(ms(NOW) - 30 * 60000), consecutiveFailures: 0, failingSince: null, failingStages: [], lastFailureReason: null, inProgressSince: null, inProgressStage: null },
    movement: { latestImportedDay: '2026-11-07', importedDays: days('2026-11-01', '2026-11-07'), newestAvailableDay: '2026-11-07', availableDays: days('2026-11-01', '2026-11-07'), expectedDay: '2026-11-07' },
    discovery: { bytes: 100, limitBytes: 1000 },
    wal: { bytes: 0, limitBytes: 64 * 1024 * 1024 },
    assessments: { dirtyBacklog: 0, oldestDirtyAt: null, version: 'v', currentVersion: 'v', versionComplete: true },
    probableList: { newestReportDate: '2026-11-06' },
    disk: { freeBytes: 10 * 1024 ** 3, totalBytes: 50 * 1024 ** 3 },
  };
  for (const [k, v] of Object.entries(overrides)) base[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] ? { ...base[k], ...v } : v;
  return base;
}
const verdict = (parts, opts = {}) => f.evaluateFreshness(parts, { now: parts.now || NOW, ...opts });

test('thresholds are the named constants the contract promises', () => {
  assert.equal(f.CLEAN_WAVE_MAX_AGE_MS, 2 * 60 * 60 * 1000);
  assert.equal(f.DIRTY_BACKLOG_MAX_AGE_MS, 60 * 60 * 1000);
  assert.equal(f.MOVEMENT_TAPE_READY_UTC_HOUR, 9);
  assert.deepEqual(f.VERDICTS, ['current', 'degraded', 'stale']);
});

test('a fully healthy contract is current', () => {
  const r = verdict(healthy());
  assert.equal(r.verdict, 'current', JSON.stringify(r.reasons));
  assert.equal(r.schema, f.SCHEMA);
  assert.deepEqual(r.reasons, []);
});

test('clean wave: exactly 2 h old is current, 1 ms past is stale, none recorded is stale', () => {
  assert.equal(verdict(healthy({ wave: { lastCleanFinishedAt: iso(ms(NOW) - f.CLEAN_WAVE_MAX_AGE_MS) } })).verdict, 'current');
  const late = verdict(healthy({ wave: { lastCleanFinishedAt: iso(ms(NOW) - f.CLEAN_WAVE_MAX_AGE_MS - 1) } }));
  assert.equal(late.verdict, 'stale');
  assert.match(late.reasons.join(' '), /wave/);
  assert.equal(verdict(healthy({ wave: { lastCleanFinishedAt: null } })).verdict, 'stale');
});

test('consecutive failures: one is degraded, two are stale and name the failing stages', () => {
  assert.equal(verdict(healthy({ wave: { consecutiveFailures: 1, failingStages: ['movement'] } })).verdict, 'degraded');
  const r = verdict(healthy({ wave: { consecutiveFailures: f.WAVE_FAILURES_STALE, failingStages: ['discovery', 'movement'] } }));
  assert.equal(r.verdict, 'stale');
  assert.match(r.reasons.join(' '), /discovery, movement/);
});

test('movement: before the tape hour yesterday suffices; from the tape hour today must be imported', () => {
  const through6 = { latestImportedDay: '2026-11-06', importedDays: days('2026-10-31', '2026-11-06'), newestAvailableDay: '2026-11-06', availableDays: days('2026-10-31', '2026-11-06') };
  const before = '2026-11-07T08:59:59.999Z';
  const early = healthy({ now: before, wave: { lastCleanFinishedAt: iso(ms(before) - 60000) }, movement: { ...through6, expectedDay: f.expectedMovementDay(ms(before)) } });
  assert.equal(early.movement.expectedDay, '2026-11-06');
  assert.equal(verdict(early).verdict, 'current', JSON.stringify(verdict(early).reasons));
  const at = '2026-11-07T09:00:00.000Z';
  const late = healthy({ now: at, wave: { lastCleanFinishedAt: iso(ms(at) - 60000) }, movement: { ...through6, expectedDay: f.expectedMovementDay(ms(at)) } });
  const r = verdict(late);
  assert.equal(r.verdict, 'stale');
  assert.match(r.reasons.join(' '), /2026-11-07/);
});

test('a missing movement day inside the window is a failure, never a pass', () => {
  const imported = days('2026-11-01', '2026-11-07').filter(d => d !== '2026-11-04');
  const r = verdict(healthy({ movement: { importedDays: imported } }));
  assert.equal(r.verdict, 'stale');
  assert.match(r.reasons.join(' '), /2026-11-04/);
  // Even when the day never appeared upstream (no tape folder), the gap fails.
  const r2 = verdict(healthy({ movement: { importedDays: imported, availableDays: imported } }));
  assert.equal(r2.verdict, 'stale');
  assert.equal(verdict(healthy({ movement: { importedDays: null } })).verdict, 'stale', 'unreadable imports fail');
});

test('dirty backlog: oldest exactly 1 h is current, 1 ms past is stale, unknown age is degraded', () => {
  assert.equal(verdict(healthy({ assessments: { dirtyBacklog: 5, oldestDirtyAt: iso(ms(NOW) - f.DIRTY_BACKLOG_MAX_AGE_MS) } })).verdict, 'current');
  assert.equal(verdict(healthy({ assessments: { dirtyBacklog: 5, oldestDirtyAt: iso(ms(NOW) - f.DIRTY_BACKLOG_MAX_AGE_MS - 1) } })).verdict, 'stale');
  assert.equal(verdict(healthy({ assessments: { dirtyBacklog: 5, oldestDirtyAt: null } })).verdict, 'degraded');
  assert.equal(verdict(healthy({ assessments: { dirtyBacklog: null } })).verdict, 'stale');
  assert.equal(verdict(healthy({ assessments: { versionComplete: false } })).verdict, 'degraded');
});

test('discovery file, wal and disk headroom thresholds', () => {
  assert.equal(verdict(healthy({ discovery: { bytes: 750 } })).verdict, 'current');
  assert.equal(verdict(healthy({ discovery: { bytes: 751 } })).verdict, 'degraded');
  assert.equal(verdict(healthy({ discovery: { bytes: 1001 } })).verdict, 'stale');
  assert.equal(verdict(healthy({ wal: { bytes: 64 * 1024 * 1024 + 1 } })).verdict, 'degraded');
  assert.equal(verdict(healthy({ wal: { bytes: f.WAL_STALE_BYTES + 1 } })).verdict, 'stale');
  assert.equal(verdict(healthy({ disk: { freeBytes: f.DISK_DEGRADED_FREE_BYTES - 1 } })).verdict, 'degraded');
  assert.equal(verdict(healthy({ disk: { freeBytes: f.DISK_STALE_FREE_BYTES - 1 } })).verdict, 'stale');
  assert.equal(verdict(healthy({ disk: null })).verdict, 'degraded');
  assert.equal(verdict(healthy({ probableList: { newestReportDate: null } })).verdict, 'degraded');
});

test('a running wave with a fresh heartbeat is a healthy long pass; a silent one is stale', () => {
  const parts = healthy();
  const healthyPass = verdict(parts, { supervisor: { running: true, startedAt: iso(ms(NOW) - 50 * 60000), lastHeartbeatAt: iso(ms(NOW) - 5000), stage: 'probe' } });
  assert.equal(healthyPass.verdict, 'current');
  assert.equal(healthyPass.waveRunning.healthy, true);
  const stuck = verdict(parts, { supervisor: { running: true, startedAt: iso(ms(NOW) - 50 * 60000), lastHeartbeatAt: iso(ms(NOW) - f.WAVE_HEARTBEAT_STALE_MS - 1), stage: 'probe' } });
  assert.equal(stuck.verdict, 'stale');
  assert.equal(stuck.waveRunning.healthy, false);
});

test('unreadable parts never pass and the status line states the verdict', () => {
  assert.equal(verdict({ now: NOW }).verdict, 'stale');
  assert.equal(f.freshnessStatusLine(verdict(healthy())), 'Current');
  assert.match(f.freshnessStatusLine(verdict(healthy({ wave: { lastCleanFinishedAt: null } }))), /^Stale: /);
  assert.equal(f.freshnessStatusLine(null), 'Freshness unknown');
});
