'use strict';

function positiveDelay(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Keep a serveable provider snapshot available through desktop startup before
 * beginning resource-heavy refresh work. Missing/unserveable providers still
 * repair immediately; a provider that already has a verified snapshot waits for
 * its read path to become ready (or a bounded recovery deadline) first.
 */
function scheduleStartupRefresh(options = {}) {
  const provider = String(options.provider || '').trim();
  if (!provider) throw new Error('startup refresh provider is required');
  if (typeof options.inspectSnapshot !== 'function') throw new Error('inspectSnapshot is required');
  if (typeof options.isReady !== 'function') throw new Error('isReady is required');
  if (typeof options.startRefresh !== 'function') throw new Error('startRefresh is required');

  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const now = options.now || Date.now;
  const serveableDelayMs = positiveDelay(options.serveableDelayMs, 15_000);
  const missingDelayMs = positiveDelay(options.missingDelayMs, 1_000);
  const readinessPollMs = Math.max(1, positiveDelay(options.readinessPollMs, 1_000));
  const maxReadyWaitMs = Math.max(readinessPollMs, positiveDelay(options.maxReadyWaitMs, 60_000));
  const startedAt = now();
  let timer = null;
  let cancelled = false;
  let settled = false;

  const arm = (delayMs, callback) => {
    timer = setTimer(callback, delayMs);
    if (typeof timer?.unref === 'function') timer.unref();
  };

  const attempt = () => {
    if (cancelled || settled) return;
    const snapshot = options.inspectSnapshot() || {};
    const serveable = snapshot.serveable === true;
    const ready = options.isReady() === true;
    const elapsedMs = Math.max(0, now() - startedAt);
    if (serveable && !ready && elapsedMs < maxReadyWaitMs) {
      arm(readinessPollMs, attempt);
      return;
    }
    settled = true;
    options.startRefresh({
      provider,
      snapshot,
      serveable,
      ready,
      elapsedMs,
      disposition: serveable ? 'stale-while-refresh' : 'repair-before-serve',
    });
  };

  const initialSnapshot = options.inspectSnapshot() || {};
  const initialDelayMs = initialSnapshot.serveable === true ? serveableDelayMs : missingDelayMs;
  arm(initialDelayMs, attempt);

  return {
    provider,
    initialDelayMs,
    cancel() {
      if (cancelled || settled) return false;
      cancelled = true;
      if (timer != null) clearTimer(timer);
      return true;
    },
  };
}

module.exports = { scheduleStartupRefresh };
