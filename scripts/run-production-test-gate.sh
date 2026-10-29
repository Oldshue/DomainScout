#!/usr/bin/env bash
# Run the immutable release gate with ordinary foreground scheduling.
#
# A production updater may itself have been launched by an older
# ProcessType=Background LaunchAgent.  macOS propagates that Darwin-background
# and low-I/O policy to npm, Node, worker threads, and the event-loop monitor.
# Under ordinary laptop contention the whole test process can then be left
# unscheduled for seconds at a time, which is neither an event-loop block nor a
# meaningful responsiveness measurement.  The staged commit owns this wrapper,
# so it also provides the one-time bootstrap that lets an older updater install
# the corrected Standard launch definition.
set -euo pipefail

if [ "$(uname -s)" = "Darwin" ] && [ -x /usr/sbin/taskpolicy ]; then
  /usr/sbin/taskpolicy -B -p $$
  exec /usr/sbin/taskpolicy -a -d default -g default npm run test:production --silent
fi

exec npm run test:production --silent
