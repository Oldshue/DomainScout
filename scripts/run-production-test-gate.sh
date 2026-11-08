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

# Every test's mkdtemp lands under one private root that is removed when the
# gate ends, pass or fail. Tests that time out, crash, or orphan children used
# to leave their temp databases behind (hundreds of MB each); a release-channel
# updater running this gate on every release filled a worker disk in a day.
GATE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/domainscout-test-gate.XXXXXX")"
cleanup() { rm -rf "$GATE_TMP"; }
trap cleanup EXIT
export TMPDIR="$GATE_TMP"

if [ "$(uname -s)" = "Darwin" ] && [ -x /usr/sbin/taskpolicy ]; then
  # Best effort: EPERM here must not abort the gate (restricted sessions).
  /usr/sbin/taskpolicy -B -p $$ 2>/dev/null || echo "[test-gate] taskpolicy -B not permitted; continuing with the current scheduling policy" >&2
  /usr/sbin/taskpolicy -a -d default -g default npm run test:production --silent
else
  npm run test:production --silent
fi
