"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { plan } = require("../scripts/universe-capture-lane");

test("capture lane runs only inside its window and once per published day", () => {
  const at = (iso, state) => plan({ now: new Date(iso), windowMinutes: 170, state });
  assert.deepEqual(at("2026-09-16T07:02:00Z"), { day: "2026-09-16", run: false, reason: "before-window" });
  assert.equal(at("2026-09-16T07:05:00Z").run, true);
  assert.equal(at("2026-09-16T07:05:00Z").closes, Date.parse("2026-09-16T09:50:00Z"));
  assert.equal(at("2026-09-16T09:29:00Z").run, true);
  assert.equal(at("2026-09-16T09:30:00Z").reason, "window-closed");
  assert.equal(at("2026-09-17T03:00:00Z").reason, "window-closed");
  assert.equal(at("2026-09-16T08:00:00Z", { day: "2026-09-16", complete: true }).reason, "published");
  assert.equal(at("2026-09-16T08:00:00Z", { day: "2026-09-15", complete: true }).run, true);
  assert.equal(at("2026-09-16T08:00:00Z", { day: "2026-09-16", complete: false }).run, true);
});

test("a dropped connection is survivable, any other uncaught error is not", () => {
  const { isStraySocketError } = require("../scripts/universe-capture-lane");
  assert.equal(isStraySocketError(Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" })), true);
  assert.equal(isStraySocketError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" })), true);
  assert.equal(isStraySocketError(Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })), true);
  assert.equal(isStraySocketError(Object.assign(new Error("no space left"), { code: "ENOSPC", syscall: "write" })), false);
  assert.equal(isStraySocketError(new TypeError("x is not a function")), false);
  assert.equal(isStraySocketError(null), false);
});

test("a busy Sale Watch database never fails a published capture", async () => {
  const { ingestPublishedMovement } = require("../server/universe-pull-worker");
  const quiet = { error() {} }, sleep = async () => {};
  let calls = 0;
  const busy = () => { calls += 1; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); };
  assert.deepEqual(await ingestPublishedMovement({ ingest: busy, attempts: 3, log: quiet, sleep }), { ingested: false, attempts: 3 });
  assert.equal(calls, 3);
  calls = 0;
  const once = async () => { calls += 1; if (calls === 1) throw new Error("database is locked"); };
  assert.deepEqual(await ingestPublishedMovement({ ingest: once, log: quiet, sleep }), { ingested: true, attempts: 2 });
  await assert.rejects(ingestPublishedMovement({ ingest: async () => { throw new Error("no such table: x"); }, log: quiet, sleep }), /no such table/);
});
