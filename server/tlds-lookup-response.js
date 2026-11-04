'use strict';

function forcedRefreshPending(result, startedAt, now = Date.now()) {
  return {
    ...result,
    status: 'pending',
    count: null,
    taken: [],
    previousReceipt: result.coverage || null,
    all: result.tldUniverse.tlds,
    allCount: result.tldUniverse.count,
    message: 'Fresh full-root coverage is queued; the previous receipt is not returned as current evidence.',
    retryAfterMs: 2000,
    durationMs: Math.max(0, now - startedAt),
  };
}

module.exports = { forcedRefreshPending };
