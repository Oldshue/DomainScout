'use strict';

const fs = require('fs');

// Build a launch command for best-effort background maintenance. Interactive
// requests must retain CPU and disk priority while rebuilds continue making
// progress. The contract is process-neutral: callers supply any executable and
// arguments, and unsupported platforms fall back to the original command.
function buildMaintenanceLaunch(executable, args = [], options = {}) {
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const niceness = String(options.niceness ?? 20);
  let command = executable;
  let launchArgs = [...args];

  if (platform !== 'win32' && existsSync('/usr/bin/nice')) {
    command = '/usr/bin/nice';
    launchArgs = ['-n', niceness, executable, ...launchArgs];
  }

  if (platform === 'darwin' && existsSync('/usr/sbin/taskpolicy')) {
    launchArgs = ['-b', '-d', 'throttle', '-c', 'maintenance', command, ...launchArgs];
    command = '/usr/sbin/taskpolicy';
  }

  return { command, args: launchArgs };
}

module.exports = { buildMaintenanceLaunch };
