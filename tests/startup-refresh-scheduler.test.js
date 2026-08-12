'use strict';

const assert = require('assert');
const { scheduleStartupRefresh } = require('../server/startup-refresh-scheduler');

function fakeClock() {
  let nowMs = 0;
  let sequence = 0;
  const timers = [];
  return {
    now: () => nowMs,
    setTimer(callback, delayMs) {
      const timer = { id: ++sequence, at: nowMs + delayMs, callback, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cancelled = true; },
    advance(ms) {
      const target = nowMs + ms;
      while (true) {
        const due = timers
          .filter(timer => !timer.cancelled && timer.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        due.cancelled = true;
        nowMs = due.at;
        due.callback();
      }
      nowMs = target;
    },
  };
}

{
  const clock = fakeClock();
  let ready = false;
  const starts = [];
  const schedule = scheduleStartupRefresh({
    provider: 'unrelated-provider-fixture',
    inspectSnapshot: () => ({ serveable: true, generation: 'cached' }),
    isReady: () => ready,
    startRefresh: receipt => starts.push(receipt),
    serveableDelayMs: 15_000,
    readinessPollMs: 1_000,
    maxReadyWaitMs: 60_000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  assert.equal(schedule.initialDelayMs, 15_000);
  clock.advance(15_000);
  assert.equal(starts.length, 0, 'serveable cache must remain available while its read path warms');
  ready = true;
  clock.advance(1_000);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].provider, 'unrelated-provider-fixture');
  assert.equal(starts[0].disposition, 'stale-while-refresh');
  assert.equal(starts[0].ready, true);
}

{
  const clock = fakeClock();
  const starts = [];
  scheduleStartupRefresh({
    provider: 'missing-provider-fixture',
    inspectSnapshot: () => ({ serveable: false }),
    isReady: () => false,
    startRefresh: receipt => starts.push(receipt),
    missingDelayMs: 1_000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  clock.advance(999);
  assert.equal(starts.length, 0);
  clock.advance(1);
  assert.equal(starts.length, 1, 'missing providers must repair without waiting for read readiness');
  assert.equal(starts[0].disposition, 'repair-before-serve');
}

{
  const clock = fakeClock();
  const starts = [];
  const schedule = scheduleStartupRefresh({
    provider: 'cancelled-provider-fixture',
    inspectSnapshot: () => ({ serveable: true }),
    isReady: () => false,
    startRefresh: receipt => starts.push(receipt),
    serveableDelayMs: 10,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  assert.equal(schedule.cancel(), true);
  assert.equal(schedule.cancel(), false);
  clock.advance(120_000);
  assert.equal(starts.length, 0);
}

console.log('startup-refresh-scheduler tests passed');
