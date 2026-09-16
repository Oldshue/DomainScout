"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { EventEmitter } = require("node:events");
const {
  createUniverseSupervisor,
} = require("../server/universe-pull-supervisor");
// The production watchdog is deliberately unreferenced. Keep a bounded test
// waiter referenced until its asynchronous health write and lease release finish.
function waitForRelease(f) {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      f.events.removeListener("released", done);
      reject(new Error("supervisor did not release its lease"));
    }, 5000);
    f.events.once("released", done);
  });
}
function fixture(t, timeout = "3600000") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zone-supervisor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let active = null;
  const events = new EventEmitter();
  const children = [],
    killed = [];
  const leases = {
    inspect: () => active,
    reserve: () =>
      (active = { token: "fixture", filePath: path.join(root, "lease") }),
    activate: (lane, token, pid) => {
      active.pid = pid;
    },
    release: () => { active = null; events.emit("released"); },
  };
  const s = createUniverseSupervisor({
    dataDir: root,
    universeDir: path.join(root, "work"),
    leaseManager: leases,
    killImpl: (...args) => {
      killed.push(args);
      children.at(-1).emit("exit", null, "SIGKILL");
    },
    env: { DOMAINSCOUT_UNIVERSE_RUN_TIMEOUT_MS: timeout },
    now: () => new Date("2026-09-16T03:00:00Z"),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 12345;
      children.push(child);
      return child;
    },
  });
  return { s, children, killed, root, events };
}
test("supervisor starts before morning, does not overlap, and restarts after a failed child", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  assert.equal((await f.s.runDay()).day, "2026-09-15");
  assert.deepEqual(await f.s.runDay(), { skipped: "running" });
  const failed = waitForRelease(f);
  f.children[0].emit("exit", 1);
  await failed;
  assert.equal((await f.s.health()).status, "failed");
  assert.equal((await f.s.retryIncomplete()).started, true);
  const finished = waitForRelease(f);
  f.children[1].emit("exit", 0);
  await finished;
});
test("watchdog terminates the whole stalled process tree and makes the lane retryable", { timeout: 5000 }, async (t) => {
  const f = fixture(t, "20");
  const finished = waitForRelease(f);
  await f.s.runDay();
  await finished;
  assert.deepEqual(f.killed, [[-12345, "SIGKILL"]]);
  assert.equal((await f.s.health()).retryable, true);
});
