'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CORE_FAST_LANE_EXTENSIONS,
  DEFAULT_FAST_LANE_TIMEOUT_MS,
  assembleFastLane,
} = require('../server/tlds-fast-lane');

test('CORE_FAST_LANE_EXTENSIONS matches the documented core set', () => {
  assert.deepEqual(CORE_FAST_LANE_EXTENSIONS, ['.com', '.net', '.org', '.io', '.ai', '.co', '.app', '.dev', '.xyz', '.me']);
});

test('the default fast-lane timeout constant is 8 seconds', () => {
  assert.equal(DEFAULT_FAST_LANE_TIMEOUT_MS, 8000);
});

test('assembleFastLane buckets taken/free extensions from an injected resolver — no network', async () => {
  const resolver = async (domain, ext) => {
    if (ext === '.com' || ext === '.io') return 'taken';
    if (ext === '.net' || ext === '.org') return 'not_taken';
    return 'unknown'; // the rest never resolve to a definite answer
  };
  const result = await assembleFastLane({ baseName: 'botfuel', resolver, timeoutMs: 200 });
  assert.deepEqual(result.taken, ['.com', '.io']);
  assert.deepEqual(result.free, ['.net', '.org']);
  assert.ok(result.checked.includes('.com') && result.checked.includes('.net'));
  // 'unknown' status extensions never join checked/taken/free — they are
  // reported as timedOut even though the resolver technically answered,
  // because 'unknown' carries no proof either way (same fail-closed rule as
  // the worker's resolveNsLimited).
  for (const ext of ['.app', '.dev', '.xyz', '.me', '.co']) {
    assert.ok(result.timedOut.includes(ext), `${ext} should be reported as timedOut/unresolved`);
  }
});

test('assembleFastLane honors an explicit extensions list instead of the core default', async () => {
  const seen = [];
  const resolver = async (domain, ext) => { seen.push(ext); return 'taken'; };
  const result = await assembleFastLane({
    baseName: 'agentforge', extensions: ['.com', '.dev'], resolver, timeoutMs: 200,
  });
  assert.deepEqual(seen.sort(), ['.com', '.dev']);
  assert.deepEqual(result.taken, ['.com', '.dev']);
});

test('assembleFastLane never throws on a resolver rejection — the extension is reported as timedOut', async () => {
  const resolver = async (domain, ext) => {
    if (ext === '.com') throw new Error('boom');
    return 'taken';
  };
  const result = await assembleFastLane({ baseName: 'botfuel', resolver, timeoutMs: 200 });
  assert.ok(!result.taken.includes('.com'));
  assert.ok(result.timedOut.includes('.com'));
});

test('assembleFastLane is bounded by its timer, not the resolver, even when the resolver never resolves (proves the 8s-style bound)', async () => {
  const resolver = () => new Promise(() => {}); // never resolves
  const start = Date.now();
  const result = await assembleFastLane({ baseName: 'neverresolves', resolver, timeoutMs: 250 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `assembleFastLane should return promptly once its timer fires, took ${elapsed}ms`);
  assert.ok(elapsed >= 200, `assembleFastLane should not resolve before its timer fires, took ${elapsed}ms`);
  assert.equal(result.taken.length, 0);
  assert.equal(result.free.length, 0);
  assert.equal(result.checked.length, 0);
  assert.deepEqual(result.timedOut.sort(), [...CORE_FAST_LANE_EXTENSIONS].sort());
});

test('an unrelated prefix fixture behaves identically — the assembler is keyword-neutral', async () => {
  const resolver = async (domain, ext) => (ext === '.io' ? 'taken' : 'not_taken');
  const result = await assembleFastLane({ baseName: 'zzqvortex', resolver, timeoutMs: 200 });
  assert.deepEqual(result.taken, ['.io']);
  assert.equal(result.free.length, CORE_FAST_LANE_EXTENSIONS.length - 1);
});
