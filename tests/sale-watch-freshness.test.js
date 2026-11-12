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
    sellerBacklog: { ready: true, unchecked: 0, oldestDay: null, oldestArrivedAt: null },
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
  // The journal size limit is the truncate target: a brief overshoot is not degraded.
  assert.equal(verdict(healthy({ wal: { bytes: 64 * 1024 * 1024 + 1 } })).verdict, 'current');
  assert.equal(verdict(healthy({ wal: { bytes: 64 * 1024 * 1024 * f.WAL_DEGRADED_LIMIT_MULTIPLE } })).verdict, 'current');
  assert.equal(verdict(healthy({ wal: { bytes: 64 * 1024 * 1024 * f.WAL_DEGRADED_LIMIT_MULTIPLE + 1 } })).verdict, 'degraded');
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

test('a classifier rebuild that is progressing is informational, not stale or degraded', () => {
  const r = verdict(healthy({ assessments: { version: 'sale-evidence-v15', currentVersion: 'sale-evidence-v16', versionComplete: false, rebuildProgressAt: iso(ms(NOW) - 5 * 60000) } }));
  assert.equal(r.verdict, 'current', JSON.stringify(r.reasons));
  assert.deepEqual(r.reasons, []);
  assert.equal(r.rebuild.inProgress, true);
  assert.equal(r.rebuild.progressing, true);
  assert.equal(r.rebuild.toVersion, 'sale-evidence-v16');
  assert.ok(r.checks.some(c => c.name === 'rebuild' && c.status === 'ok'));
  assert.ok(!r.checks.some(c => c.name === 'assessment-version'));
});

test('a classifier rebuild becomes degraded only once it stops making progress', () => {
  const edge = verdict(healthy({ assessments: { versionComplete: false, rebuildProgressAt: iso(ms(NOW) - f.REBUILD_STALL_MS) } }));
  assert.equal(edge.verdict, 'current');
  const stalled = verdict(healthy({ assessments: { versionComplete: false, rebuildProgressAt: iso(ms(NOW) - f.REBUILD_STALL_MS - 1) } }));
  assert.equal(stalled.verdict, 'degraded');
  assert.equal(stalled.rebuild.progressing, false);
  assert.match(stalled.reasons.join(' '), /rebuild/);
  const never = verdict(healthy({ assessments: { versionComplete: false, rebuildProgressAt: null } }));
  assert.equal(never.verdict, 'degraded');
  assert.equal(verdict(healthy()).rebuild, null, 'no rebuild part when the store is on the current version');
});

test('reader status: last update is the newer of the clean wave and the movement import; behind only when stale', () => {
  const parts = healthy({ wave: { lastCleanFinishedAt: '2026-11-07T09:30:00.000Z' }, movement: { latestImportedAt: '2026-11-07T09:50:00.000Z' } });
  const r = verdict(parts);
  assert.equal(r.verdict, 'current');
  assert.deepEqual(r.reader, { lastUpdateAt: '2026-11-07T09:50:00.000Z', behind: false });
  const rebuilding = verdict(healthy({ assessments: { versionComplete: false, rebuildProgressAt: iso(ms(NOW) - 60000) } }));
  assert.equal(rebuilding.reader.behind, false, 'a rebuild in progress is not behind');
  const degraded = verdict(healthy({ wave: { consecutiveFailures: 1, failingStages: ['searchIndex'] } }));
  assert.equal(degraded.verdict, 'degraded');
  assert.equal(degraded.reader.behind, false, 'one failed wave is not behind');
  const stale = verdict(healthy({ wave: { lastCleanFinishedAt: iso(ms(NOW) - 3 * 3600000) }, movement: { latestImportedAt: null } }));
  assert.equal(stale.verdict, 'stale');
  assert.equal(stale.reader.behind, true);
  assert.equal(stale.reader.lastUpdateAt, iso(ms(NOW) - 3 * 3600000));
  assert.deepEqual(f.readerStatus({}, 'current'), { lastUpdateAt: null, behind: false }, 'unknown time is null, never a store marker');
});

