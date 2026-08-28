'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMaintenanceLaunch } = require('../server/maintenance-process');

test('macOS maintenance work receives background I/O and lowest CPU priority', () => {
  const launch = buildMaintenanceLaunch('/runtime/node', ['/jobs/rebuild.js'], {
    platform: 'darwin',
    existsSync: candidate => candidate === '/usr/bin/nice' || candidate === '/usr/sbin/taskpolicy',
  });
  assert.deepEqual(launch, {
    command: '/usr/sbin/taskpolicy',
    args: ['-b', '-d', 'throttle', '-c', 'maintenance', '/usr/bin/nice', '-n', '20', '/runtime/node', '/jobs/rebuild.js'],
  });
});

test('an unrelated Linux media index uses the same generic priority contract', () => {
  const launch = buildMaintenanceLaunch('/usr/bin/media-indexer', ['--refresh'], {
    platform: 'linux',
    existsSync: candidate => candidate === '/usr/bin/nice',
  });
  assert.deepEqual(launch, {
    command: '/usr/bin/nice',
    args: ['-n', '20', '/usr/bin/media-indexer', '--refresh'],
  });
});

test('unsupported systems preserve the original executable and arguments', () => {
  assert.deepEqual(buildMaintenanceLaunch('worker.exe', ['--sync'], {
    platform: 'win32',
    existsSync: () => false,
  }), { command: 'worker.exe', args: ['--sync'] });
});
