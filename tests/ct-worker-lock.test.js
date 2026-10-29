'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { alive, acquireLock } = require('../server/ct-launch-worker');

test('a stale CT PID reused by an unrelated live Node process cannot block recovery on Linux', { skip: process.platform !== 'linux' }, () => {
  assert.equal(alive(process.pid), false);
});
test('preserves a verified live tailer and recovers a stale identity without signalling it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tailer.lock');
  fs.writeFileSync(file, '123');
  assert.equal(acquireLock(file, () => true), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '123');
  assert.equal(acquireLock(file, () => false), true);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
});
test('Linux liveness distinguishes a recycled PID from the real tailer', () => {
  const options = { platform: 'linux', kill() {}, readFile: () => '/usr/bin/node\0/app/server/tlds-worker.js\0' };
  assert.equal(alive(28, options), false);
  assert.equal(alive(28, { ...options, readFile: () => '/usr/bin/node\0/app/server/ct-launch-worker.js\0' }), true);
  assert.equal(alive(28, { ...options, readFile() { throw Object.assign(new Error(), { code: 'EACCES' }); } }), true);
});