test('seller backlog: a departure admitted after a clean wave that left none unchecked ages from that wave, a survivor keeps its full age', () => {
  const check = sb => verdict(healthy({ sellerBacklog: sb })).checks.find(c => c.name === 'seller-backlog');
  const old = iso(ms(NOW) - 25 * 60 * 60000);
  // Departure day imported yesterday, admitted during the running wave: the last clean wave (70 min ago) left none.
  const admitted = check({ ready: true, unchecked: 1, oldestDay: '2026-11-06', oldestArrivedAt: old, clearedSince: iso(ms(NOW) - 70 * 60000) });
  assert.equal(admitted.status, 'ok');
  assert.match(admitted.detail, /oldest 70 min/);
  // No clean wave has cleared the backlog: the row survived, full age applies.
  assert.equal(check({ ready: true, unchecked: 1, oldestDay: '2026-11-06', oldestArrivedAt: old, clearedSince: null }).status, 'stale');
  assert.equal(check({ ready: true, unchecked: 1, oldestDay: '2026-11-06', oldestArrivedAt: old }).status, 'stale');
  // Waves stopped: the floor itself ages past the bounds.
  assert.equal(check({ ready: true, unchecked: 1, oldestDay: '2026-11-06', oldestArrivedAt: old, clearedSince: iso(ms(NOW) - f.SELLER_BACKLOG_DEGRADED_MS - 1) }).status, 'degraded');
  assert.equal(check({ ready: true, unchecked: 1, oldestDay: '2026-11-06', oldestArrivedAt: old, clearedSince: iso(ms(NOW) - f.SELLER_BACKLOG_STALE_MS - 1) }).status, 'stale');
  // A row that arrived after the floor ages from its own arrival.
  assert.match(check({ ready: true, unchecked: 1, oldestDay: '2026-11-07', oldestArrivedAt: iso(ms(NOW) - 10 * 60000), clearedSince: iso(ms(NOW) - 70 * 60000) }).detail, /oldest 10 min/);
});

test('sellerBacklogClearedSince: the latest finished wave that recorded its backlog decides', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  require('../server/sale-watch-reconstruction').ensureReconstructionSchema(db);
  const add = (startedAt, finishedAt, summary) => db.prepare('INSERT INTO sale_watch_wave_runs (started_at, finished_at, stage, summary_json) VALUES (?, ?, ?, ?)')
    .run(startedAt, finishedAt, 'health', summary == null ? null : JSON.stringify(summary));
  assert.equal(f.sellerBacklogClearedSince(db), null, 'no waves');
  add('2026-11-07T06:40:00.000Z', '2026-11-07T06:55:00.000Z', { probed: 1 });
  assert.equal(f.sellerBacklogClearedSince(db), null, 'waves from before the field say nothing');
  add('2026-11-07T07:40:00.000Z', '2026-11-07T07:55:00.000Z', { sellerBacklog: { unchecked: 0, oldestDay: null } });
  assert.equal(f.sellerBacklogClearedSince(db), '2026-11-07T07:40:00.000Z');
  // An interrupted or failed wave records nothing and does not move the floor; a running wave is ignored.
  add('2026-11-07T08:40:00.000Z', '2026-11-07T08:45:00.000Z', null);
  add('2026-11-07T09:40:00.000Z', null, null);
  assert.equal(f.sellerBacklogClearedSince(db), '2026-11-07T07:40:00.000Z');
  // A clean wave that left survivors removes the floor.
  add('2026-11-07T09:50:00.000Z', '2026-11-07T09:58:00.000Z', { sellerBacklog: { unchecked: 3, oldestDay: '2026-11-06' } });
  assert.equal(f.sellerBacklogClearedSince(db), null);
  db.close();
});
